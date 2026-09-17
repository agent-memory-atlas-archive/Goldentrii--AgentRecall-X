/**
 * transcript-project.ts — Claude Code transcript text/project helpers shared
 * between the CLI's transcript-reader.ts (session-card summarization) and
 * core's transcript-audit.ts (evolution p1a, injection-outcome adjudication).
 *
 * MOVED HERE (not duplicated) from packages/cli/src/utils/transcript-reader.ts
 * on 2026-09-17: transcript-audit.ts lives in packages/core (agent-recall-core
 * has no dependency on agent-recall-cli — cli depends on core, never the
 * reverse), so it cannot import resolveSessionProject() from the cli package.
 * This module is the shared home; packages/cli/src/utils/transcript-reader.ts
 * now re-exports resolveSessionProject from "agent-recall-core" instead of
 * defining its own copy, so there is exactly ONE implementation.
 *
 * F1 — unified, claim-not-generate project namer
 * ---------------------------------------------------------------------------
 * The old namer (transcript-reader.ts's still-local `extractProjectSlug`) has
 * no threshold and no boilerplate exclusion: a frequency count over the RAW
 * head/tail text is trivially dominated by hook-injected startup content
 * (folder-lint file lists, the MEMORY.md index dump injected as a
 * system-reminder, etc.) that mentions `/Users/<user>/Projects/<name>` paths
 * having nothing to do with the actual conversation. Confirmed empirically
 * against the 2026-07-31 continuity incident: it misdirected forensics onto
 * two unrelated sessions purely via this boilerplate (see
 * reports/2026-07-31-continuity-fixture.md).
 *
 * resolveSessionProject() replaces frequency-only voting with three signals,
 * combined under a claim-not-generate policy: prefer routing to a project
 * that ALREADY EXISTS in the store; only allow minting a brand-new slug when
 * strongly corroborated by both content AND an on-disk `~/Projects/<name>`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isValidProjectSlug } from "../storage/project.js";
import { projectsRootDir } from "../storage/paths.js";

// ---------------------------------------------------------------------------
// Message extraction (also used by transcript-audit.ts's own full-file scan)
// ---------------------------------------------------------------------------

export const SYSTEM_PREFIXES = [
  /^dangerously-skip/i,
  /^<local-command/,
  /^<command-name/,
  /^<command-message/,
  /^<command-args/,
  /^<system-reminder/,
  /^<user-prompt-submit/,
];

export function isSystemText(text: string): boolean {
  const t = text.trimStart();
  return SYSTEM_PREFIXES.some((re) => re.test(t));
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (
        c &&
        typeof c === "object" &&
        (c as Record<string, unknown>).type === "text"
      ) {
        return String((c as Record<string, unknown>).text ?? "");
      }
    }
  }
  return "";
}

/** Records whose text is hook stdout/boilerplate, never real conversation content. */
export function isBoilerplateRecord(rec: Record<string, unknown>): boolean {
  return rec.type === "attachment";
}

// ---------------------------------------------------------------------------
// Project identification (F1)
// ---------------------------------------------------------------------------

/** Parse JSON lines, silently skipping malformed lines (common at head/tail boundaries). */
function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip */
    }
  }
  return out;
}

/** A candidate project slug with its combined signal count. */
export interface ProjectCandidate {
  slug: string;
  count: number;
}

export interface ResolvedSessionProject {
  /** The resolved slug, an existing/gated new slug, or "auto" when nothing qualifies. */
  slug: string;
  /** top_count / total_candidate_counts across all signals; 0 when slug === "auto". */
  confidence: number;
  /** Every candidate seen, merged across signals, ranked by count desc — kept
   *  even when not selected, so a low-confidence resolution is re-fileable
   *  later (recorded verbatim in the session card, F3). */
  candidates: ProjectCandidate[];
}

function bumpCount(counts: Map<string, number>, slug: string, by = 1): void {
  counts.set(slug, (counts.get(slug) ?? 0) + by);
}

/** Signal 1: cwd field frequency, restricted to paths under ~/Projects/<name>. */
const CWD_PROJECT_RE = /^\/Users\/[^/]+\/(?:[Pp]rojects?)\/([^/]+)/;

function cwdSignal(lines: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of lines) {
    if (!d || typeof d !== "object") continue;
    const cwd = (d as Record<string, unknown>).cwd;
    if (typeof cwd !== "string") continue;
    const m = CWD_PROJECT_RE.exec(cwd);
    if (!m) continue;
    bumpCount(counts, m[1].replace(/[`'".,;)>]+$/, ""));
  }
  return counts;
}

/**
 * Signal 2: content scan restricted to real user/assistant message text —
 * hook `attachment` records (boilerplate) and system-reminder-prefixed text
 * are excluded before the regex ever sees them.
 */
const PROJECT_RE = /\/Users\/[^/]+\/(?:[Pp]rojects?)\/([^/",\\\s`]+)/g;

function contentSignal(lines: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of lines) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    if (isBoilerplateRecord(rec)) continue;
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const text = textFromContent(msg?.content);
    if (!text || isSystemText(text)) continue;

    PROJECT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROJECT_RE.exec(text)) !== null) {
      bumpCount(counts, m[1].replace(/[`'".,;)>]+$/, ""));
    }
  }
  return counts;
}

/**
 * Slugs that already have a project directory under AR_ROOT/projects.
 * Routed through projectsRootDir() (F2 guard, projects-literal-bypass-guard.test.mjs)
 * rather than a raw path.join(getRoot(), "projects") literal — this file lives
 * in packages/core/src, where that guard scans every source file.
 */
function listExistingProjectSlugs(): Set<string> {
  try {
    const projectsDir = projectsRootDir();
    if (!fs.existsSync(projectsDir)) return new Set();
    return new Set(
      fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

/**
 * Unified, claim-not-generate project namer (F1).
 *
 * Merges the cwd signal (Signal 1) and the boilerplate-excluded content scan
 * (Signal 2), then resolves under a claim-not-generate policy (Signal 3):
 *   - Scan merged candidates in rank order; the first one that already has an
 *     on-disk project directory wins outright ("prefer an existing slug").
 *   - Otherwise, the single top-ranked candidate may mint a BRAND-NEW slug
 *     only if it clears both bars: content-signal count >= 3 (a real project
 *     is mentioned in actual dialogue repeatedly, not once via noise) AND a
 *     matching `~/Projects/<name>` directory exists on disk.
 *   - Otherwise: "auto" (confidence 0) — never invent a slug from a single
 *     weak hit.
 * Every candidate slug is validated against `isValidProjectSlug` before it
 * can be selected (no deny-list bypass) — invalid candidates are skipped,
 * never selected, though they remain visible in `candidates` for transparency.
 */
export function resolveSessionProject(headText: string, tailText: string): ResolvedSessionProject {
  const lines = [...parseLines(headText), ...parseLines(tailText)];

  const cwdCounts = cwdSignal(lines);
  const contentCounts = contentSignal(lines);

  const merged = new Map<string, number>();
  for (const [slug, c] of cwdCounts) bumpCount(merged, slug, c);
  for (const [slug, c] of contentCounts) bumpCount(merged, slug, c);

  const ranked: ProjectCandidate[] = [...merged.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count);

  const totalCount = ranked.reduce((sum, c) => sum + c.count, 0);
  const confidenceOf = (count: number): number => (totalCount > 0 ? count / totalCount : 0);

  const existingSlugs = listExistingProjectSlugs();

  // Prefer an existing (already-on-disk) slug — scan the FULL ranked list,
  // not just the top candidate, so a strong-but-second-place existing match
  // still wins over a noisier top candidate that has no home on disk.
  for (const cand of ranked) {
    if (!isValidProjectSlug(cand.slug)) continue;
    if (existingSlugs.has(cand.slug)) {
      return { slug: cand.slug, confidence: confidenceOf(cand.count), candidates: ranked };
    }
  }

  // No existing match anywhere in the ranking — the top candidate may mint a
  // brand-new slug, but only when strongly corroborated (never generate from
  // a single boilerplate-adjacent hit).
  const top = ranked.find((c) => isValidProjectSlug(c.slug));
  if (top) {
    const contentOnlyCount = contentCounts.get(top.slug) ?? 0;
    const projectsHomeDir = path.join(os.homedir(), "Projects", top.slug);
    if (contentOnlyCount >= 3 && fs.existsSync(projectsHomeDir)) {
      return { slug: top.slug, confidence: confidenceOf(top.count), candidates: ranked };
    }
  }

  return { slug: "auto", confidence: 0, candidates: ranked };
}
