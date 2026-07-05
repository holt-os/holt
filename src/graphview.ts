/**
 * Phase 4: the knowledge graph view. Turns your private memory into a picture you
 * can walk. Pure generation only: buildGraph() turns MemTurn[] into nodes + edges,
 * renderGraphHtml() returns a fully self-contained HTML page (inline CSS, vanilla
 * JS, no CDN, no external fonts, zero runtime deps). The browser does the physics.
 */
import type { MemTurn } from './memory';

export type NodeKind = 'turn' | 'concept' | 'wiki';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  // turn-only
  role?: 'user' | 'assistant' | 'fact';
  session?: string;
  ts?: number;
  content?: string;
  // concept-only
  freq?: number;
}

export type EdgeKind = 'sequential' | 'semantic' | 'concept' | 'wikilink';

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  width: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphMeta {
  workspace: string;
  turns: number;
  sessions: number;
  concepts: number;
  edges: number;
}

// About 60 common English words. Enough to keep concept extraction from filling up
// with "with", "that", "have" and other noise.
const STOPWORDS = new Set([
  'the', 'and', 'that', 'have', 'this', 'with', 'from', 'they', 'what', 'when',
  'your', 'would', 'there', 'their', 'will', 'about', 'which', 'them', 'then',
  'than', 'were', 'been', 'being', 'into', 'over', 'some', 'such', 'only', 'also',
  'because', 'these', 'those', 'here', 'more', 'most', 'other', 'want', 'need',
  'like', 'just', 'make', 'made', 'does', 'done', 'each', 'very', 'much', 'many',
  'could', 'should', 'shall', 'must', 'might', 'even', 'still', 'while', 'where',
  'good', 'know', 'take', 'them', 'thing', 'things', 'okay', 'yeah', 'sure',
  'help', 'please', 'thanks', 'lets',
]);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function firstLine(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

const SEMANTIC_MIN = 0.55; // cosine floor for a semantic edge
const SEMANTIC_PAIR_CAP = 300; // keep only the strongest N semantic pairs
const SEMANTIC_TURN_CAP = 2000; // skip the O(n^2) pass entirely above this many turns
const CONCEPT_CAP = 40; // at most this many concept nodes
const CONCEPT_MIN_TURNS = 2; // a concept must appear in at least this many distinct turns

/** Build nodes + edges from raw memory turns. */
export function buildGraph(turns: MemTurn[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // ---- turn nodes ----
  for (const t of turns) {
    nodes.push({
      id: t.id,
      kind: 'turn',
      label: firstLine(t.content),
      role: t.role,
      session: t.session,
      ts: t.ts,
      content: t.content,
    });
  }

  // ---- sequential edges (weak) within each session, in stored order ----
  const bySession = new Map<string, MemTurn[]>();
  for (const t of turns) {
    const arr = bySession.get(t.session);
    if (arr) arr.push(t);
    else bySession.set(t.session, [t]);
  }
  for (const arr of bySession.values()) {
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1] as MemTurn;
      const cur = arr[i] as MemTurn;
      edges.push({ source: prev.id, target: cur.id, kind: 'sequential', width: 1 });
    }
  }

  // ---- semantic edges (strong) between turns that both carry an embedding ----
  if (turns.length <= SEMANTIC_TURN_CAP) {
    const withEmb = turns.filter((t) => Array.isArray(t.emb) && t.emb.length > 0);
    const pairs: Array<{ source: string; target: string; sim: number }> = [];
    for (let i = 0; i < withEmb.length; i++) {
      const a = withEmb[i] as MemTurn;
      for (let j = i + 1; j < withEmb.length; j++) {
        const b = withEmb[j] as MemTurn;
        const sim = cosine(a.emb as number[], b.emb as number[]);
        if (sim >= SEMANTIC_MIN) pairs.push({ source: a.id, target: b.id, sim });
      }
    }
    pairs.sort((x, y) => y.sim - x.sim);
    for (const p of pairs.slice(0, SEMANTIC_PAIR_CAP)) {
      // width scales 1.5..5 across the 0.55..1.0 similarity band
      const width = 1.5 + ((p.sim - SEMANTIC_MIN) / (1 - SEMANTIC_MIN)) * 3.5;
      edges.push({ source: p.source, target: p.target, kind: 'semantic', width: Math.round(width * 100) / 100 });
    }
  }

  // ---- concept nodes + concept-to-turn edges ----
  // Count in how many DISTINCT turns each word appears, and remember which turns.
  const conceptTurns = new Map<string, Set<string>>();
  for (const t of turns) {
    for (const w of new Set(words(t.content))) {
      const set = conceptTurns.get(w);
      if (set) set.add(t.id);
      else conceptTurns.set(w, new Set([t.id]));
    }
  }
  const concepts = [...conceptTurns.entries()]
    .filter(([, ids]) => ids.size >= CONCEPT_MIN_TURNS)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, CONCEPT_CAP);

  for (const [word, ids] of concepts) {
    const cid = 'concept:' + word;
    nodes.push({ id: cid, kind: 'concept', label: word, freq: ids.size });
    for (const turnId of ids) {
      edges.push({ source: cid, target: turnId, kind: 'concept', width: 1 });
    }
  }

  return { nodes, edges };
}

/**
 * A minimal wiki page for graph rendering: a title, a slug, and its outgoing
 * [[links]] (already resolved to target titles). Kept structural so this module
 * stays free of fs/config imports.
 */
export interface WikiGraphPage {
  slug: string;
  title: string;
  links: string[]; // [[Title]] or [[slug]] targets as written on the page
}

/**
 * Build wiki nodes + [[link]] edges. Additive: merge the result into a memory
 * graph with mergeGraphs(), or render it alone. A page is one node; each
 * resolved wikilink is one 'wikilink' edge. Unresolved links are dropped (no
 * dangling edges). Node ids are namespaced "wiki:<slug>" so they never collide
 * with turn/concept ids.
 */
export function buildWikiGraph(pages: WikiGraphPage[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Index by both slug and lowercased title so [[Title]] and [[slug]] both resolve.
  const byKey = new Map<string, WikiGraphPage>();
  for (const p of pages) {
    byKey.set(p.slug.toLowerCase(), p);
    byKey.set(p.title.toLowerCase(), p);
  }

  for (const p of pages) {
    nodes.push({ id: 'wiki:' + p.slug, kind: 'wiki', label: p.title });
  }
  for (const p of pages) {
    const seen = new Set<string>();
    for (const raw of p.links) {
      const target = byKey.get(raw.toLowerCase());
      if (!target || target.slug === p.slug) continue;
      const key = target.slug;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: 'wiki:' + p.slug, target: 'wiki:' + target.slug, kind: 'wikilink', width: 2 });
    }
  }
  return { nodes, edges };
}

/** Merge two graphs, de-duplicating nodes by id. Edges are concatenated. */
export function mergeGraphs(a: Graph, b: Graph): Graph {
  const seen = new Set(a.nodes.map((n) => n.id));
  const nodes = [...a.nodes];
  for (const n of b.nodes) if (!seen.has(n.id)) { nodes.push(n); seen.add(n.id); }
  return { nodes, edges: [...a.edges, ...b.edges] };
}

/** Escape a string so it can sit safely inside a JSON <script> block. */
function escapeForScript(json: string): string {
  // The JSON is already valid; the only sequence that can break out of a
  // <script> element is the literal "</script" (and by symmetry "<!--").
  // "\/" is a valid JSON escape, but "\!" is NOT, so break the "<!--" token
  // with a JSON-valid unicode escape for "!" (!) instead.
  return json.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\u0021--');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render the complete, self-contained HTML page for a graph. */
export function renderGraphHtml(graph: Graph, meta: GraphMeta): string {
  const dataJson = escapeForScript(JSON.stringify(graph));
  const wsSafe = escapeHtml(meta.workspace);

  // Note: no em-dash characters anywhere in this template or the embedded JS.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Holt memory graph</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --text: #e7e9ee;
    --muted: #9aa3b2;
    --amber: #f0b91e;
    --cyan: #35d0d6;
    --violet: #9a8cff;
    --line: #232733;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text); overflow: hidden;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased;
  }
  header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 5;
    display: flex; align-items: center; gap: 16px;
    padding: 10px 16px; background: rgba(15,17,21,0.82);
    border-bottom: 1px solid var(--line); backdrop-filter: blur(6px);
  }
  .wordmark { color: var(--amber); font-weight: 700; font-size: 18px; letter-spacing: 1px; }
  .ws { color: var(--muted); font-size: 12px; max-width: 34vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stats { color: var(--muted); font-size: 12px; margin-left: auto; }
  .stats b { color: var(--text); font-weight: 600; }
  #search {
    background: var(--panel); border: 1px solid var(--line); color: var(--text);
    border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; width: 220px;
  }
  #search:focus { outline: none; border-color: var(--amber); }
  #stage { position: fixed; inset: 0; display: block; }
  #tooltip {
    position: fixed; z-index: 8; pointer-events: none; display: none;
    background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
    padding: 6px 9px; font-size: 12px; max-width: 320px; color: var(--text);
    box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  }
  #tooltip .t-meta { color: var(--muted); font-size: 11px; margin-top: 3px; }
  #panel {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 7; width: 380px; max-width: 92vw;
    background: var(--panel); border-left: 1px solid var(--line);
    transform: translateX(100%); transition: transform 160ms ease;
    display: flex; flex-direction: column; padding: 18px; overflow-y: auto;
  }
  #panel.open { transform: translateX(0); }
  #panel .p-close { position: absolute; top: 12px; right: 14px; cursor: pointer; color: var(--muted); font-size: 18px; border: none; background: none; }
  #panel .p-close:hover { color: var(--text); }
  .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .chip .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  #p-role { font-size: 13px; color: var(--amber); text-transform: uppercase; letter-spacing: 1px; margin: 2px 0 10px; }
  #p-content { white-space: pre-wrap; word-break: break-word; line-height: 1.5; font-size: 13px; color: var(--text); }
  #p-time { color: var(--muted); font-size: 12px; margin-top: 14px; }
  #legend {
    position: fixed; left: 12px; bottom: 12px; z-index: 6;
    background: rgba(23,26,33,0.85); border: 1px solid var(--line); border-radius: 8px;
    padding: 10px 12px; font-size: 12px; color: var(--muted);
  }
  #legend .row { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  #legend .swatch { width: 11px; height: 11px; border-radius: 50%; }
  #hint { position: fixed; right: 12px; bottom: 12px; z-index: 6; color: var(--muted); font-size: 11px; opacity: 0.7; }
  #empty { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; color: var(--muted); }
</style>
</head>
<body>
<header>
  <span class="wordmark">Holt</span>
  <span class="ws" title="${wsSafe}">${wsSafe}</span>
  <input id="search" type="search" placeholder="search memory..." autocomplete="off" spellcheck="false" />
  <span class="stats"><b>${meta.turns}</b> turns &middot; <b>${meta.sessions}</b> sessions &middot; <b>${meta.concepts}</b> concepts &middot; <b>${meta.edges}</b> edges</span>
</header>

<canvas id="stage"></canvas>

<div id="tooltip"></div>

<aside id="panel">
  <button class="p-close" id="p-close" aria-label="close">&times;</button>
  <div class="chip"><span class="dot" id="p-dot"></span><span id="p-session"></span></div>
  <div id="p-role"></div>
  <div id="p-content"></div>
  <div id="p-time"></div>
</aside>

<div id="legend">
  <div class="row"><span class="swatch" style="background:var(--amber)"></span>you</div>
  <div class="row"><span class="swatch" style="background:var(--cyan)"></span>assistant</div>
  <div class="row"><span class="swatch" style="background:var(--violet)"></span>concept</div>
  <div class="row"><span class="swatch" style="background:#5bd66f"></span>wiki page</div>
  <div class="row"><span class="swatch" style="background:var(--line);border:1px solid var(--muted)"></span>ring = session</div>
</div>
<div id="hint">drag to pan &middot; wheel to zoom &middot; click a node &middot; Esc to clear</div>
<div id="empty">This graph has no nodes yet.</div>

<script id="graph-data" type="application/json">${dataJson}</script>
<script>
(function () {
  "use strict";
  var DATA;
  try {
    DATA = JSON.parse(document.getElementById("graph-data").textContent);
  } catch (e) {
    document.getElementById("empty").textContent = "Could not read the graph data.";
    document.getElementById("empty").style.display = "flex";
    return;
  }
  var nodes = DATA.nodes || [];
  var edges = DATA.edges || [];

  var canvas = document.getElementById("stage");
  var ctx = canvas.getContext("2d");
  var tooltip = document.getElementById("tooltip");
  var panel = document.getElementById("panel");
  var searchBox = document.getElementById("search");
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!nodes.length) { document.getElementById("empty").style.display = "flex"; return; }

  // ---- color per session (distinct hues) ----
  var sessionList = [];
  nodes.forEach(function (n) { if (n.session && sessionList.indexOf(n.session) < 0) sessionList.push(n.session); });
  function sessionHue(session) {
    var i = sessionList.indexOf(session);
    if (i < 0) i = 0;
    return (i * 137.508) % 360; // golden-angle spread
  }

  // ---- index + degree ----
  var byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; n._deg = 0; });
  var links = [];
  edges.forEach(function (e) {
    var s = byId[e.source], t = byId[e.target];
    if (!s || !t) return;
    s._deg++; t._deg++;
    links.push({ s: s, t: t, kind: e.kind, width: e.width });
  });

  function radiusOf(n) {
    var base = n.kind === "concept" ? 3 : n.kind === "wiki" ? 6 : 5;
    return base + Math.min(9, Math.sqrt(n._deg) * 1.6);
  }

  // ---- initial layout: spread on a spiral so physics has somewhere to start ----
  nodes.forEach(function (n, i) {
    var ang = i * 2.399963;
    var rad = 22 * Math.sqrt(i);
    n.x = Math.cos(ang) * rad;
    n.y = Math.sin(ang) * rad;
    n.vx = 0; n.vy = 0;
  });

  // ---- physics ----
  var REPULSION = 5200, SPRING = 0.02, GRAVITY = 0.015, DAMP = 0.86;
  var restLen = { sequential: 60, semantic: 45, concept: 70 };

  function step() {
    var i, j, n, m, dx, dy, d2, d, f;
    // repulsion (all pairs; fine for the sizes Holt produces)
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        m = nodes[j];
        dx = n.x - m.x; dy = n.y - m.y;
        d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 90000) continue; // ignore far-apart pairs
        d = Math.sqrt(d2);
        f = REPULSION / d2;
        var ux = dx / d, uy = dy / d;
        n.vx += ux * f; n.vy += uy * f;
        m.vx -= ux * f; m.vy -= uy * f;
      }
    }
    // springs
    for (i = 0; i < links.length; i++) {
      var lk = links[i];
      dx = lk.t.x - lk.s.x; dy = lk.t.y - lk.s.y;
      d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      var rest = restLen[lk.kind] || 60;
      f = (d - rest) * SPRING;
      var ax = (dx / d) * f, ay = (dy / d) * f;
      lk.s.vx += ax; lk.s.vy += ay;
      lk.t.vx -= ax; lk.t.vy -= ay;
    }
    // gravity to center + integrate
    var moved = 0;
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      n.vx -= n.x * GRAVITY; n.vy -= n.y * GRAVITY;
      n.vx *= DAMP; n.vy *= DAMP;
      if (n === dragNode) continue;
      n.x += n.vx; n.y += n.vy;
      moved += Math.abs(n.vx) + Math.abs(n.vy);
    }
    return moved / nodes.length;
  }

  // ---- view transform ----
  var view = { x: 0, y: 0, scale: 1 };
  var W = 0, H = 0, dpr = Math.max(1, window.devicePixelRatio || 1);
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
  }
  window.addEventListener("resize", resize);
  resize();
  view.x = W / 2; view.y = H / 2;

  function worldToScreen(x, y) { return { x: x * view.scale + view.x, y: y * view.scale + view.y }; }
  function screenToWorld(x, y) { return { x: (x - view.x) / view.scale, y: (y - view.y) / view.scale }; }

  // ---- selection + search state ----
  var selected = null;         // a node id
  var highlightSet = null;     // Set of ids to emphasise (search or concept click)
  var query = "";

  function roleColor(n) {
    if (n.kind === "wiki") return "#5bd66f";
    if (n.kind === "concept") return "#9a8cff";
    return n.role === "user" ? "#f0b91e" : "#35d0d6";
  }

  function matchesQuery(n) {
    if (!query) return false;
    var hay = (n.label || "") + " " + (n.content || "");
    return hay.toLowerCase().indexOf(query) >= 0;
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // edges
    for (var i = 0; i < links.length; i++) {
      var lk = links[i];
      var a = worldToScreen(lk.s.x, lk.s.y), b = worldToScreen(lk.t.x, lk.t.y);
      var dim = 0.16;
      if (highlightSet) {
        if (highlightSet.has(lk.s.id) || highlightSet.has(lk.t.id)) dim = 0.55; else dim = 0.05;
      } else {
        dim = lk.kind === "semantic" ? 0.4 : lk.kind === "concept" ? 0.14 : 0.22;
      }
      ctx.globalAlpha = dim;
      ctx.lineWidth = Math.max(0.4, lk.width * view.scale * 0.5);
      ctx.strokeStyle = lk.kind === "semantic" ? "#35d0d6" : lk.kind === "concept" ? "#9a8cff" : lk.kind === "wikilink" ? "#5bd66f" : "#4a5262";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nodes
    for (var k = 0; k < nodes.length; k++) {
      var n = nodes[k];
      var p = worldToScreen(n.x, n.y);
      var r = radiusOf(n) * view.scale;
      var isHot = (highlightSet && highlightSet.has(n.id)) || (query && matchesQuery(n));
      var faded = (highlightSet && !highlightSet.has(n.id)) || (query && !matchesQuery(n));
      ctx.globalAlpha = faded ? 0.18 : 1;

      // session ring
      if (n.kind === "turn") {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = "hsl(" + sessionHue(n.session) + ",70%,58%)";
        ctx.lineWidth = 1.6; ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = roleColor(n);
      ctx.fill();

      if (n.id === selected || isHot) {
        ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
      }

      // concept + wiki labels always; turn labels when zoomed in
      if (n.kind === "concept" || n.kind === "wiki" || view.scale > 1.4) {
        ctx.globalAlpha = faded ? 0.25 : 0.9;
        ctx.fillStyle = n.kind === "wiki" ? "#5bd66f" : "#e7e9ee";
        ctx.font = (n.kind === "wiki" ? 12 : n.kind === "concept" ? 11 : 10) + "px ui-monospace, monospace";
        ctx.fillText(n.label, p.x + r + 4, p.y + 3);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- animation loop with auto-settle ----
  var settleTicks = 0, running = true;
  function frame() {
    var m = step();
    draw();
    if (m < 0.05) { settleTicks++; } else { settleTicks = 0; }
    if (settleTicks > 30 && !dragNode) { running = false; return; } // rest
    requestAnimationFrame(frame);
  }
  function kick() { if (!running) { running = true; settleTicks = 0; requestAnimationFrame(frame); } }

  if (reduceMotion) {
    for (var s = 0; s < 400; s++) step(); // settle off-screen
    draw();
  } else {
    requestAnimationFrame(frame);
  }

  // ---- hit testing ----
  function nodeAt(sx, sy) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      var p = worldToScreen(n.x, n.y);
      var r = radiusOf(n) * view.scale + 3;
      var dx = sx - p.x, dy = sy - p.y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  // ---- pointer: pan, drag node, hover ----
  var dragNode = null, panning = false, last = { x: 0, y: 0 }, downAt = null, moved = false;

  canvas.addEventListener("mousedown", function (e) {
    var n = nodeAt(e.clientX, e.clientY);
    downAt = { x: e.clientX, y: e.clientY }; moved = false;
    if (n) { dragNode = n; } else { panning = true; }
    last = { x: e.clientX, y: e.clientY };
    kick();
  });
  window.addEventListener("mousemove", function (e) {
    if (Math.abs(e.clientX - (downAt ? downAt.x : e.clientX)) + Math.abs(e.clientY - (downAt ? downAt.y : e.clientY)) > 3) moved = true;
    if (dragNode) {
      var w = screenToWorld(e.clientX, e.clientY);
      dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
      kick();
    } else if (panning) {
      view.x += e.clientX - last.x; view.y += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (!running) draw();
    } else {
      var hov = nodeAt(e.clientX, e.clientY);
      if (hov) {
        canvas.style.cursor = "pointer";
        var when = hov.ts ? new Date(hov.ts).toISOString().slice(0, 10) : "";
        var meta = hov.kind === "concept"
          ? ("concept &middot; in " + (hov.freq || 0) + " turns")
          : hov.kind === "wiki"
          ? "wiki page"
          : (esc(hov.session || "") + (when ? " &middot; " + when : ""));
        tooltip.innerHTML = "<div>" + esc(hov.label) + "</div><div class='t-meta'>" + meta + "</div>";
        tooltip.style.display = "block";
        tooltip.style.left = (e.clientX + 14) + "px";
        tooltip.style.top = (e.clientY + 14) + "px";
      } else {
        canvas.style.cursor = "default";
        tooltip.style.display = "none";
      }
    }
  });
  window.addEventListener("mouseup", function (e) {
    if (!moved) {
      var n = nodeAt(e.clientX, e.clientY);
      if (n) onNodeClick(n); else clearSelection();
    }
    dragNode = null; panning = false; downAt = null;
    if (!running) draw();
  });

  // ---- wheel zoom, cursor-anchored ----
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var before = screenToWorld(e.clientX, e.clientY);
    var factor = Math.exp(-e.deltaY * 0.0015);
    view.scale = Math.max(0.15, Math.min(6, view.scale * factor));
    var after = screenToWorld(e.clientX, e.clientY);
    view.x += (after.x - before.x) * view.scale;
    view.y += (after.y - before.y) * view.scale;
    if (!running) draw();
  }, { passive: false });

  // ---- clicks ----
  function neighbors(id) {
    var set = new Set([id]);
    for (var i = 0; i < links.length; i++) {
      if (links[i].s.id === id) set.add(links[i].t.id);
      if (links[i].t.id === id) set.add(links[i].s.id);
    }
    return set;
  }
  function onNodeClick(n) {
    selected = n.id;
    if (n.kind === "concept" || n.kind === "wiki") {
      highlightSet = neighbors(n.id); // light up its connected nodes
      closePanel();
    } else {
      highlightSet = null;
      openPanel(n);
    }
    if (!running) draw();
  }
  function clearSelection() {
    selected = null; highlightSet = null; closePanel();
    if (!running) draw();
  }

  // ---- side panel ----
  function openPanel(n) {
    document.getElementById("p-session").textContent = n.session || "";
    document.getElementById("p-dot").style.background = "hsl(" + sessionHue(n.session) + ",70%,58%)";
    document.getElementById("p-role").textContent = n.role || "";
    document.getElementById("p-role").style.color = roleColor(n);
    document.getElementById("p-content").textContent = n.content || n.label || "";
    document.getElementById("p-time").textContent = n.ts ? new Date(n.ts).toLocaleString() : "";
    panel.classList.add("open");
  }
  function closePanel() { panel.classList.remove("open"); }
  document.getElementById("p-close").addEventListener("click", clearSelection);

  // ---- search ----
  searchBox.addEventListener("input", function () {
    query = searchBox.value.trim().toLowerCase();
    if (!running) draw();
  });

  // ---- keyboard ----
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      searchBox.value = ""; query = "";
      clearSelection();
      searchBox.blur();
    }
  });

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
})();
</script>
</body>
</html>
`;
}
