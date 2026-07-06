/**
 * Richer graph, part 2: community detection over an ingested graph.
 *
 * Algorithm: LABEL PROPAGATION (Raghavan et al. 2007), not Louvain. Both are
 * standard; label propagation was chosen because it is near-linear, trivially
 * zero-dependency, and easy to make DETERMINISTIC. We seed every node with its
 * own label, then repeatedly re-label each node (in a fixed, stable node order)
 * to the label most common among its neighbours, breaking ties by lowest label
 * id. With a fixed order and deterministic tie-breaking the result is stable
 * across runs (no random seed). Louvain gives slightly tighter modularity but
 * needs a heavier iterative merge/refine loop; for Holt's folder-sized graphs
 * label propagation's communities are good and the code stays tiny.
 *
 * The graph is treated as UNDIRECTED. Parallel edges between the same pair count
 * as weight (edge-count-weighted), which nudges tightly-coupled files together.
 */

export interface CommunityInput {
  nodeIds: string[];
  /** Undirected edges; direction is ignored, duplicates add weight. */
  edges: Array<{ source: string; target: string }>;
}

export interface CommunityResult {
  /** node id -> community id (a small, dense integer as a string). */
  community: Map<string, string>;
  /** community id -> member node ids (in stable node order). */
  members: Map<string, string[]>;
  /** community id -> member count. */
  sizes: Map<string, number>;
  count: number;
}

const MAX_ITERS = 30;

/** Detect communities via deterministic label propagation. */
export function detectCommunities(input: CommunityInput): CommunityResult {
  const { nodeIds, edges } = input;

  // Stable node order = the order given. Index for O(1) neighbour weights.
  const order = nodeIds.slice();
  const idx = new Map<string, number>();
  order.forEach((id, i) => idx.set(id, i));

  // Weighted adjacency: neighbour id -> summed edge weight.
  const adj: Array<Map<number, number>> = order.map(() => new Map());
  for (const e of edges) {
    const a = idx.get(e.source);
    const b = idx.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const am = adj[a] as Map<number, number>;
    const bm = adj[b] as Map<number, number>;
    am.set(b, (am.get(b) || 0) + 1);
    bm.set(a, (bm.get(a) || 0) + 1);
  }

  // Seed: each node in its own community (label = its own index).
  const label = order.map((_, i) => i);

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let changed = false;
    // Fixed ascending order for determinism (no randomized visit order).
    for (let i = 0; i < order.length; i++) {
      const neigh = adj[i] as Map<number, number>;
      if (neigh.size === 0) continue; // isolated node keeps its own label
      // Tally neighbour labels by summed weight.
      const tally = new Map<number, number>();
      for (const [j, w] of neigh) {
        const lj = label[j] as number;
        tally.set(lj, (tally.get(lj) || 0) + w);
      }
      // Pick the max-weight label; break ties by the lowest label id (stable).
      let best = label[i] as number;
      let bestW = -1;
      for (const [lab, w] of tally) {
        if (w > bestW || (w === bestW && lab < best)) { best = lab; bestW = w; }
      }
      if (best !== label[i]) { label[i] = best; changed = true; }
    }
    if (!changed) break;
  }

  // Compact raw labels into dense community ids "0","1",... assigned in order of
  // first appearance, so ids are stable and small.
  const remap = new Map<number, string>();
  const community = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (let i = 0; i < order.length; i++) {
    const raw = label[i] as number;
    let cid = remap.get(raw);
    if (cid === undefined) { cid = String(remap.size); remap.set(raw, cid); }
    const id = order[i] as string;
    community.set(id, cid);
    const arr = members.get(cid);
    if (arr) arr.push(id);
    else members.set(cid, [id]);
  }

  const sizes = new Map<string, number>();
  for (const [cid, arr] of members) sizes.set(cid, arr.length);

  return { community, members, sizes, count: members.size };
}
