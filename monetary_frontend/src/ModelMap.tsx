import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Chart } from './Chart';
import { SavedRun } from './types';
import { sectorColor, Theme, useTheme, withAlpha } from './viz';

// The circuit map, nested like the housing app's model map:
//   the policy loop:  Central Bank (controller) → Eurozone economy (plant) → CPI values (sensor) → back; Shock and the
//                     Rest of the world outside the plant;
//   the plant opened: its agents Households, Fiscal authority, Banking, NFC;
//   an agent opened:  its sub-agents (Banking: wholesale banks, retail banks, interest rates; NFC: goods market,
//                     domestic goods producers, capital producers);
//   a (sub-)agent without sub-agents opened: its own circuit from the user's LTspice drawing.
// Flows are straight, right-angled lines between the boxes that are visible at that level, one per flow element
// (backend schematic.agent_flows: read from the netlist at the steady state, arrow in the direction the current runs).
// Nothing is plotted until a flow or an element is clicked.

interface El { name: string; ref: string; symbol: string; kind: string; rot: string; x: number; y: number; pins: number[][]; sector: string | null; expr: string; nodes: string[] }
interface Rect { x1: number; y1: number; x2: number; y2: number; title: string | null }
interface Txt { x: number; y: number; align: string; size: number; text: string }
interface Flow { element: string; ref: string; kind: string; from: string; to: string; node: string; steady: number }
export interface MapData { bounds: number[]; wires: number[][]; flags: { x: number; y: number; name: string; ground: boolean }[]; rects: Rect[]; sectors: string[]; texts: Txt[]; elements: El[]; flows: Flow[] }
interface Trace { element: string; trace: string; years: number[]; values: number[] }
type Box = { x: number; y: number; w: number; h: number };
type VB = [number, number, number, number];

// ---------------------------------------------------------------- the hierarchy
const PLANT = 'Eurozone economy';
const AGENTS = ['Fiscal authority', 'Banking', 'NFC', 'Households'];
const CHILDREN: Record<string, string[]> = {
  [PLANT]: AGENTS,
  Banking: ['Wholesale banks', 'Retail banks', 'Interest rates'],
  NFC: ['Goods market', 'Domestic goods producers', 'Capital producers'],
};
const PARENT: Record<string, string> = Object.fromEntries(Object.entries(CHILDREN).flatMap(([p, cs]) => cs.map(c => [c, p])));
const OUTSIDE = ['Central Bank', 'Shock', 'Rest of the world', 'CPI values'];
// map block -> box title in the LTspice drawing (the leaves; their circuit is drawn when opened)
const DRAWING: Record<string, string> = {
  Households: 'Households', 'Fiscal authority': 'Fiscal Authority', 'Wholesale banks': 'Wholesale banks', 'Retail banks': 'Retail banks',
  'Interest rates': 'Interest Rates', 'Goods market': 'NFC', 'Domestic goods producers': 'Domestic goods producers', 'Capital producers': 'Capital producers',
  'Central Bank': 'Central Bank', 'CPI values': 'CPI values', Shock: 'Shock', 'Rest of the world': 'Foreign Sector',
};
const FROM_DRAWING: Record<string, string> = Object.fromEntries(Object.entries(DRAWING).map(([k, v]) => [v, k]));
const COLOR_KEY: Record<string, string> = {  // the sector colour each block takes (viz.SECTOR_ORDER)
  Households: 'Households', 'Fiscal authority': 'Fiscal Authority', Banking: 'Wholesale banks', 'Wholesale banks': 'Wholesale banks', 'Retail banks': 'Retail banks',
  NFC: 'Domestic goods producers', 'Domestic goods producers': 'Domestic goods producers', 'Capital producers': 'Capital producers', 'Goods market': 'Domestic goods producers',
  'Central Bank': 'Central Bank', 'Rest of the world': 'Foreign Sector',
};
const INFO: Record<string, { role: string; about: string }> = {
  'Central Bank': { role: 'controller', about: 'The policy rule B_PI and the rate smoothing R15·C8 set the policy rate R (closed loop), or the given path B§R does (open loop).' },
  [PLANT]: { role: 'plant', about: 'Households, the fiscal authority, banking and the non-financial corporations. Open it to see the agents and the flows between them.' },
  'CPI values': { role: 'sensor', about: 'Measures the price level P, inflation CPI = 120·d ln P/dt and its filtered value, and holds the target π*. Fed back to the central bank.' },
  Shock: { role: 'disturbance', about: 'An external shock into the goods market (B3 is not connected in the netlist).' },
  'Rest of the world': { role: 'outside the plant', about: 'Imports, exports, foreign bonds and the exchange rate: the foreign sector of the drawing.' },
  Households: { role: 'agent', about: 'Income, consumption, savings and deposits, bonds, labour supply and the taxes households pay.' },
  'Fiscal authority': { role: 'agent', about: 'Government spending, taxes, bond issuance, coupons and debt.' },
  Banking: { role: 'agent', about: 'Wholesale banks, retail banks and the interest rates they set. Open it for the sub-agents.' },
  NFC: { role: 'agent', about: 'Non-financial corporations: the goods market, domestic goods producers and capital producers. Open it for the sub-agents.' },
  'Wholesale banks': { role: 'sub-agent of Banking', about: 'Bank balance sheet: deposits, wholesale loans, bond holdings, net worth and dividends.' },
  'Retail banks': { role: 'sub-agent of Banking', about: 'Loans to firms and capital producers, funded by wholesale loans.' },
  'Interest rates': { role: 'sub-agent of Banking', about: 'From the policy rate to the rates the economy pays: wholesale, retail loan, savings and deposit rates, leverage, the long-term yield.' },
  'Goods market': { role: 'sub-agent of NFC', about: 'Aggregate supply, inventory and the supply of domestic and imported goods.' },
  'Domestic goods producers': { role: 'sub-agent of NFC', about: 'Production, revenue, labour demand, wages, loans and interest.' },
  'Capital producers': { role: 'sub-agent of NFC', about: 'Investment and the capital stock.' },
};

// ---------------------------------------------------------------- layout (map units)
const ECO_CLOSED: Box = { x: 420, y: 250, w: 620, h: 330 };
const ECO_OPEN: Box = { x: 420, y: 170, w: 1560, h: 1080 };
const REL: Record<string, Box> = {   // agents relative to the opened plant, sub-agents relative to their agent
  'Fiscal authority': { x: 70, y: 90, w: 460, h: 300 },
  Banking: { x: 980, y: 90, w: 520, h: 430 },
  NFC: { x: 70, y: 570, w: 520, h: 450 },
  Households: { x: 980, y: 650, w: 520, h: 370 },
  'Wholesale banks': { x: 16, y: 56, w: 236, h: 180 }, 'Retail banks': { x: 268, y: 56, w: 236, h: 180 }, 'Interest rates': { x: 16, y: 256, w: 488, h: 156 },
  'Goods market': { x: 16, y: 56, w: 488, h: 130 }, 'Domestic goods producers': { x: 16, y: 204, w: 236, h: 230 }, 'Capital producers': { x: 268, y: 204, w: 236, h: 230 },
};
function outsideBox(id: string, ecoOpen: boolean): Box {
  const e = ecoOpen ? ECO_OPEN : ECO_CLOSED;
  switch (id) {
    case 'Central Bank': return { x: 40, y: ECO_CLOSED.y + ECO_CLOSED.h / 2 - 75, w: 250, h: 150 };
    case 'Shock': return { x: e.x + 300, y: e.y - 150, w: 220, h: 86 };
    case 'Rest of the world': return { x: e.x + e.w + 130, y: e.y + e.h / 2 - 85, w: 260, h: 170 };
    default: return { x: e.x, y: e.y + e.h + 130, w: 320, h: 120 };   // CPI values
  }
}
const HEAD = 40;   // header band of a block

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
interface Path { key: string; flow: Flow; a: string; b: string; pts: number[][] }
interface Routed extends Path { label: { x: number; y: number; vertical: boolean } }
const LANE = 22, BEND = 160;
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
  const port: number[][] = list.map(() => [0, 0]);
  for (const [k, atts] of sides) {
    const b = box(k.split('|')[0]);
    atts.sort((x, y) => x.k - y.k);
    atts.forEach((a, j) => {
      const lo = horiz(a.side) ? b.y + HEAD + 12 : b.x + 24, hi = horiz(a.side) ? b.y + b.h - 12 : b.x + b.w - 24;
      port[a.i][a.end] = lo + (hi - lo) * (j + 1) / (atts.length + 1);
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
    return { ...f, pts: simplify(pts) };
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

export function ModelMap({ scenario, closed, run }: { scenario: unknown; closed: boolean; run?: SavedRun }) {
  const t = useTheme();
  const KIND = kindColor(t);
  const [m, setM] = useState<MapData>();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string[]>([]);           // opened blocks (ancestors first)
  const [whole, setWhole] = useState(false);
  const [sel, setSel] = useState<{ type: 'block' | 'flow' | 'el'; id: string }>();
  const [hover, setHover] = useState<string>();
  const [trace, setTrace] = useState<Trace>();
  const [traceBusy, setTraceBusy] = useState(false);
  const [vb, setVb] = useState<VB>([0, 0, 1760, 940]);
  const [px, setPx] = useState(1);
  const svg = useRef<SVGSVGElement>(null);
  const vbRef = useRef<VB>(vb);
  const anim = useRef(0);
  const drag = useRef<{ x: number; y: number; vb: VB; moved: boolean } | null>(null);
  vbRef.current = vb;

  useEffect(() => { api<MapData>('/model/map').then(setM).catch(e => setError(String(e.message ?? e))); }, []);
  const rects = useMemo(() => Object.fromEntries((m?.rects ?? []).filter(r => r.title).map(r => [r.title!, r])), [m]);
  const ownerAt = useCallback((x: number, y: number) => {
    let best: string | null = null, area = Infinity;
    for (const [k, r] of Object.entries(rects)) { const a = (r.x2 - r.x1) * (r.y2 - r.y1); if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2 && a < area) { best = k; area = a; } }
    return best;
  }, [rects]);

  const ecoOpen = open.includes(PLANT);
  const leafOpen = open.find(o => DRAWING[o] && !CHILDREN[o]);   // the block whose circuit is shown
  const boxOf = useCallback((id: string): Box => {
    if (id === PLANT) return ecoOpen ? ECO_OPEN : ECO_CLOSED;
    if (OUTSIDE.includes(id)) return outsideBox(id, ecoOpen);
    const p = PARENT[id], pb = boxOf(p), r = REL[id];
    return { x: pb.x + r.x, y: pb.y + r.y, w: r.w, h: r.h };
  }, [ecoOpen]);
  // an opened leaf grows to show its circuit: inside the plant it fills the plant, outside it grows around its centre
  const expanded = useCallback((id: string): Box => {
    if (PARENT[id]) return { x: ECO_OPEN.x + 16, y: ECO_OPEN.y + 50, w: ECO_OPEN.w - 32, h: ECO_OPEN.h - 66 };
    const b = boxOf(id), w = Math.max(b.w * 2.6, 680), h = Math.max(b.h * 2.6, 460);
    return { x: Math.max(10, b.x + b.w / 2 - w / 2), y: Math.max(10, b.y + b.h / 2 - h / 2), w, h };
  }, [boxOf]);
  const visible = useCallback((id: string): string => {   // the block a (sub-)agent is drawn in at this level
    let v = id;
    while (PARENT[v] && !open.includes(PARENT[v])) v = PARENT[v];
    return v;
  }, [open]);
  const shownBlocks = useMemo(() => {
    const out = [...OUTSIDE, PLANT];
    const add = (p: string) => { if (open.includes(p)) for (const c of CHILDREN[p] ?? []) { out.push(c); add(c); } };
    add(PLANT);
    return out;
  }, [open]);
  const ALL = useCallback((): Box => {
    const bs = shownBlocks.map(boxOf), x1 = Math.min(...bs.map(b => b.x)), y1 = Math.min(...bs.map(b => b.y));
    return { x: x1, y: y1, w: Math.max(...bs.map(b => b.x + b.w)) - x1, h: Math.max(...bs.map(b => b.y + b.h)) - y1 };
  }, [shownBlocks, boxOf]);

  // ---------------------------------------------------------------- camera
  const view = useCallback((b: Box, k = 0.06): VB => {
    const cw = svg.current?.clientWidth ?? 1000, ch = svg.current?.clientHeight ?? 700;
    const avail = sel && cw > 900 ? cw - 370 : cw;
    const p = Math.max(b.w, b.h) * k, bw = b.w + 2 * p, bh = b.h + 2 * p, sc = Math.max(bw / avail, bh / ch);
    return [b.x - p - (sc * avail - bw) / 2, b.y - p - (sc * ch - bh) / 2, sc * cw, sc * ch];
  }, [sel]);
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
    const w = Math.min(Math.max(v[2] * k, 30), whole ? 80000 : 8000), kk = w / v[2];
    setVb([cx - (cx - v[0]) * kk, cy - (cy - v[1]) * kk, v[2] * kk, v[3] * kk]);
  }, [whole]);
  const toSvg = (clientX: number, clientY: number) => {
    const p = new DOMPoint(clientX, clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse()); return [p.x, p.y];
  };
  useEffect(() => {   // non-passive wheel: zoom the map, not the page
    const node = svg.current; if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x, y] = toSvg(e.clientX, e.clientY);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(x, y, Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [m, zoomAt]);
  const zoomCentre = (k: number) => { const v = vbRef.current; zoomAt(v[0] + v[2] / 2, v[1] + v[3] / 2, k); };

  // ---------------------------------------------------------------- open / close
  const pathTo = (id: string): string[] => { const p: string[] = []; let v: string | undefined = id; while (v) { p.unshift(v); v = PARENT[v]; } return p; };
  function toggle(id: string) {
    if (open.includes(id)) {   // close it and everything inside
      const keep = open.slice(0, open.indexOf(id));
      setOpen(keep);
      const parent = keep[keep.length - 1];
      flyTo(view(parent ? boxOf(parent) : loopView(keep.includes(PLANT)), 0.04));
    } else {
      const next = pathTo(id).filter(x => CHILDREN[x] || x === id);
      setOpen(next);
      const nowEco = next.includes(PLANT);
      if (CHILDREN[id]) flyTo(view(id === PLANT ? ECO_OPEN : boxOfIn(id, nowEco), 0.04));
      else flyTo(view(PARENT[id] ? { x: ECO_OPEN.x + 16, y: ECO_OPEN.y + 50, w: ECO_OPEN.w - 32, h: ECO_OPEN.h - 66 } : expanded(id), 0.03));
    }
    setSel(undefined);   // opening or closing shows no card; a click on a block, flow or element does
  }
  const boxOfIn = (id: string, eco: boolean): Box => {   // box of id once the plant is (or is not) open
    if (OUTSIDE.includes(id)) return outsideBox(id, eco);
    if (id === PLANT) return eco ? ECO_OPEN : ECO_CLOSED;
    const pb = boxOfIn(PARENT[id], true), r = REL[id]; return { x: pb.x + r.x, y: pb.y + r.y, w: r.w, h: r.h };
  };
  const loopView = (eco: boolean): Box => {
    const bs = [...OUTSIDE, PLANT].map(id => boxOfIn(id, eco)), x1 = Math.min(...bs.map(b => b.x)), y1 = Math.min(...bs.map(b => b.y));
    return { x: x1, y: y1, w: Math.max(...bs.map(b => b.x + b.w)) - x1, h: Math.max(...bs.map(b => b.y + b.h)) - y1 };
  };
  function crumb(i: number) {
    const keep = i === 0 ? [] : open.slice(0, i);
    setOpen(keep); setSel(undefined);
    const last = keep[keep.length - 1];
    flyTo(view(last ? (CHILDREN[last] ? boxOfIn(last, true) : expanded(last)) : loopView(false), 0.04));
  }
  function showWhole(on: boolean) {
    setWhole(on); setSel(undefined); cancelAnimationFrame(anim.current);
    if (on && m) { const b = m.bounds; setVb([b[0], b[1], b[2] - b[0], b[3] - b[1]]); } else setVb(view(ALL(), 0.03));
  }
  useEffect(() => { if (m) setVb(view(loopView(false), 0.05)); }, [m]);  // start: the policy loop

  // the flows visible at this level, routed
  const paths = useMemo(() => {
    if (!m) return [];
    const seen = new Set<string>(), list: { key: string; flow: Flow; a: string; b: string }[] = [];
    for (const f of m.flows) {
      const fa = FROM_DRAWING[f.from], fb = FROM_DRAWING[f.to];
      if (!fa || !fb) continue;
      const a = visible(fa), b = visible(fb);
      if (a === b || (leafOpen && (a === leafOpen || b === leafOpen))) continue;
      const key = `${f.element}|${a}|${b}`; if (seen.has(key)) continue; seen.add(key);
      list.push({ key, flow: f, a, b });
    }
    const contains = (outer: string, inner: string) => { let v: string | undefined = inner; while (v) { v = PARENT[v]; if (v === outer) return true; } return false; };
    const headers = shownBlocks.filter(id => CHILDREN[id] && open.includes(id)).map(id => { const b = boxOf(id); return { x: b.x, y: b.y, w: b.w, h: HEAD }; });
    return route(list, boxOf, shownBlocks.filter(id => id !== leafOpen), contains, headers);
  }, [m, visible, boxOf, leafOpen, shownBlocks, open]);
  const routed = useMemo(() => placeLabels(paths, Math.min(Math.max(11 * px, 9), 60)), [paths, px]);

  // trace of the clicked flow or element (nothing is plotted before a click)
  const traceOf = sel?.type === 'flow' ? routed.find(r => r.key === sel.id)?.flow.element : sel?.type === 'el' ? sel.id : undefined;
  useEffect(() => {
    if (!traceOf) { setTrace(undefined); return; }
    let live = true; setTrace(undefined); setTraceBusy(true);
    api<Trace>('/trace', { scenario, element: traceOf }).then(r => { if (live) setTrace(r); }).catch(() => { if (live) setTrace(undefined); }).finally(() => { if (live) setTraceBusy(false); });
    return () => { live = false; };
  }, [traceOf, scenario]);

  if (error) return <p className="notice bad">{error}</p>;
  if (!m) return <div className="panel empty"><p className="muted">Loading the circuit…</p></div>;

  const colorOf = (id: string) => COLOR_KEY[id] ? sectorColor(t, COLOR_KEY[id]) : id === PLANT ? t.ink2 : t.muted;

  // ---------------------------------------------------------------- the drawing of one box (or all of it)
  function circuit(owner: string | null, k = 1) {
    const mine = (x: number, y: number) => owner == null || ownerAt(x, y) === owner;
    const els = m!.elements.filter(e => owner == null || e.sector === owner);
    const wires = m!.wires.filter(w => mine((w[0] + w[2]) / 2, (w[1] + w[3]) / 2));
    const flags = m!.flags.filter(f => mine(f.x, f.y));
    const texts = m!.texts.filter(x => mine(x.x, x.y) && !rects[x.text.trim()]);
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

  // ---------------------------------------------------------------- a block: header band, +/− toggle, children or circuit
  function block(id: string) {
    const isOpen = open.includes(id), leaf = !CHILDREN[id], b = isOpen && leaf ? expanded(id) : boxOf(id), c = colorOf(id);
    const selected = sel?.type === 'block' && sel.id === id, hl = hover === id;
    const r = rects[DRAWING[id]];
    const inner = isOpen && leaf && r ? (() => {
      const vw = r.x2 - r.x1 + 80, vh = r.y2 - r.y1 + 80, iw = b.w - 12, ih = b.h - HEAD - 8, k = Math.max(vw / iw, vh / ih);
      return <svg x={b.x + 6} y={b.y + HEAD + 2} width={iw} height={ih} viewBox={`${r.x1 - 40} ${r.y1 - 40} ${vw} ${vh}`} preserveAspectRatio="xMidYMid meet" className="inner-circuit">{circuit(DRAWING[id], k)}</svg>;
    })() : null;
    const info = INFO[id];
    const big = id === PLANT;
    return <g key={id} className={'blk' + (isOpen ? ' open' : '') + (selected ? ' sel' : '') + (hl ? ' focus' : '')} data-block={id}
      onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover(h => h === id ? undefined : h)}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6} style={{ fill: isOpen && leaf ? t.panel : withAlpha(c, isOpen ? 0.05 : 0.1), stroke: c, strokeWidth: selected ? 2.6 : 1.4 }}/>
      <path d={`M${b.x} ${b.y + HEAD} V${b.y + 6} Q${b.x} ${b.y} ${b.x + 6} ${b.y} H${b.x + b.w - 6} Q${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + 6} V${b.y + HEAD} Z`} style={{ fill: withAlpha(c, 0.28), stroke: c, strokeWidth: 1.2 }}/>
      <text x={b.x + 12} y={b.y + HEAD / 2} dominantBaseline="central" fontSize={Math.min(Math.max(13 * px, big ? 18 : 15), HEAD * 0.62)} className="blk-title">{id}</text>
      {info && !isOpen && <text x={b.x + 12} y={b.y + HEAD + 24} fontSize={Math.min(Math.max(11 * px, 12), 22)} className="blk-sub">{info.role}{id === 'Central Bank' ? (closed ? ' · rule sets R' : ' · R given (open loop)') : ''}</text>}
      {inner}
      <g className="blk-toggle" data-toggle={id} transform={`translate(${b.x + b.w - 20} ${b.y + HEAD / 2})`}>
        <rect x={-10} y={-10} width={20} height={20} rx={3} strokeWidth={1.3}/><path d={'M-5 0 H5' + (isOpen ? '' : ' M0 -5 V5')} strokeWidth={2}/>
        <title>{isOpen ? `Close ${id}` : `Open ${id}`}</title></g>
    </g>;
  }

  // ---------------------------------------------------------------- the loop signals (right-angled)
  const cb = boxOf('Central Bank'), eco = boxOf(PLANT), sh = boxOf('Shock'), cpi = boxOf('CPI values');
  const yCb = cb.y + cb.h / 2, xCb = cb.x + cb.w / 2, yCpi = cpi.y + cpi.h / 2, xIn = cpi.x + cpi.w * 0.75;
  const loop = [
    { d: `M${cb.x + cb.w} ${yCb} H${eco.x}`, label: closed ? 'policy rate R' : 'policy rate R (given path)', at: [(cb.x + cb.w + eco.x) / 2, yCb - 10] },
    { d: `M${sh.x + sh.w / 2} ${sh.y + sh.h} V${eco.y}`, label: 'shock', at: [sh.x + sh.w / 2 + 8, (sh.y + sh.h + eco.y) / 2 + 4], anchor: 'start' as const },
    { d: `M${xIn} ${eco.y + eco.h} V${cpi.y}`, label: 'prices P', at: [xIn + 8, (eco.y + eco.h + cpi.y) / 2 + 4], anchor: 'start' as const },
    { d: `M${cpi.x} ${yCpi} H${xCb} V${cb.y + cb.h}`, label: 'inflation π and target π*', at: [(cpi.x + xCb) / 2, yCpi - 10], feedback: true },
  ];

  const blockIds = shownBlocks;
  const selBlock = sel?.type === 'block' ? sel.id : undefined;
  const selFlow = sel?.type === 'flow' ? routed.find(r => r.key === sel.id) : undefined;
  const el = sel?.type === 'el' ? m.elements.find(e => e.name === sel.id) : undefined;
  const blockFlows = selBlock ? routed.filter(r => r.a === selBlock || r.b === selBlock) : [];
  const crumbs = ['Policy loop', ...open];
  const fs = Math.min(Math.max(11 * px, 9), 60);   // flow labels keep about 11 screen pixels

  return <div className="mapwrap">
    <div className="panel map-panel">
      <div className="pick-row map-head">
        {whole ? <span className="crumbs"><b>Whole circuit</b></span> : <nav className="crumbs" aria-label="Layers">{crumbs.map((p, i) => <span key={p}>{i > 0 && <span className="sep">›</span>}
          <button className={'link-btn' + (i === crumbs.length - 1 ? ' here' : '')} onClick={() => crumb(i)}>{p}</button></span>)}</nav>}
        <div className="map-tools">
          <label className="check small"><input type="checkbox" checked={whole} onChange={e => showWhole(e.target.checked)}/>Whole circuit</label>
          <button className="ghost icon" onClick={() => zoomCentre(1 / 1.4)} aria-label="Zoom in" title="Zoom in">+</button>
          <button className="ghost icon" onClick={() => zoomCentre(1.4)} aria-label="Zoom out" title="Zoom out">−</button>
          <button className="ghost" onClick={() => whole ? showWhole(true) : flyTo(view(ALL(), 0.03))} title="Show everything">Fit</button>
        </div>
      </div>
      <p className="muted note">Click <b>+</b> on a block to open it: the Eurozone economy shows its agents, Banking and NFC their sub-agents, the others their circuit from your drawing. Click a flow (or an element) to plot it. Scroll or pinch to zoom, drag to move.</p>
      <svg ref={svg} className="schem blockmap" viewBox={vb.join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Circuit map"
        onPointerDown={e => { if (e.button === 0) drag.current = { x: e.clientX, y: e.clientY, vb, moved: false }; }}
        onPointerMove={e => {
          const d = drag.current; if (!d) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) { d.moved = true; svg.current?.setPointerCapture(e.pointerId); }
          if (!d.moved) return;
          cancelAnimationFrame(anim.current);
          setVb([d.vb[0] - dx * px, d.vb[1] - dy * px, d.vb[2], d.vb[3]]);
        }}
        onPointerUp={e => {
          const d = drag.current; drag.current = null;
          if (!d || d.moved) return;
          const hit = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
          const tg = hit?.closest('[data-toggle]'), elh = hit?.closest('[data-el]'), fl = hit?.closest('[data-flow]'), bl = hit?.closest('[data-block]');
          if (tg) toggle(tg.getAttribute('data-toggle')!);
          else if (hit?.closest('[data-scrim]') && leafOpen) toggle(leafOpen);
          else if (elh) setSel({ type: 'el', id: elh.getAttribute('data-el')! });
          else if (fl) setSel({ type: 'flow', id: fl.getAttribute('data-flow')! });
          else if (bl) setSel({ type: 'block', id: bl.getAttribute('data-block')! });
          else setSel(undefined);
        }}
        onDoubleClick={e => { const tg = e.target as Element, bl = tg.closest('[data-block]'); if (bl && !tg.closest('[data-el]') && !tg.closest('[data-toggle]') && !tg.closest('[data-flow]')) { const id = bl.getAttribute('data-block')!; if (!open.includes(id)) toggle(id); } }}>
        <defs>
          <marker id="map-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="context-stroke"/></marker>
        </defs>
        {whole ? circuit(null) : <>
          <g className="loop">{loop.map((l, i) => <g key={i}>
            <path d={l.d} className={'sig' + (l.feedback ? ' fb' : '')} markerEnd="url(#map-ah)"/>
            <text x={l.at[0]} y={l.at[1]} textAnchor={l.anchor ?? 'middle'} className="sig-label">{l.label}</text>
          </g>)}</g>
          {/* containers first (plant, opened agents), then the leaves; flows over the boxes; an opened leaf on top */}
          {blockIds.filter(id => CHILDREN[id] && open.includes(id)).map(block)}
          {blockIds.filter(id => !(CHILDREN[id] && open.includes(id)) && id !== leafOpen).map(block)}
          <g className="flows">{routed.map(r => {
            const c = colorOf(r.a), on = sel?.type === 'flow' && sel.id === r.key, near = hover && (r.a === hover || r.b === hover);
            const d = 'M' + r.pts.map(p => p.join(' ')).join(' L');
            return <g key={r.key} data-flow={r.key} className={'flow' + (on ? ' sel' : '') + (near ? ' near' : '')}>
              <path d={d} className="flow-hit"/>
              <path d={d} className="flow-line" style={{ stroke: c }} markerEnd="url(#map-ah)"/>
              <circle cx={r.pts[0][0]} cy={r.pts[0][1]} r={4.5} className="port" style={{ stroke: c }}/>
              <text x={r.label.x} y={r.label.y} className="flow-label" fontSize={fs} textAnchor="middle" dy={r.label.vertical ? 0 : -5}
                transform={r.label.vertical ? `rotate(-90 ${r.label.x} ${r.label.y}) translate(0 -5)` : undefined} style={{ fill: c }}>{pretty(r.flow.ref)}</text>
              <title>{`${pretty(r.flow.ref)}: ${r.a} → ${r.b} (click to plot)`}</title>
            </g>;
          })}</g>
          {leafOpen && <rect className="scrim" x={-20000} y={-20000} width={60000} height={60000} data-scrim="1"/>}
          {leafOpen && block(leafOpen)}
        </>}
      </svg>
      <p className="muted note legend-line"><span className="lg sig"/> loop signal · coloured lines: flows between agents (colour of the sending agent, arrow in the direction of the flow at the steady state) · hover a block to highlight its flows</p>
      {sel && <aside className="panel elinfo floating">
        <button className="pin-close" onClick={() => setSel(undefined)} aria-label="Hide details" title="Hide details">×</button>
        {selFlow ? <>
          <h3>{pretty(selFlow.flow.ref)}</h3>
          <p className="small"><span className="dot" style={{ background: colorOf(selFlow.a) }}/> {selFlow.a} → <span className="dot" style={{ background: colorOf(selFlow.b) }}/> {selFlow.b}</p>
          <p className="muted small">Current through <code>{selFlow.flow.element}</code> at node <code>{selFlow.flow.node}</code>; {selFlow.flow.steady.toPrecision(3)} per time unit at the steady state.</p>
          {traceBusy ? <p className="muted note">Simulating the current scenario for this flow…</p>
            : trace ? <Chart title={`I(${selFlow.flow.element.split('§').pop()})`} unit="flow per time unit" height={220} group={null} lines={[{ name: pretty(selFlow.flow.ref), x: trace.years, y: trace.values, color: colorOf(selFlow.a) }]}/>
            : <p className="muted note">No trace for this flow.</p>}
        </> : el ? <>
          <h3>{el.ref}</h3>
          <p className="muted small">{el.kind}{el.sector ? ` · ${FROM_DRAWING[el.sector] ?? el.sector}` : ' · outside the sector boxes'} · netlist name <code>{el.name}</code></p>
          <p className="small">Nodes: <code>{el.nodes.join(' → ')}</code></p>
          <pre className="expr">{el.expr || '—'}</pre>
          {traceBusy ? <p className="muted note">Simulating the current scenario for this trace…</p>
            : trace ? <Chart title={trace.trace} unit={el.kind === 'inductor' || el.kind.includes('current') ? 'current (flow)' : 'value'} height={220} group={null}
                lines={[{ name: trace.trace, x: trace.years, y: trace.values, color: KIND[el.kind] ?? t.inflation }]}/>
            : <p className="muted note">No trace for this element.</p>}
        </> : selBlock ? <>
          <h3><span className="dot" style={{ background: colorOf(selBlock) }}/> {selBlock}</h3>
          {INFO[selBlock] && <><p className="muted small">{INFO[selBlock].role}</p><p className="small">{INFO[selBlock].about}</p></>}
          <button className="ghost" onClick={() => toggle(selBlock)}>{open.includes(selBlock) ? 'Close' : 'Open'} {selBlock}</button>
          {blockFlows.length > 0 && <><h3 className="mt">Flows at this level</h3>
            <ul className="conn">{blockFlows.map(r => <li key={r.key}><button className="link-btn" onClick={() => setSel({ type: 'flow', id: r.key })}>{pretty(r.flow.ref)}</button>
              <small className="muted"> {r.a === selBlock ? `→ ${r.b}` : `← ${r.a}`}</small></li>)}</ul></>}
        </> : null}
      </aside>}
    </div>
  </div>;
}
