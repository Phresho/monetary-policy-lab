import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Chart } from './Chart';
import { SavedRun } from './types';
import { sectorColor, Theme, useTheme, withAlpha } from './viz';

// The circuit map, after the housing app's model map (Jesse), in layers that unfold in place:
//   the feedback loop of the literature figure (ECB macroeconomic models): target setting, Σ, controller (ECB: the
//   policy rule and the rate smoothing), the input u (the policy rate r) through a switch from the controller (closed
//   loop) or the given rate path (open loop, feedback cut), the plant, the output (inflation), the disturbance d;
//   the plant opened: the boxes of the user's LTspice drawing in its own arrangement (Households, Banks, Fiscal
//   Authority, NFC, Foreign Sector), connected by port pairs (flow rail and return rail, e and f marks);
//   Banks and NFC opened: their sub-agents; any other agent opened in place: its circuit, with the port pairs wired on
//   to their nodes, so the wiring is right at the lowest level too.
// The current sources drawn outside the plant boxes are imported variables, shown in a dashboard below the map.
// Nothing is plotted until a port, element, instrument or tile is clicked.

interface El { name: string; ref: string; symbol: string; kind: string; rot: string; x: number; y: number; pins: number[][]; sector: string | null; expr: string; nodes: string[] }
interface Rect { x1: number; y1: number; x2: number; y2: number; title: string | null }
interface Txt { x: number; y: number; align: string; size: number; text: string }
interface Flow { element: string; ref: string; kind: string; from: string; to: string; node: string; steady: number }
export interface MapData { bounds: number[]; wires: number[][]; flags: { x: number; y: number; name: string; ground: boolean }[]; rects: Rect[]; sectors: string[]; texts: Txt[]; elements: El[]; flows: Flow[] }
interface Trace { element: string; trace: string; years: number[]; values: number[] }
type Box = { x: number; y: number; w: number; h: number };
type VB = [number, number, number, number];

// ---------------------------------------------------------------- the blocks
// The loop follows the literature figure (ECB macroeconomic models): target setting → Σ → controller (ECB) → u (the
// policy rate r) → plant (economy) → output (inflation) → back to Σ; a disturbance d enters the plant. In open loop the
// switch takes u from the given rate path and the feedback is open.
// The plant is the user's drawing: its own boxes in its own arrangement, spread apart (centres at KP, sizes at KS).
const PLANT = 'Plant';
const CHILDREN: Record<string, string[]> = {
  [PLANT]: ['Households', 'Banks', 'Fiscal Authority', 'NFC', 'Foreign Sector'],
  Banks: ['Wholesale banks', 'Retail banks'],
  NFC: ['Domestic goods producers', 'Capital producers'],
};
const PARENT: Record<string, string> = Object.fromEntries(Object.entries(CHILDREN).flatMap(([p, cs]) => cs.map(c => [c, p])));
const LOOP = ['Target setting', 'Controller', 'Rate path', PLANT, 'Output'];
// block -> box of the LTspice drawing whose circuit it holds (plant blocks are the drawing's boxes themselves)
const DRAWING: Record<string, string> = { Controller: 'Central Bank', Output: 'CPI values' };
const drawingOf = (id: string) => DRAWING[id] ?? (id === PLANT || id === 'Target setting' || id === 'Rate path' ? undefined : id);
const blockOfDrawing = (title: string) => Object.entries(DRAWING).find(([, v]) => v === title)?.[0] ?? title;
const TITLE: Record<string, [string, string]> = {   // title and subtitle, as in the figure
  'Target setting': ['Target setting', '(Governing Council)'],
  Controller: ['Controller', '(ECB)'],
  'Rate path': ['Rate path', '(given, open loop)'],
  [PLANT]: ['Plant', '(Economy) · NAWM-II multiport'],
  Output: ['Output', '(Inflation)'],
};
const INFO: Record<string, { role: string; about: string; element?: string }> = {
  'Target setting': { role: 'setpoint', element: 'B§Target_CPI', about: 'The Governing Council sets the inflation target π* (Target_CPI in the drawing).' },
  Controller: { role: 'controller', about: 'The ECB: the policy rule B_PI and the rate smoothing R15·C8 (207 time units) set the policy rate r, the input u of the plant (closed loop).' },
  'Rate path': { role: 'open-loop input', element: 'B§R', about: 'In open loop the policy rate r follows a given path (base rate, then a step: the sliders), and the controller is out of the loop.' },
  [PLANT]: { role: 'plant', about: 'The economy as a multiport (NAWM-II): households, banks, the fiscal authority, the non-financial corporations and the foreign sector, connected by port pairs. Open it for the agents.' },
  Output: { role: 'output (sensor)', about: 'Measures the price level P, inflation CPI = 120·d ln P/dt and its filtered value π, which is fed back to Σ (CPI values in the drawing).' },
  Households: { role: 'agent', about: 'Income, consumption, savings and deposits, bonds, labour supply and the taxes households pay.' },
  Banks: { role: 'agent', about: 'Wholesale and retail banks. Open it for the two.' },
  'Wholesale banks': { role: 'sub-agent of Banks', about: 'Bank balance sheet: deposits, wholesale loans, bond holdings, net worth and dividends.' },
  'Retail banks': { role: 'sub-agent of Banks', about: 'Loans to firms and capital producers, funded by wholesale loans.' },
  'Fiscal Authority': { role: 'agent', about: 'Government spending, taxes, bond issuance, coupons and debt.' },
  NFC: { role: 'agent', about: 'Non-financial corporations: the goods market (drawn in the NFC box itself), domestic goods producers and capital producers. Open it for them.' },
  'Domestic goods producers': { role: 'sub-agent of NFC', about: 'Production, revenue, labour demand, wages, loans and interest.' },
  'Capital producers': { role: 'sub-agent of NFC', about: 'Investment and the capital stock.' },
  'Foreign Sector': { role: 'agent', about: 'Imports, exports, foreign bonds and the exchange rate.' },
};
// the figure's colours
const FIG = {
  target: { fill: '#fff2a8', stroke: '#e3c23a', sub: '#7a6400' },
  ctrl: { fill: '#ffd21a', stroke: '#d9a400', sub: '#c0392b' },
  path: { fill: '#fff8d6', stroke: '#c9a227', sub: '#7a6400' },
  plant: { fill: '#7f9dba', stroke: '#5b7c9c', sub: '#1d3550' },
  output: { fill: '#6aa84f', stroke: '#3f7d2c', sub: '#173d0c' },
  region: { fill: '#e9e9e9', stroke: '#9a9a9a' },
  dist: '#e53935', line: '#2b2b2b', off: '#b8c2bd',
};

// ---------------------------------------------------------------- layout (map units)
const HEAD = 40;   // header band of a block
const TARGET: Box = { x: 0, y: 326, w: 230, h: 120 };
const SUM = { x: 340, y: 386, r: 24 };
const CTRL: Box = { x: 460, y: 300, w: 250, h: 172 };
const RATE: Box = { x: 460, y: 520, w: 250, h: 104 };
const SWITCH_X = 860;   // where u is taken from the controller (closed) or the rate path (open)
const P_CLOSED: Box = { x: 1080, y: 256, w: 440, h: 260 };
const P_ORIGIN = { x: 1080, y: 120 };
const KS = 0.31, KP = 0.42;   // drawing units -> map units: sizes, and centres (spread apart)
const PAD = 70;
const outputBox = (p: Box): Box => ({ x: p.x + p.w + 200, y: CTRL.y + CTRL.h / 2 - 60, w: 240, h: 120 });
type R4 = { x1: number; y1: number; x2: number; y2: number };
const LEAF_MARGIN = 60;   // drawing units around an opened box's circuit
// scale of an opened block's circuit: big enough to read its elements, at least twice the closed size
const leafScale = (r: R4) => Math.min(1, Math.max(KS * 2.2, 1100 / Math.max(r.x2 - r.x1, r.y2 - r.y1)));

// The plant laid out for the blocks that are open. Closed boxes take their drawing size times KS at their drawing
// centre times KP (so the gaps grow). An opened box grows from its centre (a container to fit its spread children, a
// leaf to show its circuit) and pushes its siblings aside along both axes, so nothing overlaps and the arrangement
// stays. Returns every box of the plant tree, the plant box, and the circuit placement of the opened leaf.
function plantLayout(rects: Record<string, R4>, open: string[]) {
  const boxes: Record<string, Box> = {};
  let leafView: { r: R4; s: number; x: number; y: number } | undefined;
  // size of a block when shown and open; children laid out relative to (0, 0)
  function lay(id: string): { w: number; h: number; kids: Record<string, Box> } {
    const r = rects[id];
    const kidsIds = CHILDREN[id];
    if (!open.includes(id)) return { w: (r.x2 - r.x1) * KS, h: (r.y2 - r.y1) * KS, kids: {} };
    if (!kidsIds) {   // an opened leaf: its circuit at leafScale
      const s = leafScale(r), w = (r.x2 - r.x1 + 2 * LEAF_MARGIN) * s, h = (r.y2 - r.y1 + 2 * LEAF_MARGIN) * s + HEAD;
      return { w, h, kids: {} };
    }
    // a container: children at spread centres, the open one grown, siblings pushed
    const area = id === PLANT ? { x1: Math.min(...kidsIds.map(k => rects[k].x1)), y1: Math.min(...kidsIds.map(k => rects[k].y1)) } : r;
    const base: Record<string, Box> = {}, sub: Record<string, ReturnType<typeof lay>> = {};
    for (const k of kidsIds) {
      const kr = rects[k], cx = ((kr.x1 + kr.x2) / 2 - area.x1) * KP, cy = ((kr.y1 + kr.y2) / 2 - area.y1) * KP;
      const w = (kr.x2 - kr.x1) * KS, h = (kr.y2 - kr.y1) * KS;
      base[k] = { x: cx - w / 2, y: cy - h / 2, w, h };
      sub[k] = lay(k);
    }
    const placed: Record<string, Box> = { ...base };
    for (const k of kidsIds) {
      if (!open.includes(k)) continue;
      const b = base[k], dw = sub[k].w - b.w, dh = sub[k].h - b.h, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      for (const o of kidsIds) {
        const ob = placed[o];
        if (o === k) { placed[o] = { x: ob.x - dw / 2, y: ob.y - dh / 2, w: sub[k].w, h: sub[k].h }; continue; }
        const ocx = base[o].x + base[o].w / 2, ocy = base[o].y + base[o].h / 2;
        placed[o] = { ...ob, x: ob.x + (ocx > cx ? dw / 2 : ocx < cx ? -dw / 2 : 0), y: ob.y + (ocy > cy ? dh / 2 : ocy < cy ? -dh / 2 : 0) };
      }
    }
    const x0 = Math.min(...kidsIds.map(k => placed[k].x)), y0 = Math.min(...kidsIds.map(k => placed[k].y));
    const kids: Record<string, Box> = {};
    for (const k of kidsIds) kids[k] = { ...placed[k], x: placed[k].x - x0 + PAD, y: placed[k].y - y0 + HEAD + PAD };
    const w = Math.max(...kidsIds.map(k => kids[k].x + kids[k].w)) + PAD, h = Math.max(...kidsIds.map(k => kids[k].y + kids[k].h)) + PAD;
    return { w, h, kids };
  }
  function place(id: string, x: number, y: number, l: ReturnType<typeof lay>) {
    boxes[id] = { x, y, w: l.w, h: l.h };
    for (const [k, b] of Object.entries(l.kids)) place(k, x + b.x, y + b.y, lay(k));
    if (open.includes(id) && !CHILDREN[id] && rects[id]) leafView = { r: rects[id], s: leafScale(rects[id]), x, y: y + HEAD };
  }
  const top = lay(PLANT);
  place(PLANT, P_ORIGIN.x, P_ORIGIN.y, top);
  return { boxes, leafView };
}


const kindColor = (t: Theme): Record<string, string> => ({ resistor: t.ink2, inductor: t.sectors[0], capacitor: t.sectors[2], 'behavioural current': t.sectors[1], 'current source': t.sectors[1], 'behavioural voltage': t.sectors[6], 'voltage source': t.sectors[6] });
const pretty = (s: string) => s.replace(/_/g, ' ');

// Glyphs in LTspice symbol coordinates, between the symbol's pins (see backend/monetary/schematic.py PINS).
function Glyph({ symbol }: { symbol: string }) {
  switch (symbol) {
    case 'res': return <path d="M16 16 V30 L28 36 L4 44 L28 52 L4 60 L28 68 L4 76 L16 82 V96"/>;
    case 'ind': case 'ind2': return <path d="M16 16 V28 a7 7 0 0 1 0 14 a7 7 0 0 1 0 14 a7 7 0 0 1 0 14 a7 7 0 0 1 0 14 V96"/>;
    case 'cap': return <><path d="M16 0 V26 M16 38 V64"/><path d="M0 26 H32 M0 38 H32" strokeWidth={5}/></>;
    case 'bv': case 'voltage': return <><path d="M0 16 V32 M0 80 V96 M0 32 L24 56 L0 80 L-24 56 Z"/><path d="M-6 44 H6 M0 38 V50 M-6 68 H6" strokeWidth={2.5}/></>;
    case 'bi2': return <><path d="M0 0 V16 M0 64 V80 M0 16 L24 40 L0 64 L-24 40 Z"/><path d="M0 54 V28 M-6 34 L0 26 L6 34" strokeWidth={2.5}/></>;
    default: return <><path d="M0 0 V16 M0 64 V80 M0 16 L24 40 L0 64 L-24 40 Z"/><path d="M0 26 V52 M-6 46 L0 54 L6 46" strokeWidth={2.5}/></>;
  }
}
const transform = (e: El) => `translate(${e.x} ${e.y})${e.rot.startsWith('M') ? ' scale(-1 1)' : ''} rotate(${Number(e.rot.slice(1))})`;

// ---------------------------------------------------------------- right-angled routing of the flows
// A maze router: the candidate lines are the channels between all box edges (midlines of the gaps) and the ports.
// For every flow an A* search finds the shortest right-angled path from a side of its first box to a side of its
// second (leaving and entering outward), never through a box other than its own two or one that contains them;
// every bend costs extra, so paths stay simple. A path is a list of lines (horizontal or vertical, each at one
// coordinate); flows that share a channel line get their own lane on it. Labels go where they do not overlap a label
// already placed (labelled separately, so zooming does not reroute).
type Side = 'L' | 'R' | 'T' | 'B';
interface Path { key: string; flow: Flow; a: string; b: string; pts: number[][]; gap: number[] }   // gap: port spacing at each end
interface Routed extends Path { label: { x: number; y: number; vertical: boolean } }
const LANE = 36, BEND = 160;   // a lane holds a port pair: flow rail and return rail 12 apart
const horiz = (sd: Side) => sd === 'L' || sd === 'R';

function route(list: { key: string; flow: Flow; a: string; b: string }[], box: (id: string) => Box, obstacles: string[],
  contains: (outer: string, inner: string) => boolean, headers: Box[] = []): Path[] {
  const bx = obstacles.map(id => ({ id, b: box(id) }));
  const uniq = (v: number[]) => [...new Set(v.map(x => Math.round(x * 10) / 10))].sort((a, b) => a - b);
  const xe = uniq(bx.flatMap(o => [o.b.x, o.b.x + o.b.w])), ye = uniq(bx.flatMap(o => [o.b.y, o.b.y + o.b.h]));
  const mids = (v: number[]) => [v[0] - 70, ...v.slice(1).map((x, i) => (x + v[i]) / 2).filter((m, i) => v[i + 1] - v[i] > 24), v[v.length - 1] + 70];
  const chX = mids(xe), chY = mids(ye).filter(y => !headers.some(h => y > h.y - 2 && y < h.y + h.h + 2));
  const at = (b: Box, sd: Side, along: number): number[] =>
    sd === 'L' ? [b.x, along] : sd === 'R' ? [b.x + b.w, along] : sd === 'T' ? [along, b.y] : [along, b.y + b.h];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const outward = (sd: Side) => ({ R: 0, L: 1, B: 2, T: 3 })[sd];
  const free = (p: number[], q: number[], a: string, b: string) => !bx.some(o => {
    if (o.id === a || o.id === b || contains(o.id, a) || contains(o.id, b)) return false;
    const r = o.b, x1 = Math.min(p[0], q[0]), x2 = Math.max(p[0], q[0]), y1 = Math.min(p[1], q[1]), y2 = Math.max(p[1], q[1]);
    return x2 > r.x + 1 && x1 < r.x + r.w - 1 && y2 > r.y + 1 && y1 < r.y + r.h - 1;
  });
  const inside = (p: number[], b: Box) => p[0] > b.x + 1 && p[0] < b.x + b.w - 1 && p[1] > b.y + 1 && p[1] < b.y + b.h - 1;

  // A* on the grid of (x, y) lines from port pa (leaving along dirA) to port pb (arriving against dirB)
  function search(pa: number[], pb: number[], dirA: number, dirB: number, f: { a: string; b: string }, A: Box, B: Box) {
    const X = uniq([...chX, pa[0], pb[0]]), Y = uniq([...chY, pa[1], pb[1]]);
    const xi = (v: number) => X.indexOf(Math.round(v * 10) / 10), yi = (v: number) => Y.indexOf(Math.round(v * 10) / 10);
    const start = [xi(pa[0]), yi(pa[1])], goal = [xi(pb[0]), yi(pb[1])];
    const key = (i: number, j: number, d: number) => (i * Y.length + j) * 4 + d;
    const g = new Map<number, number>(), prev = new Map<number, number>();
    const open: [number, number, number, number, number][] = [];   // [f, cost, i, j, dir]
    const h = (i: number, j: number) => Math.abs(X[i] - X[goal[0]]) + Math.abs(Y[j] - Y[goal[1]]);
    const push = (c: number, i: number, j: number, d: number, from: number) => {
      const k = key(i, j, d); if (g.has(k) && g.get(k)! <= c) return;
      g.set(k, c); prev.set(k, from); open.push([c + h(i, j), c, i, j, d]);
    };
    push(0, start[0], start[1], dirA, -1);
    let iter = 0;
    while (open.length && iter++ < 60000) {
      let bi = 0; for (let n = 1; n < open.length; n++) if (open[n][0] < open[bi][0]) bi = n;
      const [, c, i, j, d] = open.splice(bi, 1)[0];
      if (c > g.get(key(i, j, d))!) continue;
      if (i === goal[0] && j === goal[1] && d === dirB) {
        const pts: number[][] = []; let k = key(i, j, d);
        while (k >= 0) { const n = Math.floor(k / 4), ii = Math.floor(n / Y.length), jj = n % Y.length; pts.unshift([X[ii], Y[jj]]); k = prev.get(k)!; }
        return { cost: c, pts };
      }
      for (let nd = 0; nd < 4; nd++) {
        if (i === start[0] && j === start[1] && c === 0 && nd !== dirA) continue;            // leave outward
        if (DIRS[nd][0] === -DIRS[d][0] && DIRS[nd][1] === -DIRS[d][1]) continue;             // no U-turn
        const ni = i + DIRS[nd][0], nj = j + DIRS[nd][1];
        if (ni < 0 || nj < 0 || ni >= X.length || nj >= Y.length) continue;
        const p = [X[i], Y[j]], q = [X[ni], Y[nj]];
        if (!free(p, q, f.a, f.b)) continue;
        if (inside(q, A) || inside(q, B) || (inside(p, A) && !(i === start[0] && j === start[1]))) continue;  // stay outside both ends
        if (ni === goal[0] && nj === goal[1] && nd !== dirB) continue;                       // arrive inward
        push(c + Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + (nd !== d ? BEND : 0), ni, nj, nd, key(i, j, d));
      }
    }
    return null;
  }
  const simplify = (pts: number[][]) => pts.filter((p, i) => i === 0 || i === pts.length - 1 ||
    !((pts[i - 1][0] === p[0] && p[0] === pts[i + 1][0]) || (pts[i - 1][1] === p[1] && p[1] === pts[i + 1][1])));

  // 1. a path per flow, with the ports at the middle of the sides; the best of all side pairs
  const raw = list.map(f => {
    const A = box(f.a), B = box(f.b);
    let best: { cost: number; pts: number[][]; sa: Side; sb: Side } | null = null;
    for (const sa of ['R', 'L', 'B', 'T'] as Side[]) for (const sb of ['L', 'R', 'T', 'B'] as Side[]) {
      const pa = at(A, sa, horiz(sa) ? A.y + A.h / 2 : A.x + A.w / 2), pb = at(B, sb, horiz(sb) ? B.y + B.h / 2 : B.x + B.w / 2);
      const db = ({ L: 0, R: 1, T: 2, B: 3 } as const)[sb];   // arriving at side L means moving right (+x), ...
      const r = search(pa, pb, outward(sa), db, f, A, B);
      if (r && (!best || r.cost < best.cost)) best = { ...r, sa, sb };
    }
    if (!best) {   // nothing free: straight across (should not happen with the layouts here)
      const right = B.x > A.x, sa: Side = right ? 'R' : 'L', sb: Side = right ? 'L' : 'R';
      const pa = at(A, sa, A.y + A.h / 2), pb = at(B, sb, B.y + B.h / 2), c = (pa[0] + pb[0]) / 2;
      best = { cost: 0, pts: [pa, [c, pa[1]], [c, pb[1]], pb], sa, sb };
    }
    return { ...best, pts: simplify(best.pts) };
  });

  // 2. ports: spread along each side, ordered by where the path turns to (fewer crossings)
  type Att = { i: number; end: 0 | 1; side: Side; k: number };
  const sides = new Map<string, Att[]>();
  raw.forEach((r, i) => {
    const f = list[i], n = r.pts.length;
    const ka = horiz(r.sa) ? r.pts[Math.min(2, n - 1)][1] : r.pts[Math.min(2, n - 1)][0];
    const kb = horiz(r.sb) ? r.pts[Math.max(n - 3, 0)][1] : r.pts[Math.max(n - 3, 0)][0];
    for (const [id, sd, k, end] of [[f.a, r.sa, ka, 0], [f.b, r.sb, kb, 1]] as const) {
      const key = `${id}|${sd}`; if (!sides.has(key)) sides.set(key, []); sides.get(key)!.push({ i, end, side: sd, k: k + i * 1e-4 });
    }
  });
  const port: number[][] = list.map(() => [0, 0]), gap: number[][] = list.map(() => [999, 999]);
  for (const [k, atts] of sides) {
    const b = box(k.split('|')[0]);
    atts.sort((x, y) => x.k - y.k);
    atts.forEach((a, j) => {
      const lo = horiz(a.side) ? b.y + HEAD + 12 : b.x + 24, hi = horiz(a.side) ? b.y + b.h - 12 : b.x + b.w - 24;
      port[a.i][a.end] = lo + (hi - lo) * (j + 1) / (atts.length + 1);
      gap[a.i][a.end] = (hi - lo) / (atts.length + 1);
    });
  }

  // 3. the path as lines; the first and last line sit on the ports, the inner ones get a lane on their channel
  type Ln = { v: boolean; c: number };
  const lines: Ln[][] = raw.map((r, i) => {
    const out: Ln[] = [];
    for (let s = 0; s < r.pts.length - 1; s++) { const v = r.pts[s][0] === r.pts[s + 1][0]; out.push({ v, c: v ? r.pts[s][0] : r.pts[s][1] }); }
    if (out.length === 1) {   // straight between facing sides: port line, a jog in the middle of the gap, port line
      const l = out[0], m = l.v ? (r.pts[0][1] + r.pts[1][1]) / 2 : (r.pts[0][0] + r.pts[1][0]) / 2;
      return [{ v: l.v, c: port[i][0] }, { v: !l.v, c: m }, { v: l.v, c: port[i][1] }];
    }
    out[0] = { v: out[0].v, c: port[i][0] }; out[out.length - 1] = { v: out[out.length - 1].v, c: port[i][1] };
    return out;
  });
  const groups = new Map<string, { i: number; s: number }[]>();
  lines.forEach((ls, i) => ls.forEach((l, s) => { if (s > 0 && s < ls.length - 1) { const k = `${l.v}|${Math.round(l.c)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push({ i, s }); } }));
  for (const g of groups.values()) {
    const mid = (x: { i: number; s: number }) => { const ls = lines[x.i]; return (ls[x.s - 1].c + ls[x.s + 1].c) / 2; };
    g.sort((x, y) => mid(x) - mid(y));
    g.forEach((x, j) => { lines[x.i][x.s].c += (j - (g.length - 1) / 2) * LANE; });
  }
  return list.map((f, i) => {
    const r = raw[i], ls = lines[i], A = box(f.a), B = box(f.b);
    const pts = [at(A, r.sa, port[i][0])];
    for (let s = 0; s < ls.length - 1; s++) pts.push(ls[s].v ? [ls[s].c, ls[s + 1].c] : [ls[s + 1].c, ls[s].c]);
    pts.push(at(B, r.sb, port[i][1]));
    return { ...f, pts: simplify(pts), gap: gap[i] };
  });
}

function placeLabels(paths: Path[], fs: number): Routed[] {
  const placed: number[][] = [];
  return paths.map(p => {
    const pts = p.pts, text = p.flow.ref.length * fs * 0.58 + 8;
    const segs = pts.slice(0, -1).map((q, s) => ({ s, h: Math.abs(pts[s + 1][1] - q[1]) < 1, len: Math.hypot(pts[s + 1][0] - q[0], pts[s + 1][1] - q[1]) }))
      .filter(x => x.len > 30).sort((x, y) => (Number(y.h && y.len > text) - Number(x.h && x.len > text)) || y.len - x.len);
    let label = { x: (pts[0][0] + pts[pts.length - 1][0]) / 2, y: (pts[0][1] + pts[pts.length - 1][1]) / 2, vertical: false };
    search: for (const sg of segs) for (const tt of [0.5, 0.3, 0.7, 0.18, 0.82]) {
      const q0 = pts[sg.s], q1 = pts[sg.s + 1], x = q0[0] + (q1[0] - q0[0]) * tt, y = q0[1] + (q1[1] - q0[1]) * tt;
      const r = sg.h ? [x - text / 2, y - fs - 4, x + text / 2, y] : [x - fs - 4, y - text / 2, x, y + text / 2];
      if (placed.every(o => r[2] < o[0] || r[0] > o[2] || r[3] < o[1] || r[1] > o[3])) { placed.push(r); label = { x, y, vertical: !sg.h }; break search; }
    }
    return { ...p, label };
  });
}

// ---------------------------------------------------------------- port pairs (the multiport notation)
const dist = (p: number[], q: number[]) => Math.hypot(q[0] - p[0], q[1] - p[1]);
function along(p: number[], q: number[], d: number): number[] { const l = dist(p, q) || 1; return [p[0] + (q[0] - p[0]) * d / l, p[1] + (q[1] - p[1]) * d / l]; }
// the return rail: the right-angled path shifted d to the right of the direction of travel (corners shifted on both legs)
function offsetPts(pts: number[][], d: number): number[][] {
  const nrm = (p: number[], q: number[]) => { const l = dist(p, q) || 1; return [-(q[1] - p[1]) / l, (q[0] - p[0]) / l]; };
  return pts.map((p, i) => {
    const a = i > 0 ? nrm(pts[i - 1], p) : null, b = i < pts.length - 1 ? nrm(p, pts[i + 1]) : null;
    const nx = (a ? a[0] : 0) + (b ? b[0] : 0), ny = (a ? a[1] : 0) + (b ? b[1] : 0);
    const same = a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    return same ? [p[0] + a![0] * d, p[1] + a![1] * d] : [p[0] + nx * d, p[1] + ny * d];
  });
}
// At each end of a port pair: a bar across both rails with the e (effort) mark between them, the f (flow) mark on the
// flow rail, and two terminals (as the housing app draws its ports). e and f are clickable.
function PortMarks({ a, b, ra, rb, c, k, on, gap = 999 }: { a: number[]; b: number[]; ra: number[]; rb: number[]; c: string; k: number; on?: 'e' | 'f'; gap?: number }) {
  const s = Math.min(k, dist(a, b) / 46, Math.max(gap - 2, 6) / 26);   // short end segments and close neighbours: the marks shrink to fit
  const e1 = along(a, b, 11 * s), e2 = along(ra, rb, 11 * s), em = [(e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2], f = along(a, b, 27 * s), t1 = along(a, b, 39 * s), t2 = along(ra, rb, 39 * s);
  const r = 6.2 * s;
  return <g className="pair-mark">
    <path d={`M${e1[0]} ${e1[1]}L${e2[0]} ${e2[1]}`} style={{ stroke: c }}/>
    <g data-q="e" className={'q' + (on === 'e' ? ' on' : '')}><circle cx={em[0]} cy={em[1]} r={r} style={{ stroke: c }}/><text x={em[0]} y={em[1]} fontSize={8.5 * s} style={{ fill: c }}>e</text></g>
    <g data-q="f" className={'q' + (on === 'f' ? ' on' : '')}><circle cx={f[0]} cy={f[1]} r={r} style={{ stroke: c }}/><text x={f[0]} y={f[1]} fontSize={8.5 * s} style={{ fill: c }}>f</text></g>
    <circle cx={t1[0]} cy={t1[1]} r={2.6 * s} className="term" style={{ stroke: c }}/><circle cx={t2[0]} cy={t2[1]} r={2.6 * s} className="term" style={{ stroke: c }}/>
  </g>;
}

const within = (outer: string, inner: string) => { let v: string | undefined = inner; while (v) { v = PARENT[v]; if (v === outer) return true; } return false; };
const inPlant = (id: string) => within(PLANT, id);
interface DashVar { name: string; ref: string; group: string; expr: string; box: string | null; readers: { name: string; ref: string; sector: string | null }[] }
type DashVals = Record<string, { start: number; end: number; min: number; max: number }>;
type Sel = { type: 'block' | 'flow' | 'el' | 'instr'; id: string; q?: 'e' | 'f' };
const fmt = (v: number) => !isFinite(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3);

export function ModelMap({ scenario, closed, run }: { scenario: unknown; closed: boolean; run?: SavedRun }) {
  const t = useTheme();
  const KIND = kindColor(t);
  const [m, setM] = useState<MapData>();
  const [dash, setDash] = useState<DashVar[]>([]);
  const [vals, setVals] = useState<DashVals>();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string[]>([]);
  const [whole, setWhole] = useState(false);
  const [sel, setSel] = useState<Sel>();
  const [hover, setHover] = useState<string>();
  const [trace, setTrace] = useState<Trace>();
  const [traceBusy, setTraceBusy] = useState(false);
  const [vb, setVb] = useState<VB>([0, 0, 1900, 900]);
  const [px, setPx] = useState(1);
  const svg = useRef<SVGSVGElement>(null);
  const vbRef = useRef<VB>(vb);
  const anim = useRef(0);
  const drag = useRef<{ x: number; y: number; vb: VB; moved: boolean } | null>(null);
  vbRef.current = vb;

  useEffect(() => {
    api<MapData>('/model/map').then(setM).catch(e => setError(String(e.message ?? e)));
    api<DashVar[]>('/dashboard').then(setDash).catch(() => undefined);
  }, []);
  useEffect(() => {   // the dashboard values of the active run
    if (!run) return;
    let live = true;
    api<DashVals>('/dashboard/values', scenario).then(v => { if (live) setVals(v); }).catch(() => undefined);
    return () => { live = false; };
  }, [run, scenario]);
  const rects = useMemo(() => Object.fromEntries((m?.rects ?? []).filter(r => r.title).map(r => [r.title!, r])), [m]);
  const ownerAt = useCallback((x: number, y: number) => {
    let best: string | null = null, area = Infinity;
    for (const [k, r] of Object.entries(rects)) { const a = (r.x2 - r.x1) * (r.y2 - r.y1); if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2 && a < area) { best = k; area = a; } }
    return best;
  }, [rects]);

  const plantOpen = open.includes(PLANT);
  const layoutFor = useCallback((o: string[]) => o.includes(PLANT) && rects.Households ? plantLayout(rects, o) : { boxes: {} as Record<string, Box>, leafView: undefined }, [rects]);
  const lay = useMemo(() => layoutFor(open), [layoutFor, open]);
  const leafOpen = open.find(o => !CHILDREN[o]);                       // the opened block without sub-blocks
  const loopLeaf = leafOpen && !inPlant(leafOpen) ? leafOpen : undefined;   // controller / output: shown over a scrim
  const plantLeaf = leafOpen && inPlant(leafOpen) ? leafOpen : undefined;   // a plant agent: opened in place
  const boxIn = useCallback((id: string, l: ReturnType<typeof layoutFor>, po: boolean): Box => {
    if (id === 'Target setting') return TARGET;
    if (id === 'Controller') return CTRL;
    if (id === 'Rate path') return RATE;
    const P = po ? (l.boxes[PLANT] ?? P_CLOSED) : P_CLOSED;
    if (id === PLANT) return P;
    if (id === 'Output') return outputBox(P);
    return l.boxes[id] ?? { x: 0, y: 0, w: 10, h: 10 };
  }, []);
  const boxOf = useCallback((id: string) => boxIn(id, lay, plantOpen), [boxIn, lay, plantOpen]);
  // the controller and the output open over the loop (their circuit grows around the block's centre)
  const expanded = useCallback((id: string): Box => {
    const b = boxOf(id), w = Math.max(b.w * 2.8, 760), h = Math.max(b.h * 2.8, 500);
    return { x: Math.max(-200, b.x + b.w / 2 - w / 2), y: Math.max(-100, b.y + b.h / 2 - h / 2), w, h };
  }, [boxOf]);
  const visible = useCallback((id: string): string => { let v = id; while (PARENT[v] && !open.includes(PARENT[v])) v = PARENT[v]; return v; }, [open]);
  const shownBlocks = useMemo(() => {
    const out = [...LOOP];
    const add = (p: string) => { if (open.includes(p)) for (const c of CHILDREN[p] ?? []) { out.push(c); add(c); } };
    add(PLANT);
    return out;
  }, [open]);
  // the dashed region around controller, rate path and plant, and the feedback line below it
  const regionOf = (p: Box): Box => { const y1 = Math.min(CTRL.y, p.y) - 60, y2 = Math.max(RATE.y + RATE.h, p.y + p.h) + 80; return { x: CTRL.x - 40, y: y1, w: p.x + p.w + 40 - (CTRL.x - 40), h: y2 - y1 }; };
  const loopView = (p: Box): Box => { const r = regionOf(p), o = outputBox(p); return { x: TARGET.x - 20, y: r.y - 230, w: o.x + o.w + 40 - TARGET.x, h: r.h + 400 }; };

  // ---------------------------------------------------------------- camera
  const view = useCallback((b: Box, k = 0.06): VB => {
    const cw = svg.current?.clientWidth ?? 1000, ch = svg.current?.clientHeight ?? 700;
    const p = Math.max(b.w, b.h) * k, bw = b.w + 2 * p, bh = b.h + 2 * p, sc = Math.max(bw / cw, bh / ch);
    return [b.x - p - (sc * cw - bw) / 2, b.y - p - (sc * ch - bh) / 2, sc * cw, sc * ch];
  }, []);
  const measure = useCallback(() => { const w = svg.current?.clientWidth, h = svg.current?.clientHeight, v = vbRef.current; if (w && h) setPx(Math.max(v[2] / w, v[3] / h)); }, []);
  useEffect(measure, [vb, measure]);
  useEffect(() => { const ro = new ResizeObserver(measure); if (svg.current) ro.observe(svg.current); return () => ro.disconnect(); }, [measure, m]);
  const flyTo = useCallback((to: VB, ms = 450) => {
    cancelAnimationFrame(anim.current);
    const from = vbRef.current, t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      setVb(from.map((v, i) => v + (to[i] - v) * e) as VB);
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, []);
  const zoomAt = useCallback((cx: number, cy: number, k: number) => {
    const v = vbRef.current;
    cancelAnimationFrame(anim.current);
    const w = Math.min(Math.max(v[2] * k, 30), whole ? 80000 : 20000), kk = w / v[2];
    setVb([cx - (cx - v[0]) * kk, cy - (cy - v[1]) * kk, v[2] * kk, v[3] * kk]);
  }, [whole]);
  const toSvg = (clientX: number, clientY: number) => { const p = new DOMPoint(clientX, clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse()); return [p.x, p.y]; };
  useEffect(() => {   // non-passive wheel: zoom the map, not the page
    const node = svg.current; if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x, y] = toSvg(e.clientX, e.clientY), dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(x, y, Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [m, zoomAt]);
  const zoomCentre = (k: number) => { const v = vbRef.current; zoomAt(v[0] + v[2] / 2, v[1] + v[3] / 2, k); };

  // ---------------------------------------------------------------- open / close (the camera flies to the new layout)
  const pathTo = (id: string): string[] => { const p: string[] = []; let v: string | undefined = id; while (v) { p.unshift(v); v = PARENT[v]; } return p; };
  const focusBox = (o: string[]): Box => {
    const last = o[o.length - 1], l = layoutFor(o), po = o.includes(PLANT);
    if (!last) return loopView(P_CLOSED);
    if (last === PLANT) return loopView(boxIn(PLANT, l, po));
    if (!inPlant(last) && !CHILDREN[last]) return expanded(last);
    return boxIn(last, l, po);
  };
  function setOpenFly(next: string[]) { setOpen(next); setSel(undefined); flyTo(view(focusBox(next), 0.04)); }
  function toggle(id: string) {
    if (id === 'Target setting' || id === 'Rate path') { setSel({ type: 'block', id }); return; }
    setOpenFly(open.includes(id) ? open.slice(0, open.indexOf(id)) : pathTo(id));
  }
  function crumb(i: number) { setOpenFly(open.slice(0, i)); }
  function showWhole(on: boolean) {
    setWhole(on); setSel(undefined); cancelAnimationFrame(anim.current);
    if (on && m) { const b = m.bounds; setVb([b[0], b[1], b[2] - b[0], b[3] - b[1]]); } else setVb(view(focusBox(open), 0.03));
  }
  useEffect(() => { if (m) setVb(view(loopView(P_CLOSED), 0.04)); }, [m]);   // start: the feedback loop

  // ---------------------------------------------------------------- port pairs between the visible plant blocks
  const paths = useMemo(() => {
    if (!m || !plantOpen) return [];
    const seen = new Set<string>(), list: { key: string; flow: Flow; a: string; b: string }[] = [];
    for (const f of m.flows) {
      if (!inPlant(f.from) || !inPlant(f.to)) continue;
      const a = visible(f.from), b = visible(f.to);
      if (a === b || within(a, b) || within(b, a)) continue;
      const key = `${f.element}|${a}|${b}`; if (seen.has(key)) continue; seen.add(key);
      list.push({ key, flow: f, a, b });
    }
    const plantBlocks = shownBlocks.filter(id => inPlant(id));
    const headers = plantBlocks.filter(id => CHILDREN[id] && open.includes(id)).map(id => { const b = boxOf(id); return { x: b.x, y: b.y, w: b.w, h: HEAD }; });
    return route(list, boxOf, plantBlocks, within, headers);
  }, [m, plantOpen, visible, boxOf, shownBlocks, open]);
  const routed = useMemo(() => placeLabels(paths, Math.min(Math.max(11 * px, 9), 60)), [paths, px]);

  // inside an opened agent: each port pair continues from the box edge to its node in the circuit (flow rail) and to
  // the nearest ground of that circuit (return rail), so the wiring stays correct at the lowest level
  const inner = useMemo(() => {
    const lv = lay.leafView;
    if (!m || !plantLeaf || !lv) return [];
    const map = (p: number[]) => [lv.x + (p[0] - (lv.r.x1 - LEAF_MARGIN)) * lv.s, lv.y + (p[1] - (lv.r.y1 - LEAF_MARGIN)) * lv.s];
    const mine = m.elements.filter(e => e.sector === plantLeaf);
    const grounds = m.flags.filter(f => f.ground && ownerAt(f.x, f.y) === plantLeaf).map(f => [f.x, f.y]);
    const b = boxOf(plantLeaf);
    return routed.filter(r => r.a === plantLeaf || r.b === plantLeaf).map(r => {
      const atStart = r.a === plantLeaf, n = r.pts.length, back = offsetPts(r.pts, 12);
      const port = atStart ? r.pts[0] : r.pts[n - 1], ret = atStart ? back[0] : back[n - 1];
      const own = mine.find(e => e.name === r.flow.element), pin = (e: El) => e.pins.find((_, i) => e.nodes[i] === r.flow.node);
      const hitEl = own && pin(own) ? own : mine.find(e => pin(e));
      if (!hitEl) return null;
      const target = map(pin(hitEl)!);
      const g = grounds.length ? map(grounds.reduce((a, q) => Math.hypot(q[0] - pin(hitEl)![0], q[1] - pin(hitEl)![1]) < Math.hypot(a[0] - pin(hitEl)![0], a[1] - pin(hitEl)![1]) ? q : a)) : undefined;
      const sideV = Math.abs(port[0] - b.x) < 1 || Math.abs(port[0] - (b.x + b.w)) < 1;   // on the left or right side
      const leg = (p: number[], q: number[]) => sideV ? [p, [q[0], p[1]], q] : [p, [p[0], q[1]], q];
      return { key: r.key, color: r.a, flow: leg(port, target), ret: g ? leg(ret, g) : undefined, dot: target };
    }).filter(Boolean) as { key: string; color: string; flow: number[][]; ret?: number[][]; dot: number[] }[];
  }, [m, plantLeaf, lay, routed, boxOf, ownerAt]);

  // what to plot: nothing until a port, an element, the input u or a dashboard tile is clicked
  const flowSel = sel?.type === 'flow' ? routed.find(r => r.key === sel.id) : undefined;
  const traceOf = flowSel ? (sel?.q === 'e' ? `V(${flowSel.flow.node})` : flowSel.flow.element) : sel?.type === 'el' ? sel.id : sel?.type === 'instr' ? 'B§R' : undefined;
  useEffect(() => {
    if (!traceOf) { setTrace(undefined); return; }
    let live = true; setTrace(undefined); setTraceBusy(true);
    api<Trace>('/trace', { scenario, element: traceOf }).then(r => { if (live) setTrace(r); }).catch(() => { if (live) setTrace(undefined); }).finally(() => { if (live) setTraceBusy(false); });
    return () => { live = false; };
  }, [traceOf, scenario]);

  if (error) return <p className="notice bad">{error}</p>;
  if (!m) return <div className="panel empty"><p className="muted">Loading the circuit…</p></div>;

  const colorOf = (id: string) => id === 'Banks' ? sectorColor(t, 'Wholesale banks') : id === 'NFC' ? sectorColor(t, 'Domestic goods producers') : sectorColor(t, id);
  const loopStyle = (id: string) => id === 'Target setting' ? FIG.target : id === 'Controller' ? FIG.ctrl : id === 'Rate path' ? FIG.path : id === PLANT ? FIG.plant : id === 'Output' ? FIG.output : null;
  const pathD = (q: number[][]) => 'M' + q.map(p => p.join(' ')).join(' L');

  // ---------------------------------------------------------------- the drawing of one box (or all of it)
  function circuit(owner: string | null, k = 1, only = false) {
    const mine = (x: number, y: number) => owner == null || ownerAt(x, y) === owner;
    const els = m!.elements.filter(e => owner == null || e.sector === owner);
    const wires = m!.wires.filter(w => mine((w[0] + w[2]) / 2, (w[1] + w[3]) / 2));
    const flags = m!.flags.filter(f => mine(f.x, f.y));
    const texts = only ? [] : m!.texts.filter(x => mine(x.x, x.y) && !rects[x.text.trim()]);
    const fs = Math.min(Math.max(11 * px * k, 6), 400);
    return <>
      {texts.map((x, i) => <text key={i} x={x.x} y={x.y} className="asctext" fontSize={10 + x.size * 9} textAnchor={x.align.endsWith('Right') ? 'end' : 'start'} dominantBaseline="middle"
        transform={x.align.startsWith('V') ? `rotate(-90 ${x.x} ${x.y})` : undefined}>{x.text}</text>)}
      <g className="wires">{wires.map((w, i) => <line key={i} x1={w[0]} y1={w[1]} x2={w[2]} y2={w[3]}/>)}</g>
      {flags.map((f, i) => f.ground ? <path key={i} className="gnd" d={`M${f.x} ${f.y} v14 m-22 0 h44 m-32 10 h20 m-10 10 h0`}/>
        : <text key={i} x={f.x + 8} y={f.y - 10} className="flag" fontSize={fs * 0.8}>{f.name}</text>)}
      {els.map(e => {
        const cx = (e.pins[0][0] + e.pins[1][0]) / 2, cy = (e.pins[0][1] + e.pins[1][1]) / 2, on = sel?.type === 'el' && sel.id === e.name;
        return <g key={e.name} data-el={e.name} className={'el' + (on ? ' sel' : '')}>
          <g transform={transform(e)} style={{ stroke: KIND[e.kind] }} className="glyph"><Glyph symbol={e.symbol}/></g>
          <circle cx={cx} cy={cy} r={46} className="mark" style={{ fill: KIND[e.kind] }}/>
          <circle cx={cx} cy={cy} r={Math.max(56, 9 * px * k)} className="hit"/>
          <text x={cx + 40} y={cy} className="ellabel" fontSize={fs} dominantBaseline="middle">{e.ref}</text>
        </g>;
      })}
    </>;
  }

  // ---------------------------------------------------------------- a block (as the housing app draws them: header band, toggle)
  function block(id: string) {
    const isOpen = open.includes(id), leaf = !CHILDREN[id], b = isOpen && id === loopLeaf ? expanded(id) : boxOf(id);
    const fig = loopStyle(id), c = fig ? fig.stroke : colorOf(id);
    const selected = sel?.type === 'block' && sel.id === id, hl = hover === id, big = !!fig;
    const offLoop = (id === 'Controller' && !closed) || (id === 'Rate path' && closed);
    const fill = fig ? (isOpen ? withAlpha(fig.fill, 0.22) : fig.fill) : isOpen && leaf ? t.panel : withAlpha(c, isOpen ? 0.06 : 0.12);
    const title = TITLE[id];
    const dr = drawingOf(id), r = dr ? rects[dr] : undefined;
    let innerSvg: ReactNode = null;
    if (isOpen && r) {
      if (id === plantLeaf && lay.leafView) {   // in place, at the layout's exact scale (the port wiring maps onto it)
        const lv = lay.leafView, vw = r.x2 - r.x1 + 2 * LEAF_MARGIN, vh = r.y2 - r.y1 + 2 * LEAF_MARGIN;
        innerSvg = <svg x={lv.x} y={lv.y} width={vw * lv.s} height={vh * lv.s} viewBox={`${r.x1 - LEAF_MARGIN} ${r.y1 - LEAF_MARGIN} ${vw} ${vh}`} preserveAspectRatio="none" className="inner-circuit">{circuit(dr!, 1 / lv.s)}</svg>;
      } else if (leaf) {
        const vw = r.x2 - r.x1 + 80, vh = r.y2 - r.y1 + 80, iw = b.w - 12, ih = b.h - HEAD - 8, k = Math.max(vw / iw, vh / ih);
        innerSvg = <svg x={b.x + 6} y={b.y + HEAD + 2} width={iw} height={ih} viewBox={`${r.x1 - 40} ${r.y1 - 40} ${vw} ${vh}`} preserveAspectRatio="xMidYMid meet" className="inner-circuit">{circuit(dr!, k)}</svg>;
      } else {   // an opened agent with its own elements (NFC's goods market): faint, under its sub-agents
        innerSvg = <svg x={b.x} y={b.y + HEAD} width={b.w} height={b.h - HEAD} viewBox={`${r.x1} ${r.y1} ${r.x2 - r.x1} ${r.y2 - r.y1}`} preserveAspectRatio="xMidYMid meet" className="inner-circuit faint">{circuit(dr!, (r.x2 - r.x1) / b.w, true)}</svg>;
      }
    }
    return <g key={id} className={'blk' + (isOpen ? ' open' : '') + (selected ? ' sel' : '') + (hl ? ' focus' : '') + (fig ? ' fig' : '') + (offLoop ? ' offloop' : '')} data-block={id}
      onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover(h => h === id ? undefined : h)}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={big ? 4 : 6} style={{ fill, stroke: c, strokeWidth: selected ? 2.6 : 1.4, strokeDasharray: offLoop ? '8 6' : undefined }}/>
      {fig && !isOpen ? <>
        <text x={b.x + b.w / 2} y={b.y + b.h / 2 - 8} textAnchor="middle" fontSize={27} className="fig-title">{title[0]}</text>
        <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 22} textAnchor="middle" fontSize={id === PLANT ? 17 : 19} style={{ fill: fig.sub }}>{offLoop ? (id === 'Controller' ? '(ECB) · out of the loop' : '(given) · not used') : title[1]}</text>
      </> : <>
        <path d={`M${b.x} ${b.y + HEAD} V${b.y + 6} Q${b.x} ${b.y} ${b.x + 6} ${b.y} H${b.x + b.w - 6} Q${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + 6} V${b.y + HEAD} Z`} style={{ fill: fig ? fig.fill : withAlpha(c, 0.3), stroke: c, strokeWidth: 1.2 }}/>
        <text x={b.x + 12} y={b.y + HEAD / 2} dominantBaseline="central" fontSize={Math.min(Math.max(13 * px, 15), HEAD * 0.62)} className="blk-title">{title ? `${title[0]} ${title[1]}` : id}</text>
        {INFO[id] && !isOpen && b.h > HEAD + 30 && <text x={b.x + 12} y={b.y + HEAD + 24} fontSize={Math.min(Math.max(11 * px, 12), 22)} className="blk-sub">{INFO[id].role}</text>}
      </>}
      {innerSvg}
      {id !== 'Target setting' && id !== 'Rate path' && <g className="blk-toggle" data-toggle={id} transform={`translate(${b.x + b.w - 20} ${b.y + (fig && !isOpen ? 20 : HEAD / 2)})`}>
        <rect x={-10} y={-10} width={20} height={20} rx={3} strokeWidth={1.3}/><path d={'M-5 0 H5' + (isOpen ? '' : ' M0 -5 V5')} strokeWidth={2}/>
        <title>{isOpen ? `Close ${id}` : `Open ${id}`}</title></g>}
    </g>;
  }

  // ---------------------------------------------------------------- the loop of the figure (open or closed)
  const P = boxOf(PLANT), O = boxOf('Output'), RG = regionOf(P);
  const yc = CTRL.y + CTRL.h / 2, yr = RATE.y + RATE.h / 2, fbY = RG.y + RG.h + 70;
  const dx = P.x + P.w / 2, sw = { a: [SWITCH_X - 22, yc], b: [SWITCH_X - 22, yc + 46], p: [SWITCH_X + 22, yc] };
  const on = (live: boolean) => live ? '' : ' off';
  const L = (d: string, cls = '') => <path d={d} className={'figline' + cls} markerEnd="url(#fig-ah)"/>;
  const lab = (x: number, y: number, s: string, cls = 'figlab', anchor: 'middle' | 'start' | 'end' = 'middle') => <text x={x} y={y} textAnchor={anchor} className={cls}>{s}</text>;
  const swx = (SUM.x + O.x) / 2 - 300;   // the loop switch on the feedback line (open in open loop)

  const selBlock = sel?.type === 'block' ? sel.id : undefined;
  const el = sel?.type === 'el' ? m.elements.find(e => e.name === sel.id) : undefined;
  const dashOf = (name: string) => dash.find(d => d.name === name);
  const blockFlows = selBlock ? routed.filter(r => r.a === selBlock || r.b === selBlock) : [];
  const crumbs = ['Feedback loop', ...open];
  const fs = Math.min(Math.max(11 * px, 9), 60);
  const groups = [...new Set(dash.map(d => d.group))];

  return <div className="mapwrap">
    <div className="panel map-panel">
      <div className="pick-row map-head">
        {whole ? <span className="crumbs"><b>Whole circuit</b></span> : <nav className="crumbs" aria-label="Layers">{crumbs.map((p, i) => <span key={p}>{i > 0 && <span className="sep">›</span>}
          <button className={'link-btn' + (i === crumbs.length - 1 ? ' here' : '')} onClick={() => crumb(i)}>{p}</button></span>)}</nav>}
        <div className="map-tools">
          <span className={`mode ${closed ? 'closed' : 'open'}`}>{closed ? 'closed loop' : 'open loop'}</span>
          <label className="check small"><input type="checkbox" checked={whole} onChange={e => showWhole(e.target.checked)}/>Whole circuit</label>
          <button className="ghost icon" onClick={() => zoomCentre(1 / 1.4)} aria-label="Zoom in" title="Zoom in">+</button>
          <button className="ghost icon" onClick={() => zoomCentre(1.4)} aria-label="Zoom out" title="Zoom out">−</button>
          <button className="ghost" onClick={() => whole ? showWhole(true) : flyTo(view(focusBox(open), 0.03))} title="Show everything">Fit</button>
        </div>
      </div>
      <p className="muted note">Click <b>+</b> to open a block in place: the plant shows the agents of your drawing, Banks and NFC their sub-agents, any other agent its circuit with the port pairs wired to its nodes. Click <b>f</b> (flow) or <b>e</b> (effort) at a port, the input u, an element or a dashboard tile to plot it. The loop follows the Open / Closed switch on the left.</p>
      <svg ref={svg} className="schem blockmap" viewBox={vb.join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Circuit map"
        onPointerDown={e => { if (e.button === 0) drag.current = { x: e.clientX, y: e.clientY, vb, moved: false }; }}
        onPointerMove={e => {
          const d = drag.current; if (!d) return;
          const ddx = e.clientX - d.x, ddy = e.clientY - d.y;
          if (!d.moved && Math.abs(ddx) + Math.abs(ddy) > 4) { d.moved = true; svg.current?.setPointerCapture(e.pointerId); }
          if (!d.moved) return;
          cancelAnimationFrame(anim.current);
          setVb([d.vb[0] - ddx * px, d.vb[1] - ddy * px, d.vb[2], d.vb[3]]);
        }}
        onPointerUp={e => {
          const d = drag.current; drag.current = null;
          if (!d || d.moved) return;
          const hit = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
          const tg = hit?.closest('[data-toggle]'), elh = hit?.closest('[data-el]'), fl = hit?.closest('[data-flow]'), ins = hit?.closest('[data-instr]'), bl = hit?.closest('[data-block]');
          if (tg) toggle(tg.getAttribute('data-toggle')!);
          else if (hit?.closest('[data-scrim]') && loopLeaf) toggle(loopLeaf);
          else if (elh) setSel({ type: 'el', id: elh.getAttribute('data-el')! });
          else if (fl) setSel({ type: 'flow', id: fl.getAttribute('data-flow')!, q: (hit?.closest('[data-q]')?.getAttribute('data-q') as 'e' | 'f' | null) ?? 'f' });
          else if (ins) { const id = ins.getAttribute('data-instr')!; setSel(id === 'd' ? { type: 'el', id: 'B§Shock' } : id === 'pi*' ? { type: 'el', id: 'B§Target_CPI' } : id === 'pi' ? { type: 'el', id: 'B§CPI_filtered' } : id === 'P' ? { type: 'el', id: 'B§P' } : { type: 'instr', id }); }
          else if (bl) { const id = bl.getAttribute('data-block')!; setSel(id === 'Rate path' ? { type: 'instr', id: 'u' } : { type: 'block', id }); }
          else setSel(undefined);
        }}
        onDoubleClick={e => { const tg = e.target as Element, bl = tg.closest('[data-block]'); if (bl && !tg.closest('[data-el]') && !tg.closest('[data-toggle]') && !tg.closest('[data-flow]')) { const id = bl.getAttribute('data-block')!; if (!open.includes(id)) toggle(id); } }}>
        <defs>
          <marker id="fig-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="context-stroke"/></marker>
        </defs>
        {whole ? circuit(null) : <>
          <rect x={RG.x} y={RG.y} width={RG.w} height={RG.h} rx={10} className="fig-region" style={{ fill: withAlpha(FIG.region.fill, 0.55), stroke: FIG.region.stroke }}/>
          <text x={RG.x + RG.w / 2} y={RG.y + RG.h - 18} textAnchor="middle" className="fig-region-title">ECB macroeconomic models</text>
          <g className="figloop">
            <g data-instr="pi*" className="figsig">{L(`M${TARGET.x + TARGET.w} ${SUM.y} H${SUM.x - SUM.r}`)}{lab((TARGET.x + TARGET.w + SUM.x - SUM.r) / 2, SUM.y - 12, 'π*', 'figsym')}{lab((TARGET.x + TARGET.w + SUM.x) / 2, SUM.y + 30, 'Setpoint')}{lab((TARGET.x + TARGET.w + SUM.x) / 2, SUM.y + 50, '(Target)')}</g>
            <circle cx={SUM.x} cy={SUM.y} r={SUM.r} className="fig-sum"/>
            <path d={`M${SUM.x - SUM.r * 0.7} ${SUM.y - SUM.r * 0.7} L${SUM.x + SUM.r * 0.7} ${SUM.y + SUM.r * 0.7} M${SUM.x + SUM.r * 0.7} ${SUM.y - SUM.r * 0.7} L${SUM.x - SUM.r * 0.7} ${SUM.y + SUM.r * 0.7}`} className="fig-sumx"/>
            {lab(SUM.x - SUM.r - 6, SUM.y - SUM.r - 4, '+', 'figsign', 'end')}{lab(SUM.x - SUM.r - 6, SUM.y + SUM.r + 18, '−', 'figsign', 'end')}
            <g>{L(`M${SUM.x + SUM.r} ${SUM.y} H${CTRL.x}`, on(closed))}{lab((SUM.x + CTRL.x) / 2, SUM.y - 12, 'e', 'figsym')}{lab((SUM.x + CTRL.x) / 2, SUM.y + 30, 'Error')}</g>
            {/* u: from the controller (closed loop) or the given rate path (open loop), selected by the switch */}
            <path d={`M${CTRL.x + CTRL.w} ${yc} H${sw.a[0]}`} className={'figline' + on(closed)}/>
            <path d={`M${RATE.x + RATE.w} ${yr} H${sw.b[0]} V${sw.b[1]}`} className={'figline' + on(!closed)}/>
            <g className="fig-switch"><circle cx={sw.a[0]} cy={sw.a[1]} r={4}/><circle cx={sw.b[0]} cy={sw.b[1]} r={4}/><circle cx={sw.p[0]} cy={sw.p[1]} r={4}/>
              <line x1={sw.p[0]} y1={sw.p[1]} x2={closed ? sw.a[0] + 4 : sw.b[0] + 3} y2={closed ? sw.a[1] : sw.b[1] - 3} className="lever"/>
              {lab(sw.p[0], sw.b[1] + 30, closed ? 'u from the controller' : 'u from the rate path', 'figlab small')}</g>
            <g data-instr="u" className={'figsig' + (sel?.type === 'instr' ? ' on' : '')}>
              <path d={`M${sw.p[0]} ${yc} H${P.x}`} className="figsig-hit"/>{L(`M${sw.p[0] + 4} ${yc} H${P.x}`)}
              {lab((sw.p[0] + P.x) / 2, yc - 12, 'u', 'figsym')}{lab((sw.p[0] + P.x) / 2, yc + 26, 'policy rate r', 'figlab small')}
            </g>
            <g data-instr="d" className="figsig dist">{L(`M${dx} ${P.y - 190} V${P.y}`, ' red')}{lab(dx + 12, P.y - 110, 'd', 'figsym red', 'start')}
              {lab(dx - 14, P.y - 150, 'Disturbance', 'figlab red', 'end')}{lab(dx - 14, P.y - 126, '(Economic shock)', 'figlab red', 'end')}</g>
            <g data-instr="P" className="figsig">{L(`M${P.x + P.w} ${O.y + O.h / 2} H${O.x}`)}{lab((P.x + P.w + O.x) / 2, O.y + O.h / 2 - 12, 'P', 'figsym')}</g>
            <g data-instr="pi" className="figsig">
              {closed ? L(`M${O.x + O.w / 2} ${O.y + O.h} V${fbY} H${SUM.x} V${SUM.y + SUM.r}`)
                : <>{/* open loop: the feedback is cut at the switch */}
                  <path d={`M${O.x + O.w / 2} ${O.y + O.h} V${fbY} H${swx + 24}`} className="figline"/>
                  <path d={`M${swx - 24} ${fbY} H${SUM.x} V${SUM.y + SUM.r}`} className="figline off" markerEnd="url(#fig-ah)"/>
                  <g className="fig-switch"><circle cx={swx - 24} cy={fbY} r={4}/><circle cx={swx + 24} cy={fbY} r={4}/><line x1={swx + 24} y1={fbY} x2={swx - 18} y2={fbY - 26} className="lever"/></g>
                  {lab(swx, fbY + 30, 'loop open', 'figlab small')}</>}
              {lab((SUM.x + O.x) / 2 + 150, fbY - 12, 'π', 'figsym')}
            </g>
          </g>
          {/* containers first (plant, opened agents), then the blocks; port pairs over them; controller / output open over a scrim */}
          {shownBlocks.filter(id => CHILDREN[id] && open.includes(id)).map(block)}
          {shownBlocks.filter(id => !(CHILDREN[id] && open.includes(id)) && id !== loopLeaf).map(block)}
          <g className="flows">{routed.map(r => {
            const c = colorOf(r.a), on2 = sel?.type === 'flow' && sel.id === r.key, near = hover && (r.a === hover || r.b === hover);
            const k = Math.min(Math.max(px, 1), 1.8), back = offsetPts(r.pts, 12), n = r.pts.length;
            let li = 1; for (let i = 2; i < n; i++) if (dist(r.pts[i - 1], r.pts[i]) > dist(r.pts[li - 1], r.pts[li])) li = i;
            const t0 = r.pts[li - 1], t1 = r.pts[li], tri = along(t0, t1, dist(t0, t1) * 0.5), ang = Math.atan2(t1[1] - t0[1], t1[0] - t0[0]) * 180 / Math.PI;
            return <g key={r.key} data-flow={r.key} className={'flow pair' + (on2 ? ' sel' : '') + (near ? ' near' : '')}>
              <path d={pathD(r.pts)} className="flow-hit"/><path d={pathD(back)} className="flow-hit"/>
              <path d={pathD(back)} className="return-rail" style={{ stroke: c }}/>
              <path d={pathD(r.pts)} className="flow-line" style={{ stroke: c }}/>
              <path d="M-6 -5L5 0L-6 5Z" style={{ fill: c }} transform={`translate(${tri[0]} ${tri[1]}) rotate(${ang}) scale(${k})`}/>
              <PortMarks a={r.pts[0]} b={r.pts[1]} ra={back[0]} rb={back[1]} c={c} k={k} on={on2 ? sel?.q : undefined} gap={r.gap[0]}/>
              <PortMarks a={r.pts[n - 1]} b={r.pts[n - 2]} ra={back[n - 1]} rb={back[n - 2]} c={c} k={k} on={on2 ? sel?.q : undefined} gap={r.gap[1]}/>
              <text x={r.label.x} y={r.label.y} className="flow-label" fontSize={fs} textAnchor="middle" dy={r.label.vertical ? 0 : -8}
                transform={r.label.vertical ? `rotate(-90 ${r.label.x} ${r.label.y}) translate(0 -8)` : undefined} style={{ fill: c }}>{pretty(r.flow.ref)}</text>
              <title>{`${pretty(r.flow.ref)}: ${r.a} → ${r.b}. Click f (or the rails) for the flow, e for the effort.`}</title>
            </g>;
          })}</g>
          {/* inside the opened agent: the port pairs continue to their node (flow rail) and to ground (return rail) */}
          <g className="inner-wiring">{inner.map(w => <g key={w.key} data-flow={w.key} className={'flow pair' + (sel?.type === 'flow' && sel.id === w.key ? ' sel' : '')}>
            <path d={pathD(w.flow)} className="flow-hit"/>
            {w.ret && <path d={pathD(w.ret)} className="return-rail" style={{ stroke: colorOf(w.color) }}/>}
            <path d={pathD(w.flow)} className="flow-line inner" style={{ stroke: colorOf(w.color) }}/>
            <circle cx={w.dot[0]} cy={w.dot[1]} r={5} className="node-dot" style={{ fill: colorOf(w.color) }}/>
          </g>)}</g>
          {loopLeaf && <rect className="scrim" x={-20000} y={-20000} width={60000} height={60000} data-scrim="1"/>}
          {loopLeaf && block(loopLeaf)}
        </>}
      </svg>
      <p className="muted note legend-line"><span className="lg pairkey"/> port pair: flow rail (thick, triangle in the direction of the flow at the steady state) and return rail · <b>f</b> flow, <b>e</b> effort (the node voltage against its return) · inside an opened agent the rails run on to their node and to ground · loop blocks in the colours of the ECB figure</p>

      {/* the dashboard: the current sources outside the plant boxes, which the plant imports */}
      <section className="dash">
        <h3>Imported variables <span className="muted small">· current sources drawn outside the plant: the plant reads them, they are not part of its circuit yet</span></h3>
        {!vals && <p className="muted note">Values appear once a simulation has run.</p>}
        {groups.map(g => <div key={g} className="dash-group">
          <h4>{g}</h4>
          <div className="dash-grid">{dash.filter(d => d.group === g).map(d => {
            const v = vals?.[d.name], onT = sel?.type === 'el' && sel.id === d.name;
            return <button key={d.name} className={'dash-tile' + (onT ? ' on' : '')} onClick={() => setSel({ type: 'el', id: d.name })} title={d.expr}>
              <span className="dash-name">{pretty(d.ref)}</span>
              <span className="dash-val">{v ? fmt(v.end) : '–'}</span>
              <span className="dash-sub">{v ? `start ${fmt(v.start)}` : ' '}{d.readers.length ? ` · read by ${d.readers.length}` : ''}</span>
            </button>;
          })}</div>
        </div>)}
      </section>

      {sel && <aside className="panel elinfo floating">
        <button className="pin-close" onClick={() => setSel(undefined)} aria-label="Hide details" title="Hide details">×</button>
        {flowSel ? <>
          <h3>{pretty(flowSel.flow.ref)}</h3>
          <p className="small"><span className="dot" style={{ background: colorOf(flowSel.a) }}/> {flowSel.a} → <span className="dot" style={{ background: colorOf(flowSel.b) }}/> {flowSel.b}</p>
          <div className="segmented small-seg qpick" role="group" aria-label="Quantity">
            <button className={sel?.q !== 'e' ? 'active' : ''} onClick={() => setSel({ type: 'flow', id: flowSel.key, q: 'f' })}>f: flow</button>
            <button className={sel?.q === 'e' ? 'active' : ''} onClick={() => setSel({ type: 'flow', id: flowSel.key, q: 'e' })}>e: effort</button>
          </div>
          <p className="muted small">{sel?.q === 'e'
            ? <>The effort across the port: the voltage of node <code>{flowSel.flow.node}</code> against its return (ground).</>
            : <>The flow through the port: the current through <code>{flowSel.flow.element}</code>; {flowSel.flow.steady.toPrecision(3)} per time unit at the steady state.</>}</p>
          {traceBusy ? <p className="muted note">Simulating the current scenario for this port…</p>
            : trace ? <Chart title={trace.trace} unit={sel?.q === 'e' ? 'effort (node voltage)' : 'flow per time unit'} height={220} group={null} lines={[{ name: `${pretty(flowSel.flow.ref)} · ${sel?.q === 'e' ? 'e' : 'f'}`, x: trace.years, y: trace.values, color: colorOf(flowSel.a) }]}/>
            : <p className="muted note">No trace for this port.</p>}
        </> : sel.type === 'instr' ? <>
          <h3>u: the policy rate r</h3>
          <p className="muted small">The plant's input, element <code>B§R</code>: {closed ? 'set by the controller (the rule B_PI through the smoothing R15·C8): closed loop.' : 'the given rate path (base rate, then a step; the sliders on the left): open loop, the controller is out of the loop.'}</p>
          {traceBusy ? <p className="muted note">Simulating…</p> : trace ? <Chart title={trace.trace} unit="rate" height={220} group={null} lines={[{ name: 'u = r', x: trace.years, y: trace.values, color: FIG.ctrl.stroke }]}/> : null}
        </> : el ? <>
          <h3>{el.ref}</h3>
          <p className="muted small">{el.kind}{el.sector ? ` · ${blockOfDrawing(el.sector)}` : ' · outside the plant boxes (dashboard)'} · netlist name <code>{el.name}</code></p>
          {el.nodes.length > 0 && <p className="small">Nodes: <code>{el.nodes.join(' → ')}</code></p>}
          <pre className="expr">{el.expr || '—'}</pre>
          {dashOf(el.name)?.readers.length ? <p className="small">Read by: {dashOf(el.name)!.readers.map(r => `${r.ref}${r.sector ? ` (${blockOfDrawing(r.sector)})` : ''}`).join(', ')}</p> : null}
          {traceBusy ? <p className="muted note">Simulating the current scenario for this trace…</p>
            : trace ? <Chart title={trace.trace} unit={el.kind === 'inductor' || el.kind.includes('current') ? 'current (flow)' : 'value'} height={220} group={null}
                lines={[{ name: trace.trace, x: trace.years, y: trace.values, color: KIND[el.kind] ?? t.inflation }]}/>
            : <p className="muted note">No trace for this element.</p>}
        </> : selBlock ? <>
          <h3>{TITLE[selBlock] ? `${TITLE[selBlock][0]} ${TITLE[selBlock][1]}` : selBlock}</h3>
          {INFO[selBlock] && <><p className="muted small">{INFO[selBlock].role}</p><p className="small">{INFO[selBlock].about}</p></>}
          {INFO[selBlock]?.element ? <button className="ghost" onClick={() => setSel({ type: 'el', id: INFO[selBlock].element! })}>Show {INFO[selBlock].element}</button>
            : <button className="ghost" onClick={() => toggle(selBlock)}>{open.includes(selBlock) ? 'Close' : 'Open'} {selBlock}</button>}
          {blockFlows.length > 0 && <><h3 className="mt">Port pairs at this level</h3>
            <ul className="conn">{blockFlows.map(r => <li key={r.key}><button className="link-btn" onClick={() => setSel({ type: 'flow', id: r.key, q: 'f' })}>{pretty(r.flow.ref)}</button>
              <small className="muted"> {r.a === selBlock ? `→ ${r.b}` : `← ${r.a}`}</small></li>)}</ul></>}
        </> : null}
      </aside>}
    </div>
  </div>;
}
