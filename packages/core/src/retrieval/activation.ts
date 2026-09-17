/**
 * retrieval/activation.ts — evolution p3: ACT-R declarative memory
 * activation, `A_i = B_i + Σ_j W_j·S_ji`.
 *
 * `B_i` (base activation: recency/frequency) ALREADY EXISTS as the per-tier
 * scores every caller already computes — journal Ebbinghaus `S=2`
 * (smart-recall.ts's MATH.md §b), palace salience/IDF, insight
 * confirmation-count, rankCorrections' severity/proof_confidence/recency/
 * proof composite (corrections.ts). This module does NOT re-derive any of
 * those — it reads Phase 2's `association/edges.json`
 * (`tools-logic/association.ts`, schema `assoc-edges/v1`) and computes ONLY
 * the associative bonus `Σ_j W_j·S_ji`, `W_j = 1/|context|` (uniform),
 * `S_ji = weight · exp(-days(asOfDay − last_seen)/S_DECAY)`.
 *
 * WHAT IT IS: a cognitive-model bonus wired into TWO existing ranking
 * pipelines, both flag-gated on `AGENT_RECALL_ACTIVATION=1` (default OFF —
 * see `activationEnabled()`), following the exact template
 * `retrieval/semantic-leg.ts` (fix7) already established for an opt-in leg:
 * flag off ⇒ zero file read, zero behavior change, byte-identical output.
 *   (a) session_start correction ordering (`activationTieBreak`) — a
 *       TIE-BREAK applied strictly AFTER rankCorrections' own severity and
 *       proof_confidence keys; never reorders across a severity/confidence
 *       boundary, and the P0-always-survive budget logic downstream
 *       (session-start.ts's `applyCorrectionBudget`) is untouched — this
 *       function only reorders, never drops.
 *   (b) smart_recall post-RRF re-rank (`applyActivationRerank`) — a
 *       multiplicative boost on the fused top-K, `final_score = fused_score
 *       · (1 + ACT_ALPHA · normalized_activation)`.
 *
 * DIMENSIONAL-COHERENCE CHALLENGE (resolved, not silently mixed): (a) never
 * combines activation with `B_i` numerically — it only compares
 * `activationBonus` values against EACH OTHER to break a tie, so no
 * cross-scale summation ever happens. (b) DOES mix scales (`fused_score` is
 * an RRF-derived value on the `1/(60+r)` scale documented in MATH.md §b;
 * `S_ji` is `weight · exp(...)`, an unrelated integer-ish scale) — see
 * `applyActivationRerank`'s own doc comment for the explicit squashing
 * normalization (`x/(x+1)`) that resolves this rather than adding the two
 * incompatible scales directly (the exact class of bug smart-recall.ts's
 * own header calls "Fix 1: incompatible scales").
 *
 * HAND-TUNED (documented per MATH.md convention, see packages/core/src/
 * MATH.md §c — added alongside this module):
 *   - `S_DECAY = 30` days — chosen by feel (a month-ish co-activation
 *     memory), NOT fit to any recall/forget outcome data.
 *   - `ACT_ALPHA = 0.2` — chosen so the multiplicative boost can move a
 *     tied item by up to ×1.2 without ever vaulting a genuinely stronger
 *     fused_score item the way an uncapped multiplier could (same class of
 *     defect the hot-window boost's removal fixed, MATH.md §b) — not fit to
 *     a labeled relevance set.
 *
 * DEGRADATION CONTRACT (never throws, matches semantic-leg.ts's contract):
 * missing/corrupt/wrong-shape `edges.json` → `loadAssocGraph` returns
 * `null`; every consumer here treats `null` as "no signal", producing
 * IDENTICAL results to today plus a diagnosable reason
 * (`ActivationLegNote`, same shape family as `SemanticLegNote`).
 *
 * HOPFIELD — explicitly deferred (see this module's header once more, and
 * the evolution p3 worker report): `palace/hopfield.ts` is a dense
 * associative-memory primitive (attractor dynamics over a FULL similarity
 * matrix). The `assoc-edges/v1` graph this module reads is SPARSE by
 * construction (an edge exists only between corrections that were actually
 * co-cited — most correction pairs in a real store have no edge at all).
 * Feeding a sparse, mostly-zero adjacency into Hopfield's softmax-over-all-
 * patterns update would spend its energy attending to a near-uniform
 * distribution over non-edges, which is not the density Hopfield's
 * exponential storage-capacity argument (Ramsauer et al. 2020) assumes.
 * The linear ACT-R sum used here is the correct primitive for a sparse
 * co-activation graph; Hopfield stays a documented, not-wired-in primitive.
 */

import * as fs from "node:fs";
import {
  type AssocEdge,
  type AssocEdgesFile,
  assocNodeId,
  defaultEdgesPathFor,
  isAssocEdgesFile,
} from "../tools-logic/association.js";

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/** Opt-in env var. Default OFF — every integration point below must check
 *  this BEFORE reading any file (constraint: flag-off is byte-identical). */
export const ACTIVATION_FLAG_ENV = "AGENT_RECALL_ACTIVATION";

export function activationEnabled(): boolean {
  return process.env[ACTIVATION_FLAG_ENV] === "1";
}

// ---------------------------------------------------------------------------
// HAND-TUNED constants (see this file's header + MATH.md §c)
// ---------------------------------------------------------------------------

/** Decay half-life-ish constant (days) for S_ji = weight·exp(-days/S_DECAY). HAND-TUNED. */
export const S_DECAY = 30;

/** Multiplicative boost strength for the smart-recall integration point (2b). HAND-TUNED. */
export const ACT_ALPHA = 0.2;

/** How many of the fused/re-sorted top results the smart-recall integration re-ranks. */
const ACTIVATION_RERANK_K = 10;

// ---------------------------------------------------------------------------
// Core math (brief item 1)
// ---------------------------------------------------------------------------

export interface AssocGraph {
  /** nodeId -> Map<neighborNodeId, edge>. Undirected: every edge is
   *  indexed under BOTH endpoints. */
  adjacency: Map<string, Map<string, AssocEdge>>;
  edgeCount: number;
}

/** Pure: turns an already-parsed, already-validated edges file into the
 *  adjacency structure the math functions below consume. No fs access. */
export function adjacencyFromEdgesFile(file: AssocEdgesFile): AssocGraph {
  const adjacency = new Map<string, Map<string, AssocEdge>>();
  for (const edge of file.edges) {
    if (!adjacency.has(edge.a)) adjacency.set(edge.a, new Map());
    if (!adjacency.has(edge.b)) adjacency.set(edge.b, new Map());
    adjacency.get(edge.a)!.set(edge.b, edge);
    adjacency.get(edge.b)!.set(edge.a, edge);
  }
  return { adjacency, edgeCount: file.edges.length };
}

/**
 * Load the S_ji graph from `<storeRoot>/association/edges.json` (or an
 * explicit path override — mirrors `readAssocEdgesFile`'s own signature).
 * Missing file, unreadable file, unparseable JSON, or wrong-shape content
 * all degrade to `null` — NEVER throws. Deliberately does NOT reuse
 * `readAssocEdgesFile` (which collapses "missing" and "corrupt" into a
 * silently-empty-but-valid file) because this function's degradation
 * contract needs to tell "no graph at all" (null — callers report a
 * diagnosable reason) apart from "a real, validly-empty graph" (an
 * AssocGraph with 0 edges — a legitimate, if unusual, state after `ar assoc
 * rebuild` runs against a store with zero cited events yet).
 */
export function loadAssocGraph(storeRoot: string, explicitPath?: string): AssocGraph | null {
  const p = explicitPath ?? defaultEdgesPathFor(storeRoot);
  if (!fs.existsSync(p)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isAssocEdgesFile(parsed)) return null;
  return adjacencyFromEdgesFile(parsed);
}

/** Local-calendar-day string for "now" (matches session-start.ts's own "sv"
 *  locale convention for local-day bucketing — see e.g. its retrieved-outcome
 *  1/day dedup guard). */
export function todayDayString(): string {
  return new Date().toLocaleDateString("sv");
}

/**
 * Whole-day difference between two `YYYY-MM-DD` strings, parsed as UTC
 * midnight (so the result never drifts with the calling process's local
 * timezone — load-bearing for the eval script's determinism requirement).
 * Returns `null` on either unparseable string (degrade, never throw).
 */
function daysBetweenDayStrings(fromDay: string, toDay: string): number | null {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * S_ji = weight · exp(-days(asOfDay − last_seen) / S_DECAY). HAND-TUNED
 * S_DECAY (see this file's header). `days` is clamped at 0 (an edge whose
 * `last_seen` is AFTER `asOfDay` — should never happen given the temporal
 * split's own invariant, but this is a pure function with no knowledge of
 * its caller's discipline, so it degrades to "no decay yet" rather than
 * producing a >1 multiplier via a negative exponent). Malformed dates
 * degrade to 0 (never throw).
 */
export function assocStrength(edge: AssocEdge, asOfDay: string): number {
  const days = daysBetweenDayStrings(edge.last_seen, asOfDay);
  if (days === null) return 0;
  return edge.weight * Math.exp(-Math.max(0, days) / S_DECAY);
}

/**
 * activationBonus(i) = Σ_j (1/|context|)·S_ji, summed over context items j
 * that have an edge to i (context items without an edge to i contribute 0).
 * `graph === null` (no graph loaded) or an empty context both degrade to 0
 * — never throws, matches the module's degradation contract.
 */
export function activationBonus(
  candidateNodeId: string,
  contextNodeIds: readonly string[],
  graph: AssocGraph | null,
  asOfDay: string,
): number {
  if (!graph || contextNodeIds.length === 0) return 0;
  const neighbors = graph.adjacency.get(candidateNodeId);
  if (!neighbors) return 0;
  const w = 1 / contextNodeIds.length;
  let sum = 0;
  for (const j of contextNodeIds) {
    if (j === candidateNodeId) continue; // no self-loops in this graph by construction
    const edge = neighbors.get(j);
    if (!edge) continue;
    sum += w * assocStrength(edge, asOfDay);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Integration 2a — session_start correction ordering
// ---------------------------------------------------------------------------

export interface ActivationTieBreakOptions {
  /** Project slug — used to build `corr:<project>/<id>` node ids matching
   *  association.ts's `assocNodeId` grammar. */
  project: string;
  graph: AssocGraph | null;
  /** "as of" day (YYYY-MM-DD) for S_ji's decay term. */
  asOfDay: string;
}

interface TieBreakCandidate {
  id: string;
  severity: string;
  proof_confidence?: number;
  weight?: number;
}

function effectiveConf(r: TieBreakCandidate): number {
  return r.proof_confidence ?? r.weight ?? 0;
}

/**
 * Reorders `ranked` (already `rankCorrections()`'s output — severity ≫
 * proof_confidence ≫ recency ≫ proof_count, corrections.ts) using
 * activation as a TIE-BREAK strictly AFTER severity and proof_confidence:
 * items are first partitioned into contiguous groups sharing the SAME
 * (severity, effective proof_confidence) — rankCorrections' two
 * highest-weighted keys — and activation only reorders WITHIN a group,
 * never across one. `rankCorrections`' own recency/proof_count ordering
 * survives as the STABLE fallback: with no graph (or zero bonus for every
 * candidate) a group's relative order is preserved exactly.
 *
 * GREEDY, per the brief: `context` starts empty and grows by one node id
 * per pick (within AND across tie-classes, in output order) — so the 2nd
 * pick's activation score already "sees" the 1st pick, etc. This is a
 * simple, deterministic sequential process, not a global optimization.
 *
 * Does NOT check `activationEnabled()` itself (testable in isolation) —
 * callers (session-start.ts) must short-circuit before ever loading a graph
 * or calling this function, so flag-off has zero file reads (constraint 1).
 */
export function activationTieBreak<T extends TieBreakCandidate>(
  ranked: readonly T[],
  opts: ActivationTieBreakOptions,
): T[] {
  const { project, graph, asOfDay } = opts;
  const result: T[] = [];
  const context: string[] = [];

  let i = 0;
  while (i < ranked.length) {
    let j = i;
    while (
      j + 1 < ranked.length &&
      ranked[j + 1].severity === ranked[i].severity &&
      effectiveConf(ranked[j + 1]) === effectiveConf(ranked[i])
    ) {
      j++;
    }
    // Tie-class is ranked[i..j] — greedily reorder within it.
    const pool = ranked.slice(i, j + 1).map((r) => r); // shallow copy, original relative order preserved as pool order
    while (pool.length > 0) {
      let bestPos = 0;
      let bestScore = -Infinity;
      for (let k = 0; k < pool.length; k++) {
        const nodeId = assocNodeId(project, pool[k].id);
        const score = activationBonus(nodeId, context, graph, asOfDay);
        if (score > bestScore) {
          bestScore = score;
          bestPos = k; // first (= earliest original position) strictly-greater score wins ties
        }
      }
      const [chosen] = pool.splice(bestPos, 1);
      result.push(chosen);
      context.push(assocNodeId(project, chosen.id));
    }
    i = j + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Integration 2b — smart_recall post-RRF re-rank
// ---------------------------------------------------------------------------

/** Same shape family as `SemanticLegNote` (retrieval/semantic-leg.ts) — a
 *  typed, diagnosable, never-an-error note for an opt-in leg. */
export interface ActivationLegNote {
  enabled: boolean;
  used: boolean;
  reason: string;
}

interface RerankCandidate {
  id: string;
  score: number;
}

/**
 * Post-RRF (+ post-Beta-feedback-multiplier) re-rank of the fused top-K
 * (K=10). Mutates `results` IN PLACE over its first `min(K, results.length)`
 * entries only — items beyond K are left untouched.
 *
 * `final_score = fused_score · (1 + ACT_ALPHA · normalized_activation)`.
 *
 * NORMALIZATION (dimensional-coherence CHALLENGE, resolved — see this file's
 * header): `fused_score` lives on the RRF scale (`1/(60+r)`, MATH.md §b);
 * raw `activationBonus` lives on the `weight·exp(-days/30)` scale (roughly:
 * an integer session-count, decayed) — summing these directly would repeat
 * exactly the "Fix 1: incompatible scales" defect smart-recall.ts's own
 * header documents for the pre-RRF linear-fusion bug. Instead the raw bonus
 * is squashed through `x/(x+1)` into `[0,1)` BEFORE being used as a
 * dimensionless multiplier — bounded regardless of how large a raw edge
 * weight gets, needs no corpus-wide "max possible" scan (keeps this
 * deterministic and simple, per the brief), and is 0 exactly when the raw
 * bonus is 0 (zero signal ⇒ multiplier ⇒ ×1, an exact no-op).
 *
 * Context = the top-3 node ids BY FUSED SCORE (i.e. `results[0..2]` as they
 * stand when this function is called — the SAME top-K, not the greedy
 * growing context `activationTieBreak` uses for session_start; the brief
 * specifies this context for smart_recall independently of 2a's).
 *
 * Degradation: no graph, or zero bonus for every top-K item → `results` is
 * left COMPLETELY UNTOUCHED (not just "same order" — no mutation at all)
 * and the returned note has `used: false` with a reason.
 */
export function applyActivationRerank<T extends RerankCandidate>(
  results: T[],
  project: string,
  opts: { storeRoot: string; asOfDay?: string; graph?: AssocGraph | null },
): ActivationLegNote {
  const asOfDay = opts.asOfDay ?? todayDayString();
  const graph = opts.graph !== undefined ? opts.graph : loadAssocGraph(opts.storeRoot);
  if (!graph) {
    return { enabled: true, used: false, reason: "no association graph (run `ar assoc rebuild`)" };
  }

  const k = Math.min(ACTIVATION_RERANK_K, results.length);
  if (k === 0) {
    return { enabled: true, used: false, reason: "no candidates" };
  }

  const top = results.slice(0, k);
  const contextSize = Math.min(3, top.length);
  const context = top.slice(0, contextSize).map((it) => assocNodeId(project, it.id));

  let anyBonus = false;
  const rescored = top.map((it, idx) => {
    const nodeId = assocNodeId(project, it.id);
    const bonus = activationBonus(nodeId, context, graph, asOfDay);
    if (bonus > 0) anyBonus = true;
    const normalized = bonus / (bonus + 1); // squash — see doc comment above
    return { it, idx, finalScore: it.score * (1 + ACT_ALPHA * normalized) };
  });

  if (!anyBonus) {
    return { enabled: true, used: false, reason: "no edges among top candidates" };
  }

  rescored.sort((a, b) => b.finalScore - a.finalScore || a.idx - b.idx);
  for (let pos = 0; pos < k; pos++) {
    const { it, finalScore } = rescored[pos];
    it.score = finalScore;
    results[pos] = it;
  }
  return { enabled: true, used: true, reason: "activation-boosted top candidates" };
}
