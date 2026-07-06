/**
 * Richer graph, part 3: the god-node report. Given an ingested + community-tagged
 * graph, render a generic GRAPH_REPORT.md in the spirit of graphify: node / edge /
 * community counts, the highest-degree "god nodes" with their community, and a
 * per-community summary (size + representative files). Pure string generation,
 * zero dependencies, safe on empty input.
 */
import type { Graph, GraphNode } from './graphview';

export interface ReportMeta {
  workspace: string;
  generatedAt?: number; // epoch ms; defaults to now
}

const TOP_GOD_NODES = 12;
const REP_PER_COMMUNITY = 6;

function degrees(graph: Graph): Map<string, number> {
  const idSet = new Set(graph.nodes.map((n) => n.id));
  const deg = new Map<string, number>();
  for (const n of graph.nodes) deg.set(n.id, 0);
  for (const e of graph.edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    deg.set(e.source, (deg.get(e.source) || 0) + 1);
    deg.set(e.target, (deg.get(e.target) || 0) + 1);
  }
  return deg;
}

/** Label used for a node in the report: file path for files/docs, else the label. */
function reportLabel(n: GraphNode): string {
  return n.path || n.label || n.id;
}

/** Build the GRAPH_REPORT.md text for a (typically ingested + community) graph. */
export function renderReport(graph: Graph, meta: ReportMeta): string {
  const date = new Date(meta.generatedAt ?? Date.now()).toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Graph Report - ${meta.workspace}  (${date})`);
  lines.push('');

  if (graph.nodes.length === 0) {
    lines.push('## Summary');
    lines.push('- 0 nodes, 0 edges, 0 communities.');
    lines.push('- Nothing to ingest here yet. Run `holt graph --code` or `holt graph --docs`');
    lines.push('  in a folder with source or docs, then `holt graph report`.');
    lines.push('');
    return lines.join('\n') + '\n';
  }

  const deg = degrees(graph);
  const idSet = new Set(graph.nodes.map((n) => n.id));
  const validEdges = graph.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

  // Communities (from node.community stamps; default all to "0" if unassigned).
  const commMembers = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    const cid = n.community ?? '0';
    const arr = commMembers.get(cid);
    if (arr) arr.push(n);
    else commMembers.set(cid, [n]);
  }
  const communityCount = commMembers.size;

  // ---- summary ----
  const fileCount = graph.nodes.filter((n) => n.kind === 'file').length;
  const docCount = graph.nodes.filter((n) => n.kind === 'doc').length;
  lines.push('## Summary');
  lines.push(`- ${graph.nodes.length} nodes, ${validEdges.length} edges, ${communityCount} communities detected`);
  lines.push(`- Ingested: ${fileCount} code files, ${docCount} docs`);
  lines.push('- Community algorithm: label propagation (deterministic, zero dependency)');
  lines.push('');

  // ---- god nodes ----
  lines.push('## God Nodes (most connected - your core files)');
  const ranked = graph.nodes
    .slice()
    .sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0) || reportLabel(a).localeCompare(reportLabel(b)))
    .filter((n) => (deg.get(n.id) || 0) > 0)
    .slice(0, TOP_GOD_NODES);
  if (ranked.length === 0) {
    lines.push('- None: no nodes have any edges yet (nothing links to anything).');
  } else {
    ranked.forEach((n, i) => {
      const d = deg.get(n.id) || 0;
      const cid = n.community ?? '0';
      lines.push(`${i + 1}. \`${reportLabel(n)}\` - ${d} edges (community ${cid})`);
    });
  }
  lines.push('');

  // ---- communities ----
  lines.push('## Communities');
  const sortedComms = [...commMembers.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  for (const [cid, members] of sortedComms) {
    lines.push('');
    lines.push(`### Community ${cid} (${members.length} nodes)`);
    // Representatives = highest-degree members (a community's "hubs").
    const reps = members
      .slice()
      .sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0) || reportLabel(a).localeCompare(reportLabel(b)))
      .slice(0, REP_PER_COMMUNITY)
      .map((n) => reportLabel(n));
    const extra = members.length - reps.length;
    const shown = reps.join(', ');
    lines.push(`Representative: ${shown}${extra > 0 ? ` (+${extra} more)` : ''}`);
  }
  lines.push('');

  return lines.join('\n') + '\n';
}
