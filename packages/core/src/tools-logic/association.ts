/**
 * association.ts — evolution p2 (Phase 2): `ar assoc rebuild` / `ar assoc stats`.
 *
 * Builds the S_ji associative-strength matrix the Phase-3 activation model
 * (A_i = B_i + Σ W_j·S_ji) will read. Strictly downstream of Phase-1a's
 * `cited` events (transcript-audit.ts): this module NEVER re-walks
 * transcripts, NEVER adds instrumentation, and reads ONLY the per-project
 * `corrections/_outcomes.jsonl` ledgers already on disk. Zero read-path
 * changes — nothing in recall/session_start/session_end consumes edges.json
 * yet (that wiring is a later phase's job).
 *
 * ---------------------------------------------------------------------------
 * Co-activation grouping (brief step 1b/1c)
 * ---------------------------------------------------------------------------
 * Only `kind: "cited"` events count as co-activation evidence — "ignored"
 * events are evidence of ABSENCE, never of two corrections surfacing
 * together, so they are read (to keep the file-read honest and to allow a
 * future producer's shape changes to be visible) but never folded into a
 * group.
 *
 * Every group is grouped BY THREE FALLBACK TIERS, strongest first:
 *   1. `session_id` (present on the event)                — granularity "session_id"
 *   2. transcript basename parsed out of the evidence string
 *      ("transcript-audit:<basename>:<verdict>...")        — granularity "transcript_basename"
 *   3. (project, day)                                      — granularity "project_day"
 * Tier 2 only fires when the parsed tag is a SINGLE basename — a "+"-joined
 * multi-transcript tag (the shape `transcript-audit.ts` emits for
 * "ignored", never for "cited") is not a session identity, so it falls
 * through to tier 3 rather than risk merging unrelated sessions.
 *
 * CHALLENGE resolution (brief's own CHALLENGE clause, decided — not an open
 * question): every group key is ALWAYS project-scoped
 * (`sess:<project>::<sid>`, `tx:<project>::<basename>`, `day:<project>::<day>`)
 * even under the `session_id` tier. A session_id that happens to appear in
 * two different projects' ledgers (a session that genuinely touched two
 * projects) therefore produces TWO SEPARATE groups, one per project — the
 * conservative "isolate by project" reading. Corrections in different
 * projects can never share an edge in this graph. Document this prominently
 * wherever the schema is described; it is a deliberate scope decision, not
 * an oversight.
 *
 * If a whole rebuild run has zero session_id AND zero parseable transcript
 * basenames available (every group falls back to the coarsest project_day
 * granularity), `groups.by_granularity.project_day` will be the only
 * non-zero granularity count — the CLI's rebuild renderer flags this
 * prominently (⚠) exactly as the brief's CHALLENGE clause asks.
 *
 * ---------------------------------------------------------------------------
 * Determinism (constraint 2)
 * ---------------------------------------------------------------------------
 * No wall-clock read anywhere in this file. Project directories are read in
 * sorted order, ledger lines are processed in on-disk order, `Map`/`Set`
 * iteration order is therefore fully determined by ledger content — two
 * rebuilds over the same ledger produce byte-identical `edges.json` output
 * (fixed key order via the `AssocEdgesFile` object literal below + a
 * deterministic edge sort).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { isValidProjectSlug } from "../storage/project.js";
import { dayOf } from "../storage/heed-tiers.js";
// F2 guard (projects-literal-bypass-guard.test.mjs): the "projects" directory
// segment literal is only allowed to live in storage/paths.ts — every other
// call site routes through its exported PROJECTS_DIRNAME constant. This
// module deliberately does NOT use paths.ts's projectSubPath()/
// projectsRootDir() themselves (both are hardwired to the process-global
// getRoot(), which this module must NOT mutate just to honor a --store
// override) — but it still owes the literal-string discipline, so it joins
// against the constant directly.
import { PROJECTS_DIRNAME } from "../storage/paths.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AssocGranularity = "session_id" | "transcript_basename" | "project_day";

export interface AssocEdge {
  a: string;
  b: string;
  weight: number;
  /** Day (YYYY-MM-DD) of the earliest co-activation group that produced this edge. */
  first_seen: string;
  /** Day (YYYY-MM-DD) of the latest co-activation group that produced this edge. */
  last_seen: string;
}

export interface AssocEdgesFile {
  schema: "assoc-edges/v1";
  /** Count of valid `cited` events folded into the graph (malformed lines excluded). */
  built_from_events: number;
  groups: {
    /** Total distinct co-activation groups across every granularity tier. */
    total: number;
    by_granularity: Record<AssocGranularity, number>;
  };
  /** Distinct `corr:<project>/<correction_id>` node ids observed in any group. */
  nodes: number;
  /** Sorted (weight desc, then `a|b` key asc) — see sortAssocEdges. */
  edges: AssocEdge[];
}

export interface AssocMalformedRow {
  project: string;
  /** 1-based line number, or -1 for a "parsed OK but semantically invalid" row (e.g. unparseable `at`). */
  line: number;
  error: string;
}

export interface AssocRebuildOptions {
  /** Storage root override. Defaults to core's getRoot() (AGENT_RECALL_ROOT / setRoot() / ~/.agent-recall). */
  storeRoot?: string;
  /** edges.json destination override. Defaults to `<storeRoot>/association/edges.json`. */
  outPath?: string;
  /** Compute and report without writing anything. */
  dryRun?: boolean;
}

export interface AssocRebuildResult {
  dry_run: boolean;
  store_root: string;
  out_path: string;
  written: boolean;
  projects_scanned: number;
  malformed_rows: AssocMalformedRow[];
  file: AssocEdgesFile;
}

// ---------------------------------------------------------------------------
// Path helpers (explicit storeRoot — never implicitly coupled to getRoot()
// so a --store override never has to mutate process-global root state)
// ---------------------------------------------------------------------------

export function associationDirFor(storeRoot: string): string {
  return path.join(storeRoot, "association");
}

export function defaultEdgesPathFor(storeRoot: string): string {
  return path.join(associationDirFor(storeRoot), "edges.json");
}

function projectsDirFor(storeRoot: string): string {
  return path.join(storeRoot, PROJECTS_DIRNAME);
}

function outcomesFileFor(storeRoot: string, project: string): string {
  return path.join(projectsDirFor(storeRoot), project, "corrections", "_outcomes.jsonl");
}

function correctionFileFor(storeRoot: string, project: string, correctionId: string): string {
  return path.join(projectsDirFor(storeRoot), project, "corrections", `${correctionId}.json`);
}

// ---------------------------------------------------------------------------
// Node id / edge key (exported — Phase 3 and tests both need the exact grammar)
// ---------------------------------------------------------------------------

export function assocNodeId(project: string, correctionId: string): string {
  return `corr:${project}/${correctionId}`;
}

/** Parses a node id back into {project, correctionId}; null if not our grammar. */
export function parseAssocNodeId(id: string): { project: string; correctionId: string } | null {
  const m = /^corr:([^/]+)\/(.+)$/.exec(id);
  if (!m) return null;
  return { project: m[1], correctionId: m[2] };
}

/** Undirected edge key: the two node ids, lexicographically sorted, joined with "|". */
export function assocEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ---------------------------------------------------------------------------
// Ledger parsing — mirrors corrections.ts's parseOutcomesLedger idiom
// (read whole file, split lines, quarantine malformed rows, never throw).
// ---------------------------------------------------------------------------

interface CitedEventRaw {
  correction_id: string;
  at: string;
  evidence?: string;
  session_id?: string;
}

function readCitedEvents(
  storeRoot: string,
  project: string,
): { events: CitedEventRaw[]; malformed: Array<{ line: number; error: string }> } {
  const events: CitedEventRaw[] = [];
  const malformed: Array<{ line: number; error: string }> = [];
  const file = outcomesFileFor(storeRoot, project);
  if (!fs.existsSync(file)) return { events, malformed };

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    malformed.push({ line: 0, error: `failed to read ledger: ${err instanceof Error ? err.message : String(err)}` });
    return { events, malformed };
  }

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed) continue; // blank line — not malformed, just skip

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      malformed.push({ line: lineNo, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      malformed.push({ line: lineNo, error: "parsed line is not an object" });
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (rec.kind !== "cited") continue; // not our concern — not malformed, just irrelevant

    if (typeof rec.correction_id !== "string" || !rec.correction_id || typeof rec.at !== "string" || !rec.at) {
      malformed.push({ line: lineNo, error: "cited event missing required field(s): correction_id, at" });
      continue;
    }
    events.push({
      correction_id: rec.correction_id,
      at: rec.at,
      evidence: typeof rec.evidence === "string" ? rec.evidence : undefined,
      session_id: typeof rec.session_id === "string" && rec.session_id ? rec.session_id : undefined,
    });
  }
  return { events, malformed };
}

/**
 * Extract a SINGLE transcript basename from a `transcript-audit:<tag>:<verdict>...`
 * evidence string. Returns null when the evidence doesn't match the shape, or
 * when the tag is "+"-joined (multi-transcript — not a single session
 * identity; transcript-audit.ts only ever emits this shape for "ignored",
 * never for "cited", but this module treats it defensively rather than
 * assuming that invariant holds forever).
 */
export function parseTranscriptBasenameFromEvidence(evidence: string | undefined): string | null {
  if (!evidence) return null;
  const m = /^transcript-audit:([^:]+):(\S+)/.exec(evidence);
  if (!m) return null;
  const tag = m[1];
  if (!tag || tag.includes("+")) return null;
  return tag;
}

// ---------------------------------------------------------------------------
// Grouping + graph build (pure — no fs writes)
// ---------------------------------------------------------------------------

interface CoActivationGroup {
  granularity: AssocGranularity;
  correctionIds: Set<string>;
  days: Set<string>;
}

export interface AssocGraphBuild {
  file: AssocEdgesFile;
  malformedRows: AssocMalformedRow[];
  projectsScanned: number;
}

function listProjectDirs(storeRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDirFor(storeRoot), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => isValidProjectSlug(name))
    .sort();
}

/**
 * Pure graph derivation from every project's `_outcomes.jsonl` under
 * `storeRoot`. No filesystem writes — `runAssocRebuild` below is the only
 * writer, and only when not in --dry-run.
 */
export function buildAssociationGraph(storeRoot: string): AssocGraphBuild {
  const projects = listProjectDirs(storeRoot);
  const groups = new Map<string, CoActivationGroup>();
  const malformedRows: AssocMalformedRow[] = [];
  let builtFromEvents = 0;

  for (const project of projects) {
    const { events, malformed } = readCitedEvents(storeRoot, project);
    for (const m of malformed) malformedRows.push({ project, ...m });

    for (const evt of events) {
      const day = dayOf(evt.at);
      if (!day) {
        malformedRows.push({ project, line: -1, error: `cited event has an unparseable 'at' timestamp: ${JSON.stringify(evt.at)}` });
        continue;
      }
      builtFromEvents++;

      let granularity: AssocGranularity;
      let key: string;
      if (evt.session_id) {
        granularity = "session_id";
        key = `sess:${project}::${evt.session_id}`;
      } else {
        const basename = parseTranscriptBasenameFromEvidence(evt.evidence);
        if (basename) {
          granularity = "transcript_basename";
          key = `tx:${project}::${basename}`;
        } else {
          granularity = "project_day";
          key = `day:${project}::${day}`;
        }
      }

      let group = groups.get(key);
      if (!group) {
        group = { granularity, correctionIds: new Set(), days: new Set() };
        groups.set(key, group);
      }
      group.correctionIds.add(assocNodeId(project, evt.correction_id));
      group.days.add(day);
    }
  }

  const byGranularity: Record<AssocGranularity, number> = {
    session_id: 0,
    transcript_basename: 0,
    project_day: 0,
  };
  const nodeSet = new Set<string>();
  const edgeMap = new Map<string, AssocEdge>();

  for (const group of groups.values()) {
    byGranularity[group.granularity]++;
    for (const id of group.correctionIds) nodeSet.add(id);

    const ids = [...group.correctionIds].sort();
    if (ids.length < 2) continue; // no pair, no edge — still a node observation above

    const days = [...group.days].sort(); // YYYY-MM-DD sorts correctly as a string
    const groupFirst = days[0];
    const groupLast = days[days.length - 1];

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        // ids is sorted ascending, so ids[i] < ids[j] already — no re-sort needed.
        const a = ids[i];
        const b = ids[j];
        const key = `${a}|${b}`;
        let edge = edgeMap.get(key);
        if (!edge) {
          edge = { a, b, weight: 0, first_seen: groupFirst, last_seen: groupLast };
          edgeMap.set(key, edge);
        }
        edge.weight += 1;
        if (groupFirst < edge.first_seen) edge.first_seen = groupFirst;
        if (groupLast > edge.last_seen) edge.last_seen = groupLast;
      }
    }
  }

  const edges = sortAssocEdges([...edgeMap.values()]);

  const file: AssocEdgesFile = {
    schema: "assoc-edges/v1",
    built_from_events: builtFromEvents,
    groups: {
      total: groups.size,
      by_granularity: byGranularity,
    },
    nodes: nodeSet.size,
    edges,
  };

  return { file, malformedRows, projectsScanned: projects.length };
}

/** Sort contract for edges.json: weight desc, then the "a|b" key asc. Exported so stats/tests share it. */
export function sortAssocEdges(edges: AssocEdge[]): AssocEdge[] {
  return [...edges].sort((x, y) => {
    if (y.weight !== x.weight) return y.weight - x.weight;
    const kx = `${x.a}|${x.b}`;
    const ky = `${y.a}|${y.b}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// `ar assoc rebuild`
// ---------------------------------------------------------------------------

export async function runAssocRebuild(options: AssocRebuildOptions = {}): Promise<AssocRebuildResult> {
  const storeRoot = options.storeRoot ?? getRoot();
  const outPath = options.outPath ?? defaultEdgesPathFor(storeRoot);
  const dryRun = !!options.dryRun;

  const { file, malformedRows, projectsScanned } = buildAssociationGraph(storeRoot);

  let written = false;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // Fixed key order (object literal above) + fixed 2-space indent + no
    // wall-clock content anywhere in `file` ⇒ byte-identical across reruns
    // over the same ledger.
    fs.writeFileSync(outPath, JSON.stringify(file, null, 2) + "\n", "utf-8");
    written = true;
  }

  return {
    dry_run: dryRun,
    store_root: storeRoot,
    out_path: outPath,
    written,
    projects_scanned: projectsScanned,
    malformed_rows: malformedRows,
    file,
  };
}

// ---------------------------------------------------------------------------
// `ar assoc stats`
// ---------------------------------------------------------------------------

export interface AssocDegreeDistribution {
  min: number;
  median: number;
  p90: number;
  max: number;
}

export interface AssocStatsTopEdge extends AssocEdge {
  label_a: string;
  label_b: string;
}

export interface AssocStatsResult {
  node_count: number;
  edge_count: number;
  /** weight (as string key) -> number of edges with that weight. */
  weight_histogram: Record<string, number>;
  degree_distribution: AssocDegreeDistribution;
  top_edges: AssocStatsTopEdge[];
  /** Exact "DEGENERATE: <reason>" string (Phase-2 exit-condition probe) or null when the graph is healthy. */
  degenerate: string | null;
}

export function emptyAssocEdgesFile(): AssocEdgesFile {
  return {
    schema: "assoc-edges/v1",
    built_from_events: 0,
    groups: { total: 0, by_granularity: { session_id: 0, transcript_basename: 0, project_day: 0 } },
    nodes: 0,
    edges: [],
  };
}

function isAssocEdgesFile(v: unknown): v is AssocEdgesFile {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return f.schema === "assoc-edges/v1" && Array.isArray(f.edges);
}

/**
 * Read + validate `edges.json`. Missing file or unparseable/wrong-shape
 * content degrades to the empty graph (never throws) — `ar assoc stats`
 * must be safe to run before the first `ar assoc rebuild`.
 */
export function readAssocEdgesFile(storeRoot: string, explicitPath?: string): AssocEdgesFile {
  const p = explicitPath ?? defaultEdgesPathFor(storeRoot);
  if (!fs.existsSync(p)) return emptyAssocEdgesFile();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isAssocEdgesFile(parsed)) return emptyAssocEdgesFile();
    return parsed;
  } catch {
    return emptyAssocEdgesFile();
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function computeDegreeDistribution(edges: AssocEdge[]): AssocDegreeDistribution {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  const degrees = [...degree.values()].sort((a, b) => a - b);
  if (degrees.length === 0) return { min: 0, median: 0, p90: 0, max: 0 };
  return {
    min: degrees[0],
    median: percentile(degrees, 0.5),
    p90: percentile(degrees, 0.9),
    max: degrees[degrees.length - 1],
  };
}

/**
 * The Phase-2 exit-condition probe. Exact wording is load-bearing (the
 * brief requires this rendered string to be tested byte-for-byte) — never
 * reword without updating every test that asserts on it.
 */
export function computeDegenerateReason(edges: AssocEdge[]): string | null {
  if (edges.length < 5) {
    return `fewer than 5 edges (${edges.length} found)`;
  }
  const uniqueWeights = new Set(edges.map((e) => e.weight));
  if (uniqueWeights.size <= 1) {
    return `all ${edges.length} edge weights are equal (weight=${edges[0].weight})`;
  }
  return null;
}

/** Pure stats computation over an already-loaded AssocEdgesFile (no fs). */
export function computeAssocStats(
  file: AssocEdgesFile,
  labelFor: (id: string) => string = (id) => id,
): AssocStatsResult {
  const edges = file.edges;
  const weightHistogram: Record<string, number> = {};
  for (const e of edges) {
    const k = String(e.weight);
    weightHistogram[k] = (weightHistogram[k] ?? 0) + 1;
  }
  const topEdges = sortAssocEdges(edges)
    .slice(0, 10)
    .map((e) => ({ ...e, label_a: labelFor(e.a), label_b: labelFor(e.b) }));

  return {
    node_count: file.nodes,
    edge_count: edges.length,
    weight_histogram: weightHistogram,
    degree_distribution: computeDegreeDistribution(edges),
    top_edges: topEdges,
    degenerate: computeDegenerateReason(edges),
  };
}

/**
 * Best-effort human label for a node id: `<id> (<rule text, truncated>)` when
 * the correction record is still on disk, else the bare node id. Read-only,
 * never throws, never required for correctness — purely a display nicety for
 * `ar assoc stats`. This is the ONE place this module reads something other
 * than `_outcomes.jsonl` (a correction's own `<id>.json`), which is fine:
 * the "reads ONLY _outcomes.jsonl" purity constraint governs the REBUILD
 * derivation (item 1), not stats' display step (item 2).
 */
export function labelForAssocNode(storeRoot: string, id: string): string {
  const parsed = parseAssocNodeId(id);
  if (!parsed) return id;
  try {
    const file = correctionFileFor(storeRoot, parsed.project, parsed.correctionId);
    if (!fs.existsSync(file)) return id;
    const rec = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    const rule = typeof rec.rule === "string" ? rec.rule : null;
    if (!rule) return id;
    const truncated = rule.length > 60 ? `${rule.slice(0, 57)}...` : rule;
    return `${id} (${truncated})`;
  } catch {
    return id;
  }
}

export interface AssocStatsOptions {
  storeRoot?: string;
  /** edges.json path override. Defaults to `<storeRoot>/association/edges.json`. */
  path?: string;
}

export interface AssocStatsRunResult extends AssocStatsResult {
  store_root: string;
  edges_path: string;
}

export async function runAssocStats(options: AssocStatsOptions = {}): Promise<AssocStatsRunResult> {
  const storeRoot = options.storeRoot ?? getRoot();
  const edgesPath = options.path ?? defaultEdgesPathFor(storeRoot);
  const file = readAssocEdgesFile(storeRoot, edgesPath);
  const stats = computeAssocStats(file, (id) => labelForAssocNode(storeRoot, id));
  return { ...stats, store_root: storeRoot, edges_path: edgesPath };
}
