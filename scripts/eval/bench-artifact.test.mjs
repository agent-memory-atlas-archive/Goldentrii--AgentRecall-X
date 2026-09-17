// scripts/eval/bench-artifact.test.mjs
//
// Regression test for the "vacuous verification" defect (evolution P0 W1):
// verifyBaseline() for rmr-baseline/v1 and rmr-baseline/v2 schemas is a
// PARSE-ONLY check ("Nothing to recompute for these schemas" — no per_item
// to recompute metrics from) yet run-bench.mjs rendered it as
// "verifyBaseline: OK", byte-identical to a genuinely recomputed
// (corpus_hash + headline-metric) verification of a bench-result/v1
// baseline. A reader of the bench output could not tell the two apart.
//
// This file asserts:
//   1. verifyBaseline() itself reports which mode it ran in (`mode`).
//   2. The actual rendered CLI output (run-bench.mjs --verify-baselines)
//      visually distinguishes parse-only lines from recomputed lines.
//
// Run: node --test scripts/eval/bench-artifact.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBaseline } from "./bench-artifact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_BENCH = path.join(HERE, "run-bench.mjs");
const BASELINES_DIR = path.join(HERE, "baselines");

// ---------------------------------------------------------------------------
// Unit level: verifyBaseline() return value must self-report its mode.
// ---------------------------------------------------------------------------

test("verifyBaseline() labels a parse-only rmr-baseline/v1 pass distinctly from a recomputed pass", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-artifact-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Minimal synthetic rmr-baseline/v1 artifact — no per_item, nothing to recompute.
  const rmrFile = path.join(tmpDir, "rmr-baseline-synthetic.json");
  fs.writeFileSync(
    rmrFile,
    JSON.stringify({ schema_version: "rmr-baseline/v1", pooled: { n_total: 3 } }),
  );

  const rmrResult = verifyBaseline(rmrFile);
  assert.equal(rmrResult.ok, true);
  // The defect: pre-fix, this field does not exist, so the assertion below
  // fails — proving the caller (run-bench.mjs) has no signal to distinguish
  // a parse-only pass from a recomputed one.
  assert.equal(
    rmrResult.mode,
    "parse-only",
    "rmr-baseline/v1 has no per_item to recompute from — verifyBaseline must self-report mode='parse-only'",
  );

  // A genuinely recomputed schema (bench-result/v1, correction-transfer) must
  // report the opposite mode, proving the label is not a blanket constant.
  const realBaseline = path.join(BASELINES_DIR, "correction-transfer-fixture-baseline.json");
  const recomputedResult = verifyBaseline(realBaseline);
  assert.equal(recomputedResult.ok, true);
  assert.equal(
    recomputedResult.mode,
    "recomputed",
    "bench-result/v1 (correction-transfer) DOES recompute corpus_hash + headline metrics — mode must be 'recomputed'",
  );
});

test("verifyBaseline() also labels rmr-baseline/v2 as parse-only", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-artifact-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const rmrFile = path.join(tmpDir, "rmr-baseline-v2-synthetic.json");
  fs.writeFileSync(
    rmrFile,
    JSON.stringify({ schema_version: "rmr-baseline/v2", pooled: { n_total: 3 }, c3_verdict_coverage: 1 }),
  );

  const result = verifyBaseline(rmrFile);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "parse-only");
});

// ---------------------------------------------------------------------------
// End-to-end level: the ACTUAL bench output a human reads must be visually
// distinct for parse-only vs recomputed baselines. This is the defect as
// experienced by a reader of `run-bench.mjs --verify-baselines` output —
// the two repo-committed rmr-baseline-*.json files are real fixtures on
// disk (not synthesized here), so this exercises the real rendering path.
// ---------------------------------------------------------------------------

test("run-bench.mjs --verify-baselines renders parse-only baselines distinctly from recomputed ones", () => {
  const stdout = execFileSync("node", [RUN_BENCH, "--verify-baselines"], {
    encoding: "utf-8",
  });

  const lines = stdout.split("\n").filter((l) => l.includes("verifyBaseline:"));
  assert.ok(lines.length > 0, "expected at least one verifyBaseline: line in output");

  const rmrLines = lines.filter((l) => l.includes("rmr-baseline-"));
  const recomputedLines = lines.filter((l) => l.includes("correction-transfer-"));

  assert.ok(rmrLines.length >= 2, "expected rmr-baseline-2026-07-02.json and -03.json lines");
  assert.ok(recomputedLines.length >= 1, "expected at least one correction-transfer-*.json line");

  for (const line of rmrLines) {
    assert.match(
      line,
      /verifyBaseline: PARSE-ONLY \(schema has no recomputable metrics\)/,
      `rmr-baseline line must be labeled PARSE-ONLY, got: ${line}`,
    );
  }

  for (const line of recomputedLines) {
    assert.match(line, /verifyBaseline: OK\b/, `recomputed line must keep OK label, got: ${line}`);
    assert.doesNotMatch(line, /PARSE-ONLY/, `recomputed line must NOT say PARSE-ONLY, got: ${line}`);
  }

  // The core defect assertion: the two categories of lines, modulo filename,
  // must NOT be textually identical in their "verifyBaseline: ..." prefix.
  // Strip the trailing filename (the only part expected to differ per-file)
  // and compare what remains.
  const stripFilename = (line) => line.replace(/\S+\.json\s*$/, "").trim();
  const rmrPrefix = stripFilename(rmrLines[0]);
  const recomputedPrefix = stripFilename(recomputedLines[0]);
  assert.notEqual(
    rmrPrefix,
    recomputedPrefix,
    "parse-only and recomputed verifyBaseline lines must have visually distinct prefixes",
  );
});
