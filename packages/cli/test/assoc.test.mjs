/**
 * assoc.test.mjs
 *
 * Evolution p2 — `ar assoc rebuild` / `ar assoc stats` CLI wiring (new
 * top-level `case "assoc":`). Core logic (grouping/weighting/determinism) is
 * covered in packages/core/test/association.test.mjs — this file covers the
 * CLI surface: --help, --store/--out/--dry-run/--json flags, the rendered
 * human tables, and the exact "DEGENERATE: <reason>" probe string on a thin
 * fixture end-to-end.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

const TEST_ROOT = path.join(os.tmpdir(), `ar-assoc-cli-root-${Date.now()}`);
const PROJECT = "assoc-cli-test";
const DAY = "2026-07-01";

function corrDir(project = PROJECT) {
  return path.join(TEST_ROOT, "projects", project, "corrections");
}
function outcomesFile(project = PROJECT) {
  return path.join(corrDir(project), "_outcomes.jsonl");
}
function appendOutcome(evt, project = PROJECT) {
  fs.mkdirSync(corrDir(project), { recursive: true });
  fs.appendFileSync(outcomesFile(project), JSON.stringify(evt) + "\n", "utf-8");
}
function cited({ correctionId, at, evidence, sessionId, project = PROJECT }) {
  return {
    correction_id: correctionId,
    project,
    kind: "cited",
    at,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  };
}
function isoFor(day) {
  return `${day}T12:00:00.000Z`;
}

async function runCli(...args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], { timeout: 15000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e) {
    return { stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim(), exitCode: e.code ?? 1 };
  }
}

describe("ar assoc — CLI wiring (evolution p2)", () => {
  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("--help documents rebuild and stats", async () => {
    const { stdout, exitCode } = await runCli("assoc", "--help");
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("ar assoc rebuild"));
    assert.ok(stdout.includes("ar assoc stats"));
    assert.ok(stdout.includes("DEGENERATE:"));
  });

  it("top-level help mentions the assoc command group", async () => {
    const { stdout, exitCode } = await runCli("--help");
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("ar assoc rebuild"));
    assert.ok(stdout.includes("ar assoc stats"));
  });

  it("rejects an unknown assoc subcommand", async () => {
    const { stderr, exitCode } = await runCli("assoc", "bogus", "--store", TEST_ROOT);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("Unknown assoc subcommand"));
    assert.ok(stderr.includes("agent_instruction"));
  });

  it("stats on an empty/never-rebuilt store degrades gracefully (DEGENERATE, no crash)", async () => {
    const emptyStore = path.join(os.tmpdir(), `ar-assoc-cli-empty-${Date.now()}`);
    const { stdout, exitCode } = await runCli("assoc", "stats", "--store", emptyStore);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("nodes: 0"));
    assert.ok(stdout.includes("edges: 0"));
    assert.ok(stdout.includes("DEGENERATE: fewer than 5 edges (0 found)"));
    fs.rmSync(emptyStore, { recursive: true, force: true });
  });

  it("--dry-run computes and prints a correct summary without writing edges.json", async () => {
    appendOutcome(cited({ correctionId: "c1", at: isoFor(DAY), sessionId: "s1" }));
    appendOutcome(cited({ correctionId: "c2", at: isoFor(DAY), sessionId: "s1" }));

    const edgesPath = path.join(TEST_ROOT, "association", "edges.json");
    assert.equal(fs.existsSync(edgesPath), false);

    const { stdout, exitCode } = await runCli("assoc", "rebuild", "--store", TEST_ROOT, "--dry-run");
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("DRY-RUN"));
    assert.ok(stdout.includes("nodes: 2"));
    assert.ok(stdout.includes("edges: 1"));
    assert.ok(/groups: 1 \(session_id=1, transcript_basename=0, project_day=0\)/.test(stdout));
    assert.equal(fs.existsSync(edgesPath), false, "--dry-run must not write edges.json");
  });

  it("--json rebuild emits machine-readable output with the same summary", async () => {
    const { stdout, exitCode } = await runCli("assoc", "rebuild", "--store", TEST_ROOT, "--dry-run", "--json");
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.dry_run, true);
    assert.equal(result.written, false);
    assert.equal(result.file.nodes, 2);
    assert.equal(result.file.edges.length, 1);
    assert.equal(result.file.edges[0].weight, 1);
  });

  it("without --dry-run, actually writes edges.json, and a second rebuild is byte-identical", async () => {
    const first = await runCli("assoc", "rebuild", "--store", TEST_ROOT);
    assert.equal(first.exitCode, 0);
    assert.ok(!first.stdout.includes("DRY-RUN"));

    const edgesPath = path.join(TEST_ROOT, "association", "edges.json");
    assert.ok(fs.existsSync(edgesPath));
    const bytes1 = fs.readFileSync(edgesPath, "utf-8");

    const second = await runCli("assoc", "rebuild", "--store", TEST_ROOT);
    assert.equal(second.exitCode, 0);
    const bytes2 = fs.readFileSync(edgesPath, "utf-8");
    assert.equal(bytes1, bytes2, "rebuild must be byte-identical across CLI reruns over the same ledger");
  });

  it("supports a custom --out path", async () => {
    const customOut = path.join(TEST_ROOT, "custom", "edges.json");
    const { exitCode } = await runCli("assoc", "rebuild", "--store", TEST_ROOT, "--out", customOut);
    assert.equal(exitCode, 0);
    assert.ok(fs.existsSync(customOut));
  });

  it("stats renders the human table for the 1-edge fixture (still DEGENERATE — fewer than 5 edges)", async () => {
    const { stdout, exitCode } = await runCli("assoc", "stats", "--store", TEST_ROOT);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("nodes: 2"));
    assert.ok(stdout.includes("edges: 1"));
    assert.ok(stdout.includes("weight histogram: 1=1"));
    assert.ok(stdout.includes("DEGENERATE: fewer than 5 edges (1 found)"));
    assert.ok(stdout.includes("top edges:"));
  });

  it("stats --json emits the same degenerate reason and top_edges", async () => {
    const { stdout, exitCode } = await runCli("assoc", "stats", "--store", TEST_ROOT, "--json");
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.node_count, 2);
    assert.equal(result.edge_count, 1);
    assert.equal(result.degenerate, "fewer than 5 edges (1 found)");
    assert.equal(result.top_edges.length, 1);
  });
});

describe("ar assoc stats — healthy (non-degenerate) graph end-to-end", () => {
  const ROOT = path.join(os.tmpdir(), `ar-assoc-cli-healthy-${Date.now()}`);
  const PROJ = "assoc-healthy";

  before(async () => {
    function appendOn(project, evt) {
      const dir = path.join(ROOT, "projects", project, "corrections");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "_outcomes.jsonl"), JSON.stringify(evt) + "\n", "utf-8");
    }
    // 5 disjoint pairs with DIFFERENT weights (1..5) so the graph is healthy
    // (>=5 edges, not all-equal weight) — pairs are (a1,b1) cited N times.
    const pairs = [
      ["a1", "b1", 5],
      ["a2", "b2", 4],
      ["a3", "b3", 3],
      ["a4", "b4", 2],
      ["a5", "b5", 1],
    ];
    let day = 1;
    for (const [a, b, times] of pairs) {
      for (let i = 0; i < times; i++) {
        const d = `2026-07-${String(day).padStart(2, "0")}`;
        const sid = `sid-${a}-${b}-${i}`;
        appendOn(PROJ, cited({ correctionId: a, at: isoFor(d), sessionId: sid, project: PROJ }));
        appendOn(PROJ, cited({ correctionId: b, at: isoFor(d), sessionId: sid, project: PROJ }));
        day++;
      }
    }
    const { exitCode } = await runCli("assoc", "rebuild", "--store", ROOT);
    assert.equal(exitCode, 0);
  });

  after(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("is NOT degenerate and top edge is the weight=5 pair", async () => {
    const { stdout, exitCode } = await runCli("assoc", "stats", "--store", ROOT, "--json");
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.edge_count, 5);
    assert.equal(result.degenerate, null);
    assert.equal(result.top_edges[0].weight, 5);
    assert.deepEqual(result.degree_distribution, { min: 1, median: 1, p90: 1, max: 1 });
  });

  it("human render has no DEGENERATE line", async () => {
    const { stdout, exitCode } = await runCli("assoc", "stats", "--store", ROOT);
    assert.equal(exitCode, 0);
    assert.ok(!stdout.includes("DEGENERATE"));
  });
});
