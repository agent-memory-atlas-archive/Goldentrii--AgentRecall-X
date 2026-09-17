/**
 * implicit-harvest.test.mjs
 *
 * Evolution p1b — `ar corrections harvest-implicit` core logic
 * (packages/core/src/tools-logic/implicit-harvest.ts). High-precision,
 * low-recall implicit correction-signal miner over USER turns: negation
 * openers, again-markers + verb, repeated near-identical instructions.
 *
 * Coverage:
 *  1. Signal (a) negation-opener — English + Chinese positive fixtures fire;
 *     a pure acknowledgment continuation ("no, that's not what I meant" —
 *     corrections.ts's OWN canonical soft-ack fixture) does NOT fire (the
 *     precision bug found via manual fixture-testing before this suite was
 *     written — RED before the MINIMAL_VERB tightening, GREEN after).
 *  2. Signal (b) again-marker + verb — fires only when BOTH are present.
 *  3. Signal (c) repeat-instruction — Jaccard ≥0.6 over ≥6-word turns; the
 *     SECOND occurrence is the candidate; dissimilar or short turns never fire.
 *  4. Negative fixtures: questions, opinions, doc-header/report text never capture.
 *  5. Hard-noise gate integration: a signal-detected candidate that still
 *     fails dropHardNoise is gated_out and logged to _rejected.jsonl with
 *     reason "implicit-gate" — never written.
 *  6. Cap: max 5 candidates/session; the rest are reported "capped", never
 *     gate-checked or written.
 *  7. Storage contract: written records are severity "p1" / kind "correction"
 *     / weight 0.3 / confidence "low" / provenance transcript-implicit+observed
 *     / tags ["implicit"] — even when the mined text itself carries p0-strength
 *     language (severity is hard-floored, never derived).
 *  8. On-write consolidation: the same rule text harvested twice merges into
 *     one active correction (dedup_merged), never a duplicate file.
 *  9. Watch-tier isolation: an implicit record never enters session_start's
 *     P0 section (readP0Corrections) and never touches the outcome ledger
 *     that feeds heed_rate (getCorrectionKPIs' retrieved/heeded/recurred/
 *     precision are byte-identical before vs after a harvest write).
 * 10. Dry-run (the default) never writes a correction file, never appends to
 *     _rejected.jsonl, and never appends to _outcomes.jsonl.
 * 11. --project filters to one project's sessions; unresolved ("auto")
 *     sessions are reported, never guessed into a project.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { runImplicitHarvest } from "../dist/tools-logic/implicit-harvest.js";
import {
  readCorrections,
  readP0Corrections,
  readRejectedCorrections,
  getCorrectionKPIs,
} from "../dist/storage/corrections.js";

const PROJECT = "implicit-proj";
const DAY = "2026-07-01";

let testRoot;
let claudeDir;

function corrDir(project = PROJECT) {
  return path.join(testRoot, "projects", project, "corrections");
}
function outcomesFile(project = PROJECT) {
  return path.join(corrDir(project), "_outcomes.jsonl");
}

function line(rec) {
  return JSON.stringify(rec);
}
function isoFor(hhmmss, day = DAY) {
  return `${day}T${hhmmss}.000Z`;
}

function writeTranscript(sid, lines) {
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${sid}.jsonl`), lines.join("\n"), "utf-8");
}

function userLine(text, hhmmss, cwdProject = PROJECT) {
  return line({
    type: "user",
    timestamp: isoFor(hhmmss),
    cwd: `/Users/tester/Projects/${cwdProject}/sub`,
    message: { role: "user", content: text },
  });
}
function assistantLine(text, hhmmss) {
  return line({
    type: "assistant",
    timestamp: isoFor(hhmmss),
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}
/** A user turn whose content is a text BLOCK array (image-caption shape). */
function userBlockLine(blockText, hhmmss, cwdProject = PROJECT) {
  return line({
    type: "user",
    timestamp: isoFor(hhmmss),
    cwd: `/Users/tester/Projects/${cwdProject}/sub`,
    message: { role: "user", content: [{ type: "text", text: blockText }] },
  });
}
/** A Claude-Code-injected compaction/continuation summary (role "user", isCompactSummary: true). */
function compactSummaryLine(text, hhmmss, cwdProject = PROJECT) {
  return line({
    type: "user",
    isCompactSummary: true,
    timestamp: isoFor(hhmmss),
    cwd: `/Users/tester/Projects/${cwdProject}/sub`,
    message: { role: "user", content: text },
  });
}
/** A Claude-Code-injected skill/continuation-nudge record (role "user", isMeta: true). */
function metaLine(text, hhmmss, cwdProject = PROJECT) {
  return line({
    type: "user",
    isMeta: true,
    timestamp: isoFor(hhmmss),
    cwd: `/Users/tester/Projects/${cwdProject}/sub`,
    message: { role: "user", content: text },
  });
}

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-implicit-harvest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  claudeDir = path.join(tmpdir(), `ar-implicit-harvest-claude-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
  // The claim-not-generate namer only claims an EXISTING project dir — seed it.
  fs.mkdirSync(path.join(testRoot, "projects", PROJECT), { recursive: true });
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Negation-opener
// ---------------------------------------------------------------------------

describe("signal (a): negation opener", () => {
  it("English: 'No, that's wrong. <re-instruction>' fires and strips the opener", async () => {
    writeTranscript("s1", [
      assistantLine("I've added a red login button in the top right corner.", "09:00:00"),
      userLine("No, that's wrong. Use the blue button instead of the red one.", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    const cands = result.days[0].candidates.filter((c) => c.signal === "negation");
    assert.equal(cands.length, 1);
    assert.equal(cands[0].rule, "that's wrong. Use the blue button instead of the red one.");
    assert.equal(cands[0].context, "I've added a red login button in the top right corner.");
    assert.equal(cands[0].outcome, "would_write");
  });

  it("Chinese: '不对，应该用 X 不是 Y' fires", async () => {
    writeTranscript("s1", [
      assistantLine("Fixed, using novada-mcp now.", "09:00:00"),
      userLine("不对，应该用 novada-search 不是 novada-mcp。", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    const cands = result.days[0].candidates.filter((c) => c.signal === "negation");
    assert.equal(cands.length, 1);
    assert.ok(cands[0].rule.includes("novada-search"));
  });

  it("RED→GREEN regression: pure acknowledgment 'no, that's not what I meant' does NOT fire", async () => {
    writeTranscript("s1", [
      assistantLine("Got it.", "09:00:00"),
      userLine("no, that's not what I meant", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0, "a content-free acknowledgment must never be mined as a candidate");
  });

  it("a negation opener with <4 words of remainder does not fire", async () => {
    writeTranscript("s1", [userLine("No, stop.", "09:01:00")]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Again-marker + verb
// ---------------------------------------------------------------------------

describe("signal (b): again-marker + verb (--experimental-signals only, see fix round 3)", () => {
  it("is OFF by default: a clear, unambiguous again+verb fixture produces ZERO candidates without the opt-in", async () => {
    writeTranscript("s1", [
      assistantLine("I ran the deploy without checking staging first.", "09:00:00"),
      userLine("You did that again — always use staging before prod deploys.", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0, "signal (b) must never fire unless experimentalSignals is explicitly true");
  });

  it("experimentalSignals:true: fires when a recurrence marker AND an imperative-ish verb co-occur", async () => {
    writeTranscript("s1", [
      assistantLine("I ran the deploy without checking staging first.", "09:00:00"),
      userLine("You did that again — always use staging before prod deploys.", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1);
    assert.ok(cands[0].rule.includes("use"), `expected the verb-bearing sentence, got: ${cands[0].rule}`);
  });

  it("experimentalSignals:true: Chinese again-marker + verb fires", async () => {
    writeTranscript("s1", [
      userLine("怎么又这样，应该先确认再部署。", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1);
  });

  it("experimentalSignals:true: recurrence marker WITHOUT a verb does not fire", async () => {
    writeTranscript("s1", [userLine("This happened again, how frustrating.", "09:01:00")]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(result.days[0].candidates.length, 0);
  });

  it("experimentalSignals:true: a verb WITHOUT a recurrence marker does not fire", async () => {
    writeTranscript("s1", [userLine("Please use the staging environment before deploying.", "09:01:00")]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(result.days[0].candidates.length, 0);
  });

  it("fix round 3 regression: a voice-dictation run-on monologue with 'again' as a plain TEMPORAL ADVERB (not a recurrence report) never fires, even with the opt-in", async () => {
    // Crafted from the judge's real 48-day-window false-positive shape: no
    // terminal punctuation at all (a genuine dictation run-on), so the whole
    // turn is ONE sentence by splitSentences' own contract — "again" here is
    // ordinary temporal language ("we talked about this again last week"),
    // and the only MINIMAL_VERB match ("should use") sits in a wholly
    // unrelated later clause about a UI color opinion, not a re-instruction
    // to the assistant. This is exactly the mechanism fix round 3 measured
    // as 0 TP / 2 FP over the real window and is why the family was dropped
    // from the default rather than regex-patched a fourth time.
    writeTranscript("s1", [
      userLine(
        "yeah so like we talked about this again last week when I was going through the onboarding flow " +
          "and separately I think we should use a different color for the button on the settings page " +
          "and then theres also the thing with the billing page where numbers dont line up properly " +
          "and I keep meaning to get to it but havent yet",
        "09:00:00",
      ),
    ]);
    const withoutOptIn = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(withoutOptIn.days[0].candidates.length, 0, "signal (b) is off by default — this must never fire at all without the opt-in");

    // Non-vacuous check: with the opt-in, the marker+verb DO co-occur in the
    // single unpunctuated "sentence" — proving the fixture actually exercises
    // AGAIN_MARKER/MINIMAL_VERB co-occurrence (the real mechanism under test),
    // not some incidental gate (word count, hard-noise, etc.) that would make
    // the default-off assertion above pass for the wrong reason.
    const withOptIn = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = withOptIn.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1, "the opt-in path must still detect this as an again+verb co-occurrence — confirms the default-off result above is due to the fix round 3 gate, not an unrelated miss");
  });
});

// ---------------------------------------------------------------------------
// 3. Repeat-instruction
// ---------------------------------------------------------------------------

describe("signal (c): repeat-instruction (--experimental-signals only, see fix round 2)", () => {
  it("is OFF by default: a clear, unambiguous repeat fixture produces ZERO candidates without the opt-in", async () => {
    writeTranscript("s1", [
      userLine("Please make sure the dashboard loads under two seconds on every page.", "09:00:00"),
      assistantLine("Working on it.", "09:01:00"),
      userLine("Make sure the dashboard loads in under two seconds on every single page.", "09:02:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0, "signal (c) must never fire unless experimentalSignals is explicitly true");
  });

  it("experimentalSignals:true: two ≥6-word turns with Jaccard ≥0.6 fire on the SECOND occurrence", async () => {
    writeTranscript("s1", [
      userLine("Please make sure the dashboard loads under two seconds on every page.", "09:00:00"),
      assistantLine("Working on it.", "09:01:00"),
      userLine("Make sure the dashboard loads in under two seconds on every single page.", "09:02:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "repeat");
    assert.equal(cands.length, 1);
    assert.ok(cands[0].rule.startsWith("Make sure the dashboard loads in under two seconds"));
    assert.equal(cands[0].context, "Working on it.");
  });

  it("experimentalSignals:true: two DISSIMILAR ≥6-word turns do not fire", async () => {
    writeTranscript("s1", [
      userLine("Please make sure the dashboard loads under two seconds on every page.", "09:00:00"),
      userLine("Can you also add a dark mode toggle to the settings panel please.", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "repeat");
    assert.equal(cands.length, 0);
  });

  it("experimentalSignals:true: two similar but SHORT (<6-word) turns do not fire", async () => {
    writeTranscript("s1", [
      userLine("use the blue one", "09:00:00"),
      userLine("use the blue one", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "repeat");
    assert.equal(cands.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Negative fixtures — questions, opinions, quoted/doc text
// ---------------------------------------------------------------------------

describe("negative fixtures", () => {
  it("a question never fires", async () => {
    writeTranscript("s1", [userLine("What time does the deploy usually finish?", "09:00:00")]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0);
  });

  it("an opinion/praise statement never fires", async () => {
    writeTranscript("s1", [userLine("I really like how this dashboard looks today, nice work.", "09:00:00")]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0);
  });

  it("a doc/report header pasted into a negation opener is detected but gated out (dry-run predicts the gate)", async () => {
    writeTranscript("s1", [
      userLine("No, use this instead:\n# Status Report — deploy checklist", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    const cands = result.days[0].candidates;
    // Either it never fires (remainder is a doc header with no verb match
    // after the first line) or it fires and is correctly predicted "gated".
    for (const c of cands) assert.notEqual(c.outcome, "would_write");
  });
});

// ---------------------------------------------------------------------------
// 5. Hard-noise gate integration
// ---------------------------------------------------------------------------

describe("hard-noise gate integration", () => {
  it("a signal-detected candidate that is too short (<12 chars) is gated_out and logged with reason implicit-gate", async () => {
    writeTranscript("s1", [userLine("停，应该用蓝色不用红色", "09:00:00")]);
    const dry = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(dry.days[0].gated_out, 1);
    assert.equal(dry.days[0].candidates[0].outcome, "gated");
    assert.equal(dry.days[0].candidates[0].reason, "implicit-gate");

    // Dry-run must NEVER append to _rejected.jsonl.
    assert.equal(readRejectedCorrections(PROJECT).length, 0, "dry-run must not touch _rejected.jsonl");

    const written = await runImplicitHarvest({ date: DAY, claudeDir, write: true });
    assert.equal(written.days[0].gated_out, 1);
    assert.equal(written.days[0].written, 0);
    const rejected = readRejectedCorrections(PROJECT);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason, "implicit-gate");
  });
});

// ---------------------------------------------------------------------------
// 6. Cap — max 5 candidates/session
// ---------------------------------------------------------------------------

describe("cap: max 5 candidates/session", () => {
  it("the 6th+ raw candidate in one session is reported capped, never gate-checked or written", async () => {
    const lines = [];
    for (let i = 0; i < 6; i++) {
      lines.push(userLine(`No, that's wrong. Use option ${i} instead of the default one now.`, `09:0${i}:00`));
    }
    writeTranscript("s1", lines);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: true });
    const day = result.days[0];
    assert.equal(day.candidates_by_signal.negation, 6, "all 6 raw detections are counted");
    assert.equal(day.capped, 1, "only the 6th exceeds the per-session cap");
    assert.equal(day.written + day.dedup_merged, 5, "at most 5 candidates/session ever reach the write path");
    const capped = day.candidates.filter((c) => c.outcome === "capped");
    assert.equal(capped.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 7. Storage contract
// ---------------------------------------------------------------------------

describe("storage contract", () => {
  it("a written record is severity p1 / kind correction / weight 0.3 / confidence low / provenance transcript-implicit+observed / tags [implicit] — even with p0-strength language", async () => {
    // "必须" / "永远不要" is exactly the kind of language detectSeverity would
    // classify p0 — proving severity is HARD-FLOORED, never derived, for this
    // producer.
    writeTranscript("s1", [
      userLine("No, that's wrong. You must always use the staging environment first.", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: true });
    assert.equal(result.days[0].written, 1);
    const id = result.days[0].candidates[0].correction_id;
    const record = readCorrections(PROJECT).find((r) => r.id === id);
    assert.ok(record, "the written record must be readable back from the store");
    assert.equal(record.severity, "p1");
    assert.equal(record.kind, "correction");
    assert.equal(record.weight, 0.3);
    assert.equal(record.confidence, "low");
    assert.deepEqual(record.provenance, { source: "transcript-implicit", mode: "observed" });
    assert.deepEqual(record.tags, ["implicit"]);
  });
});

// ---------------------------------------------------------------------------
// 8. On-write consolidation
// ---------------------------------------------------------------------------

describe("on-write consolidation", () => {
  it("the same rule text harvested twice (two sessions) merges into one active correction", async () => {
    writeTranscript("s1", [
      userLine("No, that's wrong. Use the blue button instead of the red one.", "09:00:00"),
    ]);
    writeTranscript("s2", [
      userLine("No, that's wrong. Use the blue button instead of the red one.", "10:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: true });
    const totalNew = result.days[0].written;
    const totalMerged = result.days[0].dedup_merged;
    assert.equal(totalNew, 1, "first occurrence is a brand-new record");
    assert.equal(totalMerged, 1, "second occurrence merges instead of duplicating");

    const files = fs.readdirSync(corrDir()).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "exactly one correction file on disk, never a duplicate");
  });
});

// ---------------------------------------------------------------------------
// 9. Watch-tier isolation
// ---------------------------------------------------------------------------

describe("watch-tier isolation (hard contract)", () => {
  it("an implicit record never enters session_start's P0 section and never changes heed_rate inputs", async () => {
    // Seed an ORDINARY correction with real KPI history first, to prove the
    // implicit write leaves its aggregate untouched.
    fs.mkdirSync(corrDir(), { recursive: true });
    fs.writeFileSync(
      path.join(corrDir(), "2026-06-01-ordinary.json"),
      JSON.stringify({
        id: "2026-06-01-ordinary", date: "2026-06-01", severity: "p1", project: PROJECT,
        rule: "Always run lint before pushing", context: "seeded", tags: [],
        active: true, retrieved_count: 4, heeded_count: 3, recurrence_count: 1, weight: 0.7, kind: "correction",
      }, null, 2),
      "utf-8",
    );
    const kpiBefore = getCorrectionKPIs(PROJECT);

    writeTranscript("s1", [
      userLine("No, that's wrong. You must always use the staging environment first.", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: true });
    assert.equal(result.days[0].written, 1);

    // (1) never enters the P0 section, regardless of how p0-strength its text reads.
    const p0s = readP0Corrections(PROJECT);
    assert.equal(p0s.length, 0, "an implicit record must never surface in session_start's P0 section");

    // (2) never changes heed_rate's inputs — the aggregate is byte-identical
    // before vs after, because the new record's own retrieved/heeded/recurred
    // are all 0 and nothing in the harvest pipeline calls recordOutcome.
    const kpiAfter = getCorrectionKPIs(PROJECT);
    assert.equal(kpiAfter.retrieved, kpiBefore.retrieved);
    assert.equal(kpiAfter.heeded, kpiBefore.heeded);
    assert.equal(kpiAfter.recurred, kpiBefore.recurred);
    assert.equal(kpiAfter.precision, kpiBefore.precision);

    // (3) the outcome ledger that feeds heed-tiers.ts is untouched.
    assert.ok(!fs.existsSync(outcomesFile()), "harvest-implicit must never call recordOutcome / touch _outcomes.jsonl");
  });
});

// ---------------------------------------------------------------------------
// 10. Dry-run has zero side effects
// ---------------------------------------------------------------------------

describe("dry-run (the default) has zero side effects", () => {
  it("writes no correction file, no _rejected.jsonl row, no _outcomes.jsonl row", async () => {
    writeTranscript("s1", [
      userLine("No, that's wrong. Use the blue button instead of the red one.", "09:00:00"),
      userLine("停，应该用蓝色不用红色", "09:01:00"), // would-be-gated candidate too
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir }); // write omitted → default dry-run
    assert.equal(result.dry_run, true);
    assert.equal(fs.existsSync(corrDir()), false, "dry-run must never create the corrections directory");
  });
});

// ---------------------------------------------------------------------------
// 11. --project filter + unresolved-project sessions
// ---------------------------------------------------------------------------

describe("--project filter", () => {
  it("only harvests sessions resolving to the target project; other/unresolved sessions are reported, never guessed", async () => {
    const otherProject = "other-proj";
    fs.mkdirSync(path.join(testRoot, "projects", otherProject), { recursive: true });

    writeTranscript("s1", [userLine("No, that's wrong. Use the blue button instead of the red one.", "09:00:00", PROJECT)]);
    writeTranscript("s2", [userLine("No, that's wrong. Use the green button instead of the pink one.", "09:00:00", otherProject)]);
    // An "auto" session — no cwd/content signal strong enough to resolve.
    fs.writeFileSync(
      path.join(claudeDir, "s3.jsonl"),
      [line({ type: "user", timestamp: isoFor("09:00:00"), message: { role: "user", content: "No, that's wrong. Use the black button instead of the white one." } })].join("\n"),
      "utf-8",
    );

    const result = await runImplicitHarvest({ date: DAY, claudeDir, project: PROJECT, write: false });
    const day = result.days[0];
    assert.equal(day.sessions_scanned, 1, "only the target project's session is scanned");
    assert.equal(day.candidates.every((c) => c.project === PROJECT), true);
    assert.equal(day.unresolved_project_sessions.length, 0, "s3 was filtered out by --project before resolution mattered");
  });

  it("without --project, an unresolved ('auto') session is reported and never harvested", async () => {
    fs.writeFileSync(
      path.join(claudeDir, "s3.jsonl"),
      [line({ type: "user", timestamp: isoFor("09:00:00"), message: { role: "user", content: "No, that's wrong. Use the black button instead of the white one." } })].join("\n"),
      "utf-8",
    );
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    const day = result.days[0];
    assert.equal(day.unresolved_project_sessions.length, 1);
    assert.equal(day.candidates.length, 0, "an unresolved session is never harvested");
  });
});

// ---------------------------------------------------------------------------
// 12. Fix round (post-review, 2026-09-17) — precision-sample findings
// ---------------------------------------------------------------------------

describe("fix round: image-attachment placeholder noise", () => {
  it("two '[Image: source: ...]' placeholder turns never fire signal (c) repeat, even though they clear Jaccard>=0.6", async () => {
    writeTranscript("s1", [
      userBlockLine("[Image: source: /Users/tongwu/.claude/image-cache/8a02c8b2/3.png]", "09:00:00"),
      userBlockLine("[Image: source: /Users/tongwu/.claude/image-cache/8a02c8b2/4.png]", "09:01:00"),
    ]);
    // experimentalSignals:true — this fixture tests the STRIP-BEFORE-EXTRACT
    // property (a placeholder-only turn never even becomes a UserTurn), which
    // signal (c) being off-by-default (fix round 2) would otherwise mask.
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(result.days[0].candidates.length, 0, "placeholder-only turns must never become a candidate");
  });

  it("two '[Image: original WxH, displayed at WxH...]' resize-metadata turns never fire", async () => {
    writeTranscript("s1", [
      userBlockLine("[Image: original 1200x2432, displayed at 987x2000. Multiply coordinates by 1.22 to map to original image.]", "09:00:00"),
      userBlockLine("[Image: original 1200x2432, displayed at 987x2000. Multiply coordinates by 1.22 to map to original image.]", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(result.days[0].candidates.length, 0);
  });

  it("a '[Image #1] <real question>' turn keeps its real text (marker stripped) but still never fires — it's a question", async () => {
    writeTranscript("s1", [
      userLine("[Image #1] Can you update this for me please, it looks broken today?", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0);
  });
});

describe("fix round: compaction/continuation summary is never mined", () => {
  it("a role:user record with isCompactSummary:true is excluded even when its recap text reads rule-like", async () => {
    writeTranscript("s1", [
      compactSummaryLine(
        "This session is being continued from a previous conversation that ran out of context.\n" +
          "Summary:\n" +
          "Use strict natural calendar months again, always use them consistently.",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0, "compaction-summary text must never be mined as a live user turn");
  });

  it("a compaction summary interleaved with a real correction never adds a spurious candidate of its own", async () => {
    writeTranscript("s1", [
      compactSummaryLine("Some prior recap mentioning use staging again and again.", "09:00:00"),
      userLine("No, that's wrong. Use the blue button instead of the red one.", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 1, "only the real turn's correction is a candidate — the compaction summary contributes none");
    assert.equal(result.days[0].candidates[0].signal, "negation");
  });
});

describe("fix round: negation-opener verb must be in the corrective clause, not an unrelated later clause", () => {
  it("'No need to revoke. ... people who USE these npm tokens...' does not fire (coincidental verb far from the opener)", async () => {
    writeTranscript("s1", [
      userLine(
        "No need to revoke. This is not a dangerous action because it's useless for the people who use these npm access tokens for automated npm publishing without human review.",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    assert.equal(result.days[0].candidates.length, 0);
  });

  it("the existing 'No, that's wrong. Use the blue button...' fixture still fires (regression pin)", async () => {
    writeTranscript("s1", [
      userLine("No, that's wrong. Use the blue button instead of the red one.", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    const cands = result.days[0].candidates.filter((c) => c.signal === "negation");
    assert.equal(cands.length, 1);
    assert.equal(cands[0].rule, "that's wrong. Use the blue button instead of the red one.");
  });
});

describe("fix round: again-marker and verb must co-occur in the SAME sentence (--experimental-signals only, see fix round 3)", () => {
  it("'again' in one sentence and an unrelated verb in a later, unrelated sentence does not fire", async () => {
    writeTranscript("s1", [
      userLine(
        "This happened again and it's frustrating. Separately, you should always remember that our office lease renewal uses a different vendor now.",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(result.days[0].candidates.length, 0);
  });

  it("the existing 'You did that again — always use staging...' fixture still fires (regression pin)", async () => {
    writeTranscript("s1", [
      userLine("You did that again — always use staging before prod deploys.", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1);
  });
});

describe("fix round: repeat-instruction never fires on a repeated open-ended QUESTION (experimentalSignals:true)", () => {
  it("the same open-ended design question asked twice does not fire", async () => {
    writeTranscript("s1", [
      userLine("What would be a success for cross-project long-term memory retrieval quality here?", "09:00:00"),
      userLine("What would be considered success for cross-project long-term memory retrieval here?", "09:01:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "repeat");
    assert.equal(cands.length, 0);
  });

  it("the existing 'make sure the dashboard loads...' (non-question) repeat fixture still fires (regression pin)", async () => {
    writeTranscript("s1", [
      userLine("Please make sure the dashboard loads under two seconds on every page.", "09:00:00"),
      userLine("Make sure the dashboard loads in under two seconds on every single page.", "09:02:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "repeat");
    assert.equal(cands.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 13. Fix round 2 (post-review, 2026-09-17) — precision measured 28% on the
// real 14-day window against a 60% floor. Four residual junk families.
// ---------------------------------------------------------------------------

describe("fix round 2: <task-notification> background-task blocks are never mined", () => {
  // Signal (a)'s NEGATION_OPENER is anchored to the START of the whole turn
  // text — real <task-notification> content always starts with the literal
  // tag, so signal (a) was never actually at risk. Signal (b)/(c) scan the
  // WHOLE turn (or per-sentence), so a plausible <summary> line inside the
  // block is exactly the shape that WOULD have fired pre-fix — this is the
  // realistic risk shape, not a vacuous fixture that fails with or without
  // the tag filter. Signal (b) fixtures below pass experimentalSignals:true
  // (fix round 3 moved it behind the same opt-in as (c)) so they still
  // exercise the tag-skip mechanism under test, not the (now-separate)
  // default-off gate.
  it("a role:user <task-notification> record whose <summary> line carries an again+verb sentence never fires", async () => {
    writeTranscript("s1", [
      userLine(
        "<task-notification>\n" +
          "<task-id>a4bed0b03b45b4e07</task-id>\n" +
          "<status>completed</status>\n" +
          "<summary>You should always use staging again before any deploy, per policy.</summary>\n" +
          "</task-notification>",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(result.days[0].candidates.length, 0, "a background-task report must never be mined as human speech");
  });

  it("the same again+verb sentence as an ORDINARY user turn (no tag) still fires (regression pin)", async () => {
    writeTranscript("s1", [
      userLine("You should always use staging again before any deploy, per policy.", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1);
  });

  it("a role:user <agent-message> record (same harness-artifact class, packages/cli's own HARNESS_PREFIXES) never fires", async () => {
    writeTranscript("s1", [
      userLine(
        "<agent-message from=\"worker-2\">You should always use staging again before any deploy, per policy.</agent-message>",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(result.days[0].candidates.length, 0, "an inter-agent message wrapper must never be mined as human speech");
  });
});

describe("fix round 2: isMeta:true skill-injection records are never mined", () => {
  it("a role:user isMeta:true record replaying a skill's own markdown body, with an again+verb sentence, never fires", async () => {
    writeTranscript("s1", [
      metaLine(
        "# /arsave — AgentRecall Save\n\n" +
          "You should always use the shared config again instead of a local override.",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(result.days[0].candidates.length, 0, "a skill-injection record must never be mined as human speech");
  });

  it("the same text as an ORDINARY (isMeta absent) user turn still fires (regression pin)", async () => {
    writeTranscript("s1", [
      userLine(
        "# /arsave — AgentRecall Save\n\nYou should always use the shared config again instead of a local override.",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1);
  });
});

describe("fix round 2: AGAIN_MARKER word boundaries + 还是 dropped (--experimental-signals only, see fix round 3)", () => {
  it("'against' (containing the substring 'again') does not fire the again-marker signal", async () => {
    writeTranscript("s1", [
      userLine("I'm against using the old flow here, we should use the new one going forward.", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 0, "'against' must not match the \\bagain\\b marker");
  });

  it("Chinese '还是' (still/rather) + a verb does not fire — it is not a recurrence marker", async () => {
    writeTranscript("s1", [userLine("我还是觉得应该用蓝色按钮。", "09:00:00")]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 0, "还是 must be dropped entirely as a recurrence marker");
  });

  it("Chinese '仍然' + a verb in the SAME sentence still fires (regression pin)", async () => {
    writeTranscript("s1", [userLine("仍然出现这个问题，必须使用新的方案。", "09:00:00")]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1);
  });

  it("the existing English 'again' + verb fixture still fires (regression pin)", async () => {
    writeTranscript("s1", [
      userLine("You did that again — always use staging before prod deploys.", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1);
  });
});

describe("fix round 2: image-noise stripping must preserve newlines as sentence boundaries (again-marker path is --experimental-signals only, see fix round 3)", () => {
  it("an again-marker on line 1 and an unrelated verb on line 2 (no terminal punctuation) does not fire", async () => {
    writeTranscript("s1", [
      userLine("This happened again\nSeparately you should always use the new vendor for lease renewals", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    assert.equal(
      result.days[0].candidates.length,
      0,
      "collapsing the newline into a space would wrongly merge two unrelated lines into one 'sentence'",
    );
  });

  it("a multi-line turn where marker+verb DO co-occur on the SAME line still fires (regression pin)", async () => {
    writeTranscript("s1", [
      userLine(
        "Some unrelated context line about scheduling.\nThis happened again, you should always use staging first.",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 1);
  });
});

describe("fix round 2: per-sentence question exclusion applies to ALL signals", () => {
  it("signal (a): a question sentence LATER in the remainder (not just the first sentence) drops the candidate", async () => {
    writeTranscript("s1", [
      userLine(
        "No, that's wrong. Use the blue button instead of the red one. Does that make sense?",
        "09:00:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false });
    const cands = result.days[0].candidates.filter((c) => c.signal === "negation");
    assert.equal(cands.length, 0, "a trailing question anywhere in the remainder must drop the whole candidate");
  });

  it("signal (b) [experimentalSignals:true]: the marker+verb sentence itself phrased as a question drops the candidate", async () => {
    writeTranscript("s1", [
      userLine("Should we always use staging again, or does it not matter this time?", "09:00:00"),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "again");
    assert.equal(cands.length, 0);
  });

  it("signal (c) [experimentalSignals:true]: a question followed by trailing decoration (not the raw turn's literal last char) still drops the candidate", async () => {
    writeTranscript("s1", [
      userLine("Please make sure the dashboard loads under two seconds on every page.", "09:00:00"),
      userLine(
        "Make sure the dashboard loads in under two seconds on every page? -- just confirming that.",
        "09:01:00",
      ),
    ]);
    const result = await runImplicitHarvest({ date: DAY, claudeDir, write: false, experimentalSignals: true });
    const cands = result.days[0].candidates.filter((c) => c.signal === "repeat");
    assert.equal(cands.length, 0, "the old end-anchored /[?？]\\s*$/ check would have missed this");
  });
});
