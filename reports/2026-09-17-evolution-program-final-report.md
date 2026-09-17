# Evolution Program P0–P4 — Final Report

**Date:** 2026-09-17 · **Branch:** `evolution-p0-p4` (9 commits + this doc, main @ 4bed4dc → fd67e4f release) · **Version:** 3.4.50 → **3.4.51** (patch, local only — push/npm publish owner-gated)
**Duration:** 12:50:40 → 20:48:14 (+0200) = **7 h 57 m** · **Subagent tokens:** 5,630,624 (mandate) + 557,195 (pre-mandate repo understanding) = **6,187,819** across 42 Sonnet-5 subagents in 12 workflows (orchestrator main-loop tokens not separately metered)
**Method:** plywood-compiled briefs → Sonnet 5 workers → independent Sonnet 5 reviewers → fixers → independent verifiers. Every phase committed only after independent verification. Zero pushes, zero publishes, zero deletions.

## What changed (77 files, +13,591 / −253)

| Commit | Phase | Delivered |
|---|---|---|
| 7ff7af4 | P0 | Instrument honesty: bench PARSE-ONLY labeling (vacuous-verify fix); harness-kit multi-record drop + rule_date=None blind-spot surfaced; `evolution-baseline.mjs` denominator snapshot (read-only, deterministic) |
| c59f04d | P1a | `ar outcomes audit` — transcript-grounded injection adjudication (recurred > cited > ignored), ledger-only kinds gated on `transcript-audit:` evidence, idempotent, adjudication independent of the agent's own summary |
| c886b3c | P1b | `ar corrections harvest-implicit` — implicit correction miner; 3 precision rounds against real transcripts (≤5% → 28% → 100%); shipped default = negation-opener signal only; (b)/(c) behind `--experimental-signals` |
| ef3fcda | P1c | evolution-baseline **v2**: audit events/wk, injection_precision, implicit counts, injection-outcome coverage (dual denominators, null-never-0) |
| 725684d | P2 | `ar assoc` — Hebbian co-activation ledger (S_ji): undirected correction graph from cited events, weight = distinct sessions, deterministic rebuild, DEGENERATE probe |
| 01ae440 | P3 | ACT-R activation leg `A_i = B_i + Σ W_j·S_ji`, flag-gated (`AGENT_RECALL_ACTIVATION=1`, OFF = byte-identical, fs-probe-verified); temporal-split counterfactual eval with claim gates; MATH.md §c (HAND-TUNED S_DECAY=30, ACT_ALPHA=0.2); Hopfield deferral documented |
| f8b2bf6 | P4 | `ar corrections retier` — gate/nudge/watch ladder, auto-demotion (not_violated plateau, 90d staleness), owner-gated promote/archive proposals, tier tag in all 3 renderers (additivity byte-proven) |
| fd67e4f | rel | v3.4.51 across 4 packages + types.ts VERSION (version-consistency test caught the constant I missed) |

Suites at HEAD: core 1856+/1856+, cli 293/293, mcp-server 79/79, root `npm test` exit 0, lint clean, bench fixture lane green.

## Live-store harvest (backup first: `~/.agent-recall/backups/corrections-pre-evolution-harvest.tar.gz.bak-20260917`, 198 files)

- Audit backfill 2026-08-01→09-17: **+45 adjudication events** (15 cited / 23 ignored / 7 recurred), idempotency proven (ledger 1633 = 1633 on re-run). 7 days had no transcripts; 101/195 sessions unattributable to a project.
- Implicit harvest: **+1 genuine correction** (a business-scope rule) — precision-first by design.
- `ar assoc rebuild`: 15 cited events → **5 nodes, 6 edges — DEGENERATE (all weight=1)**, probe fired honestly.
- `ar corrections retier --write`: **61 corrections tiered: gate=8 / nudge=23 / watch=29–30, 3 auto-demotions** (stale P0s from May), re-run writes 0 (idempotent). Promote/archive proposals: 0/0 today.

## Exit-condition scorecard (measured, not promised)

| Phase | Target | Result |
|---|---|---|
| P0 | 3 instrument fixes + baseline | ✅ |
| P1a | coverage ≥50% achievable; events ≥10× | ❌ **40.6%** achievable (41/101; theoretical 7.4%); adjudication events ≈2× on backfill. Cause: transcript retention gaps + project-attribution failures — producer wired, needs forward accumulation + attribution fix |
| P1b | precision ≥60% shipped default | ✅ 1/1 on 48d window (n=1, thin, flagged) |
| P1 new metric | injection_precision | **0.444** — first-ever measurement (was unmeasurable) |
| P2 | non-degenerate edge distribution | ❌ graph exists, DEGENERATE at current density — needs forward data |
| P3 | flag-off identical + honest eval | ✅ byte-identical; live eval prints CANNOT CLAIM (n=0) — uplift claim correctly blocked; fixture proves pipeline (MRR .25→.333) |
| P4 | all tiered + ≥1 auto-demotion | ✅ 61 tiered, 3 demotions, idempotent |

The program's own honest headline: **machinery is now fully wired and verified; density remains the ceiling — exactly as the roadmap predicted.** The difference from every previous cycle: the producers (audit / implicit / edges) now exist and accumulate with each day of use, and the ladder demonstrably relaxes rules instead of only accumulating them.

## Owner follow-ups (gated / decisions)

1. **Merge + push + npm publish 3.4.51** — REDLINE, awaiting your call. Branch left unmerged for review.
2. **Wire the producers into the nightly dream cron** (AAM infra): `ar outcomes audit --date yesterday` + `ar corrections harvest-implicit --date yesterday --write` + `ar assoc rebuild` + weekly `ar corrections retier --write`. Without this, P1/P2/P3 stay starved.
3. Project-attribution gap (101/195 sessions "auto") is now the biggest coverage killer — candidate next fix.
4. baseline v2 `association_edges` still prints the v1 constant 0 (real value: 6) — small follow-up.
5. Bedrock silently falls back to the session model when a short model alias fails to resolve (`sonnet`, `claude-sonnet-5`, even `CLAUDE_CODE_SUBAGENT_MODEL`) — only `global.anthropic.claude-sonnet-5` lands. Same class as "no silent param discard"; dispatch-model-guard could verify the landed model.
6. `/arreflect` overdue (18 sessions ≥ K=10).

## Plywood feedback (dogfood, 9 briefs compiled, all sop_ids fed back)

- **The frame is the product, the body is noise.** Kept in 9/9 dispatches: ROLE / CONTEXT / CONSTRAINTS / CHALLENGE / ESCALATION / OUTPUT-TO. Replaced in 9/9: the scaffold pseudo-code body (corpus-wide: generic-EXECUTE-scaffold kept 0 / replaced 10). Router misfires confirmed twice (signal miner → competitive-pricing-research; metrics script → ci-pipeline-setup). **Recommendation: for novel goals, stop emitting pseudo-code bodies; emit the six frame sections + an explicit `BODY: orchestrator-authored` slot.** That gives the orchestrator the clear path you want: plywood owns the contract frame, orchestrator owns the SOP body.
- **CHALLENGE is the highest-value clause, again**: fired 5/9, every firing real — including catching MY brief errors twice (parallel-dispatch "already landed" wording; degenerate cited-bar). Corpus hit-rate 27.9%; this program ~56%.
- **Compiler bug**: negation phrases in goals get extracted into garbled invariants ("DO NOT alarm", "DO NOT a point estimate") — 2 confirmed instances; fix the negation-extraction or drop auto-ASSERT_INVARIANT.
- **New template candidates** proven here: (a) build→independent-review→fix→verify phase pipeline (used 6×, caught something real every time); (b) mandatory live-data precision-sampling acceptance for any extractor/miner (saved W1b three times — no fixture-only test would have caught 5%-precision junk); (c) parallel-dispatch wording rule: sibling work = "concurrent, uncommitted", never "landed".
- **Loop-closure gap**: workers dutifully emitted SOP_ID/FEEDBACK_HINTS epilogues but nothing ingests them — I called plywood_feedback manually 9×. A `plywood_feedback --from-report <path>` would mechanize it.
