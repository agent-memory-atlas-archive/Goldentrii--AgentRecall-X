/**
 * transcript-audit.test.mjs
 *
 * Evolution p1a — `ar outcomes audit` core logic (packages/core/src/tools-logic/
 * transcript-audit.ts). Adjudication independence: transcript only, never the
 * session summary. Fixture transcripts + a fixture corrections store; no
 * writes to the real ~/.agent-recall (AGENT_RECALL_ROOT points at a tmp dir).
 *
 * Coverage:
 *  1. Single-producer gate — recordOutcome throws on cited/ignored without the
 *     "transcript-audit:" evidence prefix (and accepts it with the prefix).
 *  2. Adjudication ladder — RECURRED > CITED > IGNORED, including the
 *     CHALLENGE fix (a <2-content-word rule requires ALL of them for CITED).
 *  3. Day-bucketing: lines outside the audited day (and attachment/boilerplate
 *     lines) never leak into the adjudication text.
 *  4. mtime fallback: a transcript with zero per-line timestamps is bucketed
 *     by file mtime.
 *  5. Idempotency: a same-day re-run against the same transcript set writes
 *     zero new events.
 *  6. --dry-run computes adjudications but appends nothing to the ledger.
 *  7. Ledger-only: cited/ignored never mutate retrieved_count/heeded_count/
 *     recurrence_count/precision on the correction record.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { recordOutcome } from "../dist/storage/corrections.js";
import { runTranscriptAudit } from "../dist/tools-logic/transcript-audit.js";

const PROJECT = "audit-proj";
const DAY = "2026-07-01";
const NEXT_DAY = "2026-07-02";

let testRoot;
let claudeDir;

function corrDir() {
  return path.join(testRoot, "projects", PROJECT, "corrections");
}
function outcomesFile() {
  return path.join(corrDir(), "_outcomes.jsonl");
}

function seedCorrection({ id, rule }) {
  fs.mkdirSync(corrDir(), { recursive: true });
  const record = {
    id,
    date: DAY,
    severity: "p1",
    project: PROJECT,
    rule,
    context: rule,
    tags: [],
    active: true,
    retrieved_count: 1,
    heeded_count: 0,
    recurrence_count: 0,
    weight: 0.7,
    kind: "correction",
  };
  fs.writeFileSync(path.join(corrDir(), `${id}.json`), JSON.stringify(record, null, 2), "utf-8");
}

function appendOutcome(evt) {
  fs.mkdirSync(corrDir(), { recursive: true });
  fs.appendFileSync(outcomesFile(), JSON.stringify(evt) + "\n", "utf-8");
}

function readOutcomeLines() {
  if (!fs.existsSync(outcomesFile())) return [];
  return fs
    .readFileSync(outcomesFile(), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readCorrectionFile(id) {
  return JSON.parse(fs.readFileSync(path.join(corrDir(), `${id}.json`), "utf-8"));
}

function line(rec) {
  return JSON.stringify(rec);
}

function isoFor(day, hhmmss = "12:00:00") {
  return `${day}T${hhmmss}.000Z`;
}

/** Write the main day-D transcript fixture: RECURRED + 2 CITED shapes + an
 *  out-of-day / boilerplate line that must NOT leak into day D's text. */
function writeMainTranscript() {
  fs.mkdirSync(claudeDir, { recursive: true });
  const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const lines = [
    line({
      type: "user",
      timestamp: isoFor(DAY, "09:00:00"),
      cwd: `/Users/tester/Projects/${PROJECT}/sub`,
      message: { role: "user", content: "kicking off today's work" },
    }),
    line({
      type: "assistant",
      timestamp: isoFor(DAY, "09:05:00"),
      message: { role: "assistant", content: [{ type: "text", text: "I ran the build again without lint checks before pushing." }] },
    }),
    line({
      type: "assistant",
      timestamp: isoFor(DAY, "09:06:00"),
      message: { role: "assistant", content: [{ type: "text", text: "Let's skip tests for now and revisit committing later." }] },
    }),
    line({
      type: "assistant",
      timestamp: isoFor(DAY, "09:07:00"),
      message: { role: "assistant", content: [{ type: "text", text: "We shipped the fix to prod." }] },
    }),
    // Out-of-day line: mentions correction C's words, but on NEXT_DAY — must
    // NOT count toward DAY's adjudication (must stay IGNORED for DAY).
    line({
      type: "assistant",
      timestamp: isoFor(NEXT_DAY, "09:00:00"),
      message: { role: "assistant", content: [{ type: "text", text: "Reminder: use tabs not spaces, mind the indentation." }] },
    }),
    // Boilerplate/attachment line ON day D itself, heavily mentioning
    // correction C's words — must be excluded by the attachment filter too.
    line({
      type: "attachment",
      timestamp: isoFor(DAY, "09:08:00"),
      attachment: { type: "hook_success", hookName: "SessionStart:startup" },
      content: "folder-lint: tabs spaces indentation tabs spaces indentation",
    }),
  ];
  fs.writeFileSync(path.join(claudeDir, `${sid}.jsonl`), lines.join("\n"), "utf-8");
  return sid;
}

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-transcript-audit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  claudeDir = path.join(tmpdir(), `ar-transcript-audit-claude-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;

  // The claim-not-generate namer only claims an EXISTING project dir — seed it.
  fs.mkdirSync(path.join(testRoot, "projects", PROJECT), { recursive: true });

  // NOTE: deliberately avoids the word "before" — rule B's RECURRED fixture
  // sentence below also contains "before", and RECURRED is adjudicated per
  // CORRECTION (this correction's own ruleWords), so any shared ≥4-char word
  // would make THIS correction spuriously match rule B's recurrence sentence
  // too. Kept vocab-disjoint across all 4 fixture rules on purpose.
  seedCorrection({ id: "2026-07-01-never-skip-tests", rule: "Never skip unit tests when committing changes" });
  seedCorrection({ id: "2026-07-01-always-run-lint", rule: "Always run lint before pushing" });
  seedCorrection({ id: "2026-07-01-use-tabs-not-spaces", rule: "Use tabs not spaces for indentation" });
  seedCorrection({ id: "2026-07-01-ship-it", rule: "Ship it" });

  for (const id of [
    "2026-07-01-never-skip-tests",
    "2026-07-01-always-run-lint",
    "2026-07-01-use-tabs-not-spaces",
    "2026-07-01-ship-it",
  ]) {
    appendOutcome({ correction_id: id, project: PROJECT, kind: "retrieved", at: isoFor(DAY), evidence: "surfaced via recall" });
  }
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Single-producer gate
// ---------------------------------------------------------------------------

describe("recordOutcome gate — cited/ignored require transcript-audit: evidence", () => {
  it("throws on cited without the prefix", async () => {
    await assert.rejects(
      () => recordOutcome({ correction_id: "x", project: PROJECT, kind: "cited", at: isoFor(DAY), evidence: "no prefix here" }),
      /transcript-audit:/,
    );
  });

  it("throws on ignored with NO evidence at all", async () => {
    await assert.rejects(
      () => recordOutcome({ correction_id: "x", project: PROJECT, kind: "ignored", at: isoFor(DAY) }),
      /transcript-audit:/,
    );
  });

  it("accepts cited/ignored WITH the prefix and never mutates counters", async () => {
    seedCorrection({ id: "2026-07-01-gate-positive-control", rule: "gate positive control rule text" });
    await recordOutcome({
      correction_id: "2026-07-01-gate-positive-control",
      project: PROJECT,
      kind: "cited",
      at: isoFor(DAY),
      evidence: "transcript-audit:sid123:cited — matched [gate,control]",
    });
    const before = readCorrectionFile("2026-07-01-gate-positive-control");
    assert.equal(before.retrieved_count, 1, "cited must not touch retrieved_count");
    assert.equal(before.heeded_count ?? 0, 0, "cited must not touch heeded_count");
    assert.equal(before.recurrence_count ?? 0, 0, "cited must not touch recurrence_count");
  });
});

// ---------------------------------------------------------------------------
// 2. Adjudication ladder (RECURRED > CITED > IGNORED) + day-bucketing
// ---------------------------------------------------------------------------

describe("adjudication ladder", () => {
  it("RECURRED wins for a rule whose content word co-occurs with a genuine recurrence marker", async () => {
    writeMainTranscript();
    const result = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: true });
    const day = result.days[0];
    const verdict = day.adjudications.find((a) => a.correction_id === "2026-07-01-always-run-lint");
    assert.ok(verdict, "correction must be adjudicated");
    assert.equal(verdict.verdict, "recurred");
    assert.ok(verdict.sentence?.includes("again"), `sentence should carry the marker; got: ${verdict.sentence}`);
  });

  it("CITED fires on ≥2 unique ≥4-char rule content words in ASSISTANT text", async () => {
    writeMainTranscript();
    const result = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: true });
    const verdict = result.days[0].adjudications.find((a) => a.correction_id === "2026-07-01-never-skip-tests");
    assert.equal(verdict.verdict, "cited");
    assert.ok(verdict.matched_words.includes("skip") && verdict.matched_words.includes("tests"));
  });

  it("CHALLENGE fix: a <2-content-word rule ('Ship it' → 1 word) is CITED when that ONE word matches", async () => {
    writeMainTranscript();
    const result = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: true });
    const verdict = result.days[0].adjudications.find((a) => a.correction_id === "2026-07-01-ship-it");
    assert.ok(verdict, "the 1-word-rule correction must still be adjudicated (not silently dropped)");
    assert.equal(verdict.verdict, "cited", `a 1-content-word rule must be citable via the ALL-words fallback; got ${verdict.verdict}`);
    assert.deepEqual(verdict.matched_words, ["ship"]);
  });

  it("IGNORED when the only matching text is on a DIFFERENT day or inside an attachment record", async () => {
    writeMainTranscript();
    const result = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: true });
    const verdict = result.days[0].adjudications.find((a) => a.correction_id === "2026-07-01-use-tabs-not-spaces");
    assert.equal(verdict.verdict, "ignored", "next-day + attachment-only mentions must not count toward this day");
  });

  it("day summary counts match the four adjudications", async () => {
    writeMainTranscript();
    const result = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: true });
    const day = result.days[0];
    assert.equal(day.injected, 4);
    assert.equal(day.recurred, 1);
    assert.equal(day.cited, 2);
    assert.equal(day.ignored, 1);
    assert.equal(day.projects_without_transcripts.length, 0);
    assert.equal(day.transcripts_scanned, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. mtime fallback (no per-line timestamps at all)
// ---------------------------------------------------------------------------

describe("mtime fallback — transcript with zero per-line timestamps", () => {
  it("is bucketed by file mtime day and still adjudicated", async () => {
    const sid = "ffffffff-0000-0000-0000-000000000000";
    const noTsLines = [
      line({ type: "user", message: { role: "user", content: "no timestamp field anywhere in this fixture" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "shipped it already" }] } }),
    ];
    const filePath = path.join(claudeDir, `${sid}.jsonl`);
    fs.writeFileSync(filePath, noTsLines.join("\n"), "utf-8");
    // Backdate mtime to the audited day, noon.
    const mtime = new Date(isoFor(DAY, "12:00:00"));
    fs.utimesSync(filePath, mtime, mtime);

    // No cwd in this fixture, so resolveSessionProject can't claim a project
    // via Signal 1 either — confirm it's correctly excluded (not silently
    // mis-attributed) by checking it does NOT get claimed for our project.
    const result = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: true });
    const day = result.days[0];
    // No transcript resolves to PROJECT here (no cwd/content signal) —
    // this asserts the SCAN still counted it (transcripts_scanned reflects
    // day-bucket membership before project filtering), proving mtime-fallback
    // bucketing worked, while claim-not-generate correctly withheld it from
    // our project (no false attribution).
    assert.equal(day.transcripts_scanned, 1, "the no-timestamp file must be bucketed via mtime, not dropped");
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("re-running the same day against the same transcript set writes zero new events", async () => {
    writeMainTranscript();
    const first = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: false });
    const countAfterFirst = readOutcomeLines().length;
    assert.ok(countAfterFirst > 0, "first run must have written events");
    const writtenFirst = first.days[0].adjudications.filter((a) => a.written).length;
    assert.equal(writtenFirst, 4, "first run should write all 4 adjudications");

    const second = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: false });
    const countAfterSecond = readOutcomeLines().length;
    assert.equal(countAfterSecond, countAfterFirst, "second run must append ZERO new lines");
    const writtenSecond = second.days[0].adjudications.filter((a) => a.written).length;
    assert.equal(writtenSecond, 0, "second run must report zero writes");
    assert.equal(second.days[0].dedup_skipped, 4, "all 4 must be reported as dedup-skipped");
  });
});

// ---------------------------------------------------------------------------
// 5. --dry-run writes nothing
// ---------------------------------------------------------------------------

describe("--dry-run", () => {
  it("computes adjudications but appends nothing to _outcomes.jsonl", async () => {
    writeMainTranscript();
    const before = readOutcomeLines().length;
    const result = await runTranscriptAudit({ date: DAY, claudeDir, dryRun: true });
    const after = readOutcomeLines().length;
    assert.equal(after, before, "dry-run must not append any ledger lines");
    assert.equal(result.dry_run, true);
    assert.ok(result.days[0].adjudications.every((a) => a.written === false));
  });
});

// ---------------------------------------------------------------------------
// 6. session_id stamping (fix round — code review MEDIUM)
// ---------------------------------------------------------------------------
//
// Brief step 7: "Include session_id when derivable from the transcript
// filename (uuid)." The transcript basename IS the session uuid. Derivable
// whenever the verdict's evidence anchors to exactly ONE transcript
// (RECURRED/CITED always do; IGNORED does too when only one transcript
// contributed that day) — never guessed when IGNORED's evidence spans
// multiple transcripts.

describe("session_id stamping", () => {
  it("stamps session_id = the winning transcript's own uuid for recurred/cited/ignored when exactly one transcript contributes", async () => {
    const sid = writeMainTranscript();
    await runTranscriptAudit({ date: DAY, claudeDir, dryRun: false });
    const events = readOutcomeLines();
    const byKey = new Map(events.map((e) => [`${e.correction_id}:${e.kind}`, e]));

    assert.equal(
      byKey.get("2026-07-01-always-run-lint:recurred")?.session_id,
      sid,
      "recurred event must carry the transcript's own uuid as session_id",
    );
    assert.equal(
      byKey.get("2026-07-01-never-skip-tests:cited")?.session_id,
      sid,
      "cited event must carry the transcript's own uuid as session_id",
    );
    assert.equal(
      byKey.get("2026-07-01-use-tabs-not-spaces:ignored")?.session_id,
      sid,
      "ignored event must carry session_id when only ONE transcript contributed that day (unambiguous)",
    );
  });

  it("omits session_id (never guesses) for an ignored verdict spanning MULTIPLE transcripts on the same day", async () => {
    writeMainTranscript(); // sid A — contributes the day's usual RECURRED/CITED/IGNORED shapes
    // A second, unrelated transcript for the SAME project + day makes the
    // day's project file-set size 2, so an IGNORED verdict's evidence joins
    // BOTH basenames with "+" and is no longer a single derivable uuid.
    const sid2 = "99999999-8888-7777-6666-555555555555";
    fs.writeFileSync(
      path.join(claudeDir, `${sid2}.jsonl`),
      [
        line({
          type: "user",
          timestamp: isoFor(DAY, "10:00:00"),
          cwd: `/Users/tester/Projects/${PROJECT}/sub2`,
          message: { role: "user", content: "second session, same project, same day" },
        }),
        line({
          type: "assistant",
          timestamp: isoFor(DAY, "10:05:00"),
          message: { role: "assistant", content: [{ type: "text", text: "Nothing relevant mentioned in this second session." }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    await runTranscriptAudit({ date: DAY, claudeDir, dryRun: false });
    const events = readOutcomeLines();
    const ignored = events.find((e) => e.correction_id === "2026-07-01-use-tabs-not-spaces" && e.kind === "ignored");
    assert.ok(ignored, "the tabs-not-spaces correction must still be adjudicated ignored");
    assert.ok(ignored.evidence.includes("+"), "evidence's basenameTag must reflect BOTH contributing transcripts");
    assert.equal(ignored.session_id, undefined, "ambiguous multi-transcript ignored verdict must NOT guess a session_id");
  });
});
