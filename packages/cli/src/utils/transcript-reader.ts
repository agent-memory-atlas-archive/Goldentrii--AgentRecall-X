/**
 * transcript-reader.ts
 *
 * Reads Claude Code session transcripts (.jsonl files) from disk.
 * Uses head+tail strategy so it handles 100MB+ files without loading them fully.
 *
 * Discovery order:
 *   1. File paths in tool calls → project slug (most reliable)
 *   2. First real user message → task description
 *   3. Recent tail exchanges → what was accomplished
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  utf8SafeEndBoundary,
  utf8SafeStartBoundary,
  isSystemText,
  textFromContent,
} from "agent-recall-core";

// F1 (moved 2026-09-17, evolution p1a): resolveSessionProject and its
// ProjectCandidate/ResolvedSessionProject types now live in agent-recall-core
// (packages/core/src/helpers/transcript-project.ts) — transcript-audit.ts
// (also core) needs the SAME namer, and core cannot depend on this cli
// package. Re-exported here so every existing call site in this package
// (index.ts's archive hook, this file's own tests) keeps working unchanged.
export { resolveSessionProject } from "agent-recall-core";
export type { ProjectCandidate, ResolvedSessionProject } from "agent-recall-core";

export interface SessionInfo {
  /** Absolute path to the .jsonl file */
  file: string;
  /** UUID from the filename */
  sessionId: string;
  /** File size in MB */
  sizeMb: number;
  /** Last write time */
  lastModified: Date;
  /** Best-guess project slug from file path patterns (e.g. "cdance-eu") */
  projectGuess: string | null;
  /** cwd field from first record (usually just home dir) */
  cwdGuess: string | null;
  /** First non-system user message (<300 chars) */
  firstUserMessage: string | null;
  /** Last N user+assistant exchanges formatted as text, for agent summarization */
  recentExchanges: string;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/** Read the first headBytes and last tailBytes of a file without loading it all. */
function readHeadTail(
  filePath: string,
  headBytes = 60_000,
  tailBytes = 25_000,
): { head: string; tail: string } {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;

    const headLen = Math.min(headBytes, size);
    const headBuf = Buffer.allocUnsafe(headLen);
    fs.readSync(fd, headBuf, 0, headLen, 0);

    const tailStart = Math.max(0, size - tailBytes);
    const tailLen = size - tailStart;
    const tailBuf = Buffer.allocUnsafe(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, tailStart);

    // M8 fix (review, 2026-07-31): a fixed-byte-offset window can land
    // mid-UTF-8-sequence. The HEAD window's END (offset headLen, arbitrary)
    // and the TAIL window's START (offset tailStart, arbitrary — the tail's
    // OWN end is EOF, always a clean boundary for a well-formed file) both
    // need back-off, or Node's lenient UTF-8 decode silently substitutes a
    // U+FFFD replacement character for the incomplete sequence (repro'd).
    const headEnd = utf8SafeEndBoundary(headBuf, headBuf.length);
    const tailSafeStart = utf8SafeStartBoundary(tailBuf, 0);

    return {
      head: headBuf.subarray(0, headEnd).toString("utf8"),
      tail: tailBuf.subarray(tailSafeStart).toString("utf8"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

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

// ---------------------------------------------------------------------------
// Project identification
// ---------------------------------------------------------------------------

const PROJECT_RE = /\/Users\/[^/]+\/(?:[Pp]rojects?)\/([^/",\\\s`]+)/g;

/** Count project slug occurrences in raw text; return most-frequent one. */
function extractProjectSlug(text: string): string | null {
  const hits: Record<string, number> = {};
  let m: RegExpExecArray | null;
  PROJECT_RE.lastIndex = 0;
  while ((m = PROJECT_RE.exec(text)) !== null) {
    const slug = m[1].replace(/[`'".,;)>]+$/, ""); // strip trailing punctuation
    hits[slug] = (hits[slug] ?? 0) + 1;
  }
  const sorted = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------
// SYSTEM_PREFIXES / isSystemText / textFromContent moved to agent-recall-core
// (packages/core/src/helpers/transcript-project.ts) alongside resolveSessionProject
// above — imported at the top of this file, used below unchanged.

/** Find the first meaningful user message — skips hook/system/attachment messages. */
function extractFirstUserMessage(lines: unknown[]): string | null {
  for (const d of lines) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    if (rec.type !== "user") continue;
    // Skip attachment records (large skill/system content injected as user turn)
    if ("attachment" in rec) continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const text = textFromContent(msg?.content);
    if (text.length < 10 || isSystemText(text)) continue;
    return text.slice(0, 300);
  }
  return null;
}

/** Build a condensed transcript of recent exchanges for agent summarization. */
function extractRecentExchanges(lines: unknown[], maxExchanges = 20): string {
  const parts: string[] = [];
  for (const d of lines) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    const t = rec.type as string;

    if (t === "user" && !("attachment" in rec)) {
      const msg = rec.message as Record<string, unknown> | undefined;
      const text = textFromContent(msg?.content);
      if (text.length > 10 && !isSystemText(text)) {
        parts.push(`USER: ${text.slice(0, 250)}`);
      }
    } else if (t === "assistant") {
      const msg = rec.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const cr = c as Record<string, unknown>;
          if (cr.type === "text" && typeof cr.text === "string" && cr.text.length > 10) {
            parts.push(`ASSISTANT: ${cr.text.slice(0, 400)}`);
            break;
          }
        }
      }
    }

    if (parts.length >= maxExchanges * 2) break;
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A parsed session plus its verbatim head+tail bytes (the lossless dump). */
export interface TranscriptByPath extends SessionInfo {
  /** head + "\n…\n" + tail of the transcript, capped at ~80KB. */
  rawTail: string;
  /**
   * Wave-2 wiring (continuity wave 2026-07-31): the raw head sample (default
   * readHeadTail() sizing, same as the one already used internally for
   * cwdGuess/firstUserMessage/projectGuess above) — exposed so callers can
   * feed F1's `resolveSessionProject(headText, tailText)` at the hook-end
   * call site without a second file read. Additive field; existing
   * consumers are unaffected.
   */
  headText: string;
  /** Companion tail sample to `headText` (default readHeadTail() sizing). */
  tailText: string;
}

const RAW_TAIL_CAP = 80_000;

// F1b: the verbatim archive dump (rawTail) must bias toward the TAIL of the
// transcript, not the head. Confirmed empirically against the 2026-07-31
// continuity-fixture incident (reports/2026-07-31-continuity-fixture.md §1):
// the OLD policy read a large head (60K) + smaller tail (25K), concatenated
// them, then `.slice(0, RAW_TAIL_CAP)` from the FRONT — which keeps the
// entire head (stale session-start hook boilerplate) and silently discards
// whatever tail content didn't fit, i.e. the newest, most summary-dense
// messages where decisions/next-steps live. For any session whose real
// content exceeds ~80K chars this is the worst possible truncation policy.
// Fix: sample a SMALL head (just enough for a hint of how the session
// opened) and preserve a MUCH LARGER tail; if the combined string still
// exceeds the cap, trim the excess off the START (head side), never the end.
const RAW_TAIL_HEAD_SAMPLE = 20_000;
const RAW_TAIL_TAIL_PRESERVE = 60_000;

/**
 * Wave 2: parse a SINGLE transcript by its absolute path (from the Stop hook's
 * `transcript_path`), reusing the same head/tail reader as readTodaySessions —
 * no second reader for the SessionInfo fields below. Returns the parsed
 * SessionInfo PLUS a verbatim `rawTail` for the lossless archive tier.
 * Returns null if the path is missing/unreadable.
 */
export function readTranscriptByPath(filePath: string): TranscriptByPath | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    const { head, tail } = readHeadTail(filePath);
    const headLines = parseLines(head);
    const tailLines = parseLines(tail);

    const cwdGuess =
      ((headLines.find(
        (d) => d && typeof d === "object" && "cwd" in (d as object),
      ) as Record<string, unknown> | undefined)?.cwd as string | null) ?? null;

    const projectGuess = extractProjectSlug(head) ?? extractProjectSlug(tail);

    // F1b: a SEPARATE, tail-biased read dedicated to the verbatim archive
    // dump — deliberately not reusing `head`/`tail` above, which stay tuned
    // for firstUserMessage/cwdGuess (those need a decent head sample to see
    // past startup boilerplate) and must not regress by being shrunk here.
    const { head: archiveHead, tail: archiveTail } = readHeadTail(
      filePath,
      RAW_TAIL_HEAD_SAMPLE,
      RAW_TAIL_TAIL_PRESERVE,
    );
    let rawTail: string;
    // H3 fix (review, 2026-07-31): compare against the BYTE budget requested
    // from readHeadTail (RAW_TAIL_HEAD_SAMPLE), never against `archiveHead.length`
    // — a JS string's `.length` is UTF-16 CODE UNITS, not bytes. For CJK-heavy
    // content (3 bytes/char in UTF-8, ~1 UTF-16 code unit/char for BMP
    // ideographs), the string length is roughly 1/3 the byte size, so a file
    // that fit ENTIRELY inside the head sample still failed the old
    // `stat.size <= archiveHead.length` check and fell into the `else`
    // branch below — which re-reads a full tail sample and concatenates it
    // onto the SAME already-complete head, duplicating the whole file's
    // content (repro'd: a 15,162-byte CJK fixture produced exactly 2x
    // duplication). `headLen = Math.min(headBytes, size)` inside
    // readHeadTail means the ENTIRE file was captured in archiveHead
    // precisely when `size <= RAW_TAIL_HEAD_SAMPLE` — comparing against that
    // byte constant directly sidesteps the byte-vs-code-unit mismatch entirely.
    if (stat.size <= RAW_TAIL_HEAD_SAMPLE) {
      // Whole file fit in the head sample — nothing lost, no dedup needed.
      rawTail = archiveHead;
    } else {
      const combined = `${archiveHead}\n…\n${archiveTail}`;
      // Only trim if STILL over cap (head+sep+tail can exceed 80K by a few
      // bytes) — and trim from the START so the tail's true ending survives.
      rawTail = combined.length > RAW_TAIL_CAP ? combined.slice(combined.length - RAW_TAIL_CAP) : combined;
    }

    return {
      file: filePath,
      sessionId: path.basename(filePath, ".jsonl"),
      sizeMb: stat.size / 1024 / 1024,
      lastModified: stat.mtime,
      projectGuess,
      cwdGuess,
      firstUserMessage: extractFirstUserMessage(headLines),
      recentExchanges: extractRecentExchanges(tailLines),
      rawTail,
      headText: head,
      tailText: tail,
    };
  } catch {
    return null;
  }
}

/**
 * Locate and parse all Claude Code sessions modified today.
 *
 * @param claudeDir  Directory containing the .jsonl files.
 *                   Defaults to ~/.claude/projects/-Users-{username}
 */
export function readTodaySessions(claudeDir?: string): SessionInfo[] {
  const username = os.userInfo().username;
  const dir =
    claudeDir ??
    path.join(os.homedir(), ".claude", "projects", `-Users-${username}`);

  if (!fs.existsSync(dir)) return [];

  const todayStr = new Date().toISOString().slice(0, 10);

  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { full, name: f, mtime: stat.mtime, size: stat.size };
    })
    .filter((e) => e.mtime.toISOString().slice(0, 10) === todayStr)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return entries.map(({ full, name, mtime, size }) => {
    const { head, tail } = readHeadTail(full);
    const headLines = parseLines(head);
    const tailLines = parseLines(tail);

    // cwd from first record that has it
    const cwdGuess =
      (headLines.find(
        (d) => d && typeof d === "object" && "cwd" in (d as object),
      ) as Record<string, unknown> | undefined)?.cwd as string | null ?? null;

    // Project: scan head first (fewer lines but more context), fall back to tail
    const projectGuess = extractProjectSlug(head) ?? extractProjectSlug(tail);

    return {
      file: full,
      sessionId: path.basename(name, ".jsonl"),
      sizeMb: size / 1024 / 1024,
      lastModified: mtime,
      projectGuess,
      cwdGuess,
      firstUserMessage: extractFirstUserMessage(headLines),
      recentExchanges: extractRecentExchanges(tailLines),
    };
  });
}
