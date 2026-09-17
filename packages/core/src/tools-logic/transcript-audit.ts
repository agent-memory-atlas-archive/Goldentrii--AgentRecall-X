/**
 * transcript-audit.ts — evolution p1a (Phase 1a): `ar outcomes audit`.
 *
 * The heed channel is starved because check_action is dormant (the C3 online
 * "triggered" emission is a documented dormant channel — see corrections.ts's
 * doc comments). This instrument produces injection-outcome events by reading
 * the Claude Code session TRANSCRIPT for the day a correction was injected —
 * never the agent's own end-of-session summary. Adjudication independence is
 * the design law: the measured agent's own summary is NEVER evidence.
 *
 * Pipeline, per audit day D:
 *   1. Per project: read corrections/_outcomes.jsonl for `retrieved` events
 *      whose `at` falls on day D (local-TZ, matching the rest of the ledger's
 *      day-bucketing convention) — the set of corrections INJECTED that day.
 *   2. Scan the Claude Code transcript directory ONCE for the whole run;
 *      bucket every transcript's lines by day using each line's own
 *      `timestamp` field (falling back to the FILE's mtime day only when a
 *      transcript has NO per-line timestamps at all — never guessed
 *      per-line). A file that cannot be bounded either way is never silently
 *      attributed to any day — it is reported as ambiguous instead.
 *   3. Map each transcript to a project via `resolveSessionProject` (the F1
 *      claim-not-generate namer) — never the old frequency-vote namer.
 *   4. Extract user+assistant text for that day's lines, applying the SAME
 *      SYSTEM_PREFIXES/attachment filters transcript-reader.ts applies.
 *   5. Adjudicate each injected correction against that day's matching
 *      project transcripts with a deterministic lexical ladder (strongest
 *      first): RECURRED > CITED > IGNORED.
 *   6. Write "cited"/"ignored" (ledger-only) or "recurred" (counter-mutating,
 *      reusing the existing kind) via recordOutcome, evidence-prefixed
 *      "transcript-audit:" and gated at the core level (see corrections.ts).
 *   7. Idempotent: a same-day re-run against the same transcript set writes
 *      zero new events.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getRoot } from "../types.js";
import { projectsRootDir, resolveProjectDirName } from "../storage/paths.js";
import { isValidProjectSlug } from "../storage/project.js";
import {
  readCorrections,
  readOutcomesOnDate,
  readOutcomeEventsByCorrection,
  recordOutcome,
  splitSentences,
  type CorrectionRecord,
  type CorrectionOutcome,
} from "../storage/corrections.js";
import { RECURRENCE_MARKER, EVAL_VOCAB_ANCHOR, ruleContentWords } from "./session-end.js";
import {
  resolveSessionProject,
  isSystemText,
  textFromContent,
  isBoilerplateRecord,
} from "../helpers/transcript-project.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscriptAuditOptions {
  /** Single audit day, YYYY-MM-DD. Mutually exclusive with since/until. */
  date?: string;
  /** Backfill range start (inclusive), YYYY-MM-DD. Requires --backfill semantics upstream. */
  since?: string;
  /** Backfill range end (inclusive), YYYY-MM-DD. Defaults to today (local-TZ) when since is set. */
  until?: string;
  /** Restrict to one project slug. Omit to scan every project under the store. */
  project?: string;
  /** Override the Claude Code transcript directory (default: same dir transcript-reader.ts uses). */
  claudeDir?: string;
  /** Adjudicate and report without writing any outcome events. */
  dryRun?: boolean;
}

export type TranscriptAuditVerdict = "recurred" | "cited" | "ignored";

export interface TranscriptAuditAdjudication {
  date: string;
  project: string;
  correction_id: string;
  rule: string;
  verdict: TranscriptAuditVerdict;
  matched_words: string[];
  /** Present only for a "recurred" verdict — the sentence that fired it. */
  sentence?: string;
  /** Transcript(s) this verdict's evidence is anchored to (idempotency key material). */
  transcript_basenames: string[];
  /** True iff an event was actually appended (false in --dry-run or on dedup-skip). */
  written: boolean;
  skipped_reason?: string;
}

export interface TranscriptAuditDaySummary {
  date: string;
  /** Project slugs that had ≥1 injected correction on this day. */
  projects: string[];
  injected: number;
  cited: number;
  ignored: number;
  recurred: number;
  dedup_skipped: number;
  transcripts_scanned: number;
  /** Transcript basenames whose day membership could not be bounded at all (never guessed). */
  transcripts_ambiguous: string[];
  /** Projects with ≥1 injected correction this day but zero matching transcripts. */
  projects_without_transcripts: string[];
  adjudications: TranscriptAuditAdjudication[];
}

export interface TranscriptAuditResult {
  dry_run: boolean;
  claude_dir: string;
  days: TranscriptAuditDaySummary[];
  /** Days in the range where transcripts_scanned === 0 across every project. */
  transcripts_not_found_days: string[];
}

// ---------------------------------------------------------------------------
// Day-range / default-dir helpers
// ---------------------------------------------------------------------------

/** Local-TZ day string ("sv" locale → YYYY-MM-DD), matching the ledger's day-bucketing convention. */
function localDay(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("sv");
}

/** Inclusive day range [since, until], calendar-date arithmetic in UTC (no DST skips). */
function enumerateDays(since: string, until: string): string[] {
  const start = new Date(`${since}T00:00:00.000Z`).getTime();
  const end = new Date(`${until}T00:00:00.000Z`).getTime();
  if (isNaN(start) || isNaN(end)) return [];
  const days: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Exported for reuse (evolution p1b) — the day-range resolver is identical
 * flag semantics (--date XOR --backfill --since/--until) for
 * `ar corrections harvest-implicit`; TranscriptAuditOptions' date/since/until/
 * project/claudeDir/dryRun shape is generic enough that implicit-harvest.ts's
 * own options type is structurally compatible without a cast.
 */
export function resolveDayRange(options: TranscriptAuditOptions): string[] {
  if (options.date) return [options.date];
  if (options.since) {
    const until = options.until ?? new Date().toLocaleDateString("sv");
    return enumerateDays(options.since, until);
  }
  throw new Error(
    "runTranscriptAudit: either --date <YYYY-MM-DD> or --backfill --since <YYYY-MM-DD> is required",
  );
}

/** Same default the CLI's readTodaySessions() (transcript-reader.ts) uses. */
export function defaultClaudeDir(): string {
  const username = os.userInfo().username;
  return path.join(os.homedir(), ".claude", "projects", `-Users-${username}`);
}

// ---------------------------------------------------------------------------
// Transcript scanning (once per run — day-bucketed, project-resolved, cached)
// ---------------------------------------------------------------------------

/**
 * Exported for reuse (evolution p1b, `ar corrections harvest-implicit`) —
 * this is the SAME day-bucketed/project-resolved scan p1a built; p1b must
 * not fork a second transcript walker. See implicit-harvest.ts.
 */
export interface ScannedTranscript {
  basename: string;
  /** Lines (parsed JSON records), bucketed by their own local-TZ day. */
  byDay: Map<string, unknown[]>;
  /** F1 claim-not-generate project resolution for the WHOLE session (never day-scoped). */
  project: string;
}

function readJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Scan every `*.jsonl` transcript in `claudeDir` exactly once. Returns the
 * per-file day-bucketed lines (for content extraction) plus the basenames of
 * files that could not be bounded to ANY day (no per-line timestamps AND no
 * usable mtime) — these are NEVER silently assigned to a day (ESCALATION
 * clause in the brief: report the ambiguity, don't guess).
 */
export function scanTranscripts(claudeDir: string): { files: ScannedTranscript[]; ambiguous: string[] } {
  let names: string[];
  try {
    names = fs.readdirSync(claudeDir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return { files: [], ambiguous: [] };
  }

  const files: ScannedTranscript[] = [];
  const ambiguous: string[] = [];

  for (const name of names) {
    const filePath = path.join(claudeDir, name);
    const basename = name.slice(0, -".jsonl".length);
    let fullText: string;
    try {
      fullText = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue; // unreadable — skip, never guess
    }

    // Head/tail sample for project resolution. Sliced from the already-
    // decoded string (not a raw byte buffer), so there is no UTF-8
    // boundary-splitting risk the way a byte-offset window would have —
    // JS string slicing operates on UTF-16 code units of already-valid text.
    const headText = fullText.slice(0, 60_000);
    const tailText = fullText.length > 25_000 ? fullText.slice(-25_000) : fullText;
    const project = resolveSessionProject(headText, tailText).slug;

    const byDay = new Map<string, unknown[]>();
    let sawAnyTimestamp = false;
    const rawLines: unknown[] = [];
    for (const line of fullText.split("\n")) {
      const obj = readJsonLine(line);
      if (obj === null) continue;
      rawLines.push(obj);
      if (!obj || typeof obj !== "object") continue;
      const ts = (obj as Record<string, unknown>).timestamp;
      if (typeof ts !== "string") continue;
      const day = localDay(ts);
      if (!day) continue;
      sawAnyTimestamp = true;
      let arr = byDay.get(day);
      if (!arr) {
        arr = [];
        byDay.set(day, arr);
      }
      arr.push(obj);
    }

    if (!sawAnyTimestamp) {
      // Brief item 3: fall back to file mtime day ONLY when the file has no
      // per-line timestamps at all — the whole file becomes one day-bucket.
      let mtimeDay: string | null = null;
      try {
        mtimeDay = localDay(fs.statSync(filePath).mtime.toISOString());
      } catch {
        mtimeDay = null;
      }
      if (mtimeDay) {
        byDay.set(mtimeDay, rawLines);
        files.push({ basename, byDay, project });
      } else {
        // ESCALATION: no per-line timestamps AND mtime unusable — never guess.
        ambiguous.push(basename);
      }
    } else {
      files.push({ basename, byDay, project });
    }
  }

  return { files, ambiguous };
}

// ---------------------------------------------------------------------------
// Text extraction (mirrors transcript-reader.ts's SYSTEM_PREFIXES/attachment filters)
// ---------------------------------------------------------------------------

function extractDayText(lines: unknown[]): { combinedText: string; assistantText: string } {
  const combined: string[] = [];
  const assistantOnly: string[] = [];

  for (const d of lines) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    if (isBoilerplateRecord(rec)) continue;

    if (rec.type === "user") {
      if ("attachment" in rec) continue;
      const msg = rec.message as Record<string, unknown> | undefined;
      const text = textFromContent(msg?.content);
      if (!text || isSystemText(text)) continue;
      combined.push(text);
    } else if (rec.type === "assistant") {
      const msg = rec.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const cr = c as Record<string, unknown>;
          if (cr.type === "text" && typeof cr.text === "string" && cr.text.length > 0 && !isSystemText(cr.text)) {
            combined.push(cr.text);
            assistantOnly.push(cr.text);
          }
        }
      } else {
        const text = textFromContent(content);
        if (text && !isSystemText(text)) {
          combined.push(text);
          assistantOnly.push(text);
        }
      }
    }
  }

  return { combinedText: combined.join("\n"), assistantText: assistantOnly.join("\n") };
}

// ---------------------------------------------------------------------------
// Adjudication ladder
// ---------------------------------------------------------------------------

interface LadderResult {
  verdict: TranscriptAuditVerdict;
  matchedWords: string[];
  sentence?: string;
  /** Winning transcript's basename (recurred/cited) or the full "+"-joined day-set (ignored). */
  basenameTag: string;
}

/**
 * Deterministic lexical ladder, strongest tier first, evaluated across ALL of
 * a day's matching transcripts for one project (not per-transcript in
 * isolation) — `projectFiles` must already be sorted by basename for
 * byte-identical re-runs.
 *
 * CHALLENGE fix applied (brief's own CHALLENGE clause): the CITED tier's
 * "≥2 unique ≥4-char content words" bar is degenerate for a rule whose rule
 * text has FEWER than 2 such words (a 1-word rule could otherwise never be
 * cited via the content-word path) — when `ruleWords.length < 2`, ALL of
 * them are required instead of a fixed 2.
 */
function adjudicate(
  record: CorrectionRecord,
  projectFiles: Array<{ basename: string; day: string; byDay: Map<string, unknown[]> }>,
): LadderResult {
  const ruleWords = ruleContentWords(record.rule);
  const idLower = record.id.toLowerCase();

  // Tier (a) RECURRED — sentence with a genuine recurrence marker AND ≥1
  // rule content-word co-occurring in that SAME sentence.
  for (const file of projectFiles) {
    const { combinedText } = extractDayText(file.byDay.get(file.day) ?? []);
    for (const sentence of splitSentences(combinedText)) {
      if (!RECURRENCE_MARKER.test(sentence) || EVAL_VOCAB_ANCHOR.test(sentence)) continue;
      const lower = sentence.toLowerCase();
      const hit = ruleWords.filter((w) => lower.includes(w));
      if (hit.length > 0) {
        return { verdict: "recurred", matchedWords: hit, sentence, basenameTag: file.basename };
      }
    }
  }

  // Tier (b) CITED — correction id literal anywhere, OR ≥2 (or all, if <2
  // exist) unique rule content-words in ASSISTANT text.
  for (const file of projectFiles) {
    const { combinedText, assistantText } = extractDayText(file.byDay.get(file.day) ?? []);
    if (idLower && combinedText.toLowerCase().includes(idLower)) {
      return { verdict: "cited", matchedWords: [`id:${record.id}`], basenameTag: file.basename };
    }
    if (ruleWords.length > 0) {
      const assistantLower = assistantText.toLowerCase();
      const matched = ruleWords.filter((w) => assistantLower.includes(w));
      const required = ruleWords.length < 2 ? ruleWords.length : 2;
      if (matched.length >= required) {
        return { verdict: "cited", matchedWords: matched, basenameTag: file.basename };
      }
    }
  }

  // Tier (c) IGNORED — neither. Evidence anchors to the FULL day-set of
  // transcripts considered, so idempotency compares against the same set.
  const basenameTag = [...projectFiles.map((f) => f.basename)].sort().join("+");
  return { verdict: "ignored", matchedWords: [], basenameTag };
}

// ---------------------------------------------------------------------------
// Project enumeration
// ---------------------------------------------------------------------------

function resolveTargetProjects(projectFilter: string | undefined): string[] {
  const root = getRoot();
  if (projectFilter) {
    const slug = resolveProjectDirName(root, projectFilter);
    return fs.existsSync(path.join(projectsRootDir(), slug)) ? [slug] : [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRootDir(), { withFileTypes: true });
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
 * Fix round (code review, MEDIUM): the brief's step 7 requires stamping
 * `session_id` "when derivable from the transcript filename (uuid)" — the
 * transcript basename IS the session uuid, so it's trivially available at
 * every recordOutcome call site below. It's derivable ONLY when the verdict's
 * evidence anchors to exactly ONE transcript — RECURRED/CITED always do
 * (`ladder.basenameTag` is a single winning basename), but IGNORED can anchor
 * to the full day-set of a project's transcripts when there is more than one
 * (`basenameTag` is "+"-joined). In the multi-transcript case there is no
 * single session to stamp, so session_id is omitted rather than guessed from
 * an arbitrary member of the set.
 */
function deriveSessionId(basenameTag: string): string | undefined {
  const basenames = basenameTag.split("+");
  return basenames.length === 1 ? basenames[0] : undefined;
}

// ---------------------------------------------------------------------------
// Per-day audit
// ---------------------------------------------------------------------------

async function auditDay(
  day: string,
  allFiles: ScannedTranscript[],
  ambiguousBasenames: string[],
  options: TranscriptAuditOptions,
): Promise<TranscriptAuditDaySummary> {
  const summary: TranscriptAuditDaySummary = {
    date: day,
    projects: [],
    injected: 0,
    cited: 0,
    ignored: 0,
    recurred: 0,
    dedup_skipped: 0,
    transcripts_scanned: 0,
    transcripts_ambiguous: [...ambiguousBasenames],
    projects_without_transcripts: [],
    adjudications: [],
  };

  const dayFiles = allFiles.filter((f) => f.byDay.has(day));
  summary.transcripts_scanned = dayFiles.length;

  const targetProjects = resolveTargetProjects(options.project);

  for (const project of targetProjects) {
    const onDate = readOutcomesOnDate(project, day);
    const injectedIds = [...onDate.entries()]
      .filter(([, kinds]) => kinds.has("retrieved"))
      .map(([id]) => id)
      .sort();
    if (injectedIds.length === 0) continue;

    summary.projects.push(project);
    summary.injected += injectedIds.length;

    const projectFiles = dayFiles
      .filter((f) => f.project === project)
      .map((f) => ({ basename: f.basename, day, byDay: f.byDay }))
      .sort((a, b) => a.basename.localeCompare(b.basename));

    if (projectFiles.length === 0) {
      summary.projects_without_transcripts.push(project);
      continue;
    }

    const recordsById = new Map(readCorrections(project).map((r) => [r.id, r]));
    const existingEvents = readOutcomeEventsByCorrection(project);

    for (const correctionId of injectedIds) {
      const record = recordsById.get(correctionId);
      if (!record) continue; // no on-disk correction file to adjudicate against

      const ladder = adjudicate(record, projectFiles);
      const evidence = `transcript-audit:${ladder.basenameTag}:${ladder.verdict}` +
        (ladder.sentence ? ` — "${ladder.sentence.trim()}"` : ladder.matchedWords.length > 0
          ? ` — matched [${ladder.matchedWords.join(",")}]`
          : ` — no citation/recurrence across ${projectFiles.length} transcript(s)`);

      const alreadyRecorded = (existingEvents.get(correctionId) ?? []).some(
        (e: CorrectionOutcome) =>
          e.kind === ladder.verdict &&
          localDay(e.at) === day &&
          (e.evidence ?? "").includes(ladder.basenameTag),
      );

      const entry: TranscriptAuditAdjudication = {
        date: day,
        project,
        correction_id: correctionId,
        rule: record.rule,
        verdict: ladder.verdict,
        matched_words: ladder.matchedWords,
        sentence: ladder.sentence,
        transcript_basenames: ladder.basenameTag.split("+"),
        written: false,
      };

      if (alreadyRecorded) {
        entry.skipped_reason = "dedup: an event of the same kind, day, and transcript-set already exists";
        summary.dedup_skipped++;
      } else {
        if (ladder.verdict === "recurred") summary.recurred++;
        else if (ladder.verdict === "cited") summary.cited++;
        else summary.ignored++;

        if (!options.dryRun) {
          await recordOutcome({
            correction_id: correctionId,
            project,
            kind: ladder.verdict,
            at: `${day}T12:00:00.000Z`,
            evidence,
            session_id: deriveSessionId(ladder.basenameTag),
          });
          entry.written = true;
        }
      }

      summary.adjudications.push(entry);
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * `ar outcomes audit` — see this file's header doc for the full pipeline.
 * Deterministic given the same transcripts + same store (no wall-clock in
 * any adjudication decision — only recordOutcome's own recorded_at stamping
 * touches wall-clock, and that is forensic metadata, never read back by the
 * ladder or the idempotency check).
 */
export async function runTranscriptAudit(options: TranscriptAuditOptions): Promise<TranscriptAuditResult> {
  const days = resolveDayRange(options);
  const claudeDir = options.claudeDir ?? defaultClaudeDir();
  const { files, ambiguous } = scanTranscripts(claudeDir);

  const dayResults: TranscriptAuditDaySummary[] = [];
  for (const day of days) {
    dayResults.push(await auditDay(day, files, ambiguous, options));
  }

  return {
    dry_run: !!options.dryRun,
    claude_dir: claudeDir,
    days: dayResults,
    transcripts_not_found_days: dayResults.filter((d) => d.transcripts_scanned === 0).map((d) => d.date),
  };
}
