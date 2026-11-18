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
//   Authority, NFC, Foreign Sector) at their exact places, with the user's own wires between them; a closed box covers
//   its part of the circuit, opening it lifts the cover (Banks and NFC first show their sub-agents), so the wiring is
//   the drawing's at every level; port marks where wires cross a box edge.
// The current sources drawn outside the plant boxes are imported variables, shown in a dashboard below the map.
// Nothing is plotted until a port, element, instrument or tile is clicked.

interface El { name: string; ref: string; symbol: string; kind: string; rot: string; x: number; y: number; pins: number[][]; sector: string | null; expr: string; nodes: string[] }
interface Rect { x1: number; y1: number; x2: number; y2: number; title: string | null }
interface Txt { x: number; y: number; align: string; size: number; text: string }
interface Flow { element: string; ref: string; kind: string; from: string; to: string; node: string; steady: number }
export interface MapData { bounds: number[]; wires: number[][]; wire_nodes: (string | null)[]; flags: { x: number; y: number; name: string; ground: boolean }[]; rects: Rect[]; sectors: string[]; texts: Txt[]; elements: El[]; flows: Flow[] }
interface Trace { element: string; trace: string; years: number[]; values: number[] }
type Box = { x: number; y: number; w: number; h: number };
type VB = [number, number, number, number];

// ---------------------------------------------------------------- the blocks
// The loop follows the literature figure (ECB macroeconomic models): target setting → Σ → controller (ECB) → u (the
// policy rate r) → plant (economy) → output (inflation) → back to Σ; a disturbance d enters the plant. In open loop the
// switch takes u from the given rate path and the feedback is open.
// The plant is the user's drawing at one scale: its boxes at their own places, its own wires between them. A closed
// box covers its part of the circuit; opening it lifts the cover, so the wiring is right at every level.
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
const outputBox = (p: Box): Box => ({ x: p.x + p.w + 200, y: CTRL.y + CTRL.h / 2 - 60, w: 240, h: 120 });
type R4 = { x1: number; y1: number; x2: number; y2: number };
// The opened plant is the drawing itself at one scale K: every box at its exact place, the wires between them as drawn.
const K = 0.31, MARGIN = 140;
type View = { x: number; y: number; w: number; h: number };
type Geo = { VIEW: View; P_OPEN: Box; mapRect: (r: R4) => Box; inView: (x: number, y: number) => boolean };
function makeGeo(v: View): Geo {
  const P_OPEN: Box = { x: 1080, y: 120, w: v.w * K, h: v.h * K + HEAD };
  return { VIEW: v, P_OPEN,
    mapRect: r => ({ x: P_OPEN.x + (r.x1 - v.x) * K, y: P_OPEN.y + HEAD + (r.y1 - v.y) * K, w: (r.x2 - r.x1) * K, h: (r.y2 - r.y1) * K }),
    inView: (x, y) => x >= v.x && x <= v.x + v.w && y >= v.y && y <= v.y + v.h };
}
// The part of the drawing that is the plant: its boxes, every element in them, and every wire of their nodes (the
// drawing's long connecting wires run outside the boxes); ground wires near the boxes. Plus a margin.
function plantView(m: MapData, rects: Record<string, R4>, inPlantBox: (t: string) => boolean): View {
  const boxes = Object.entries(rects).filter(([k]) => inPlantBox(k)).map(([, r]) => r);
  const bx = { x1: Math.min(...boxes.map(r => r.x1)), y1: Math.min(...boxes.map(r => r.y1)), x2: Math.max(...boxes.map(r => r.x2)), y2: Math.max(...boxes.map(r => r.y2)) };
  const nodes = new Set<string>(m.flows.map(f => f.node));
  for (const e of m.elements) if (e.sector && inPlantBox(e.sector)) for (const n of e.nodes) if (n !== '0') nodes.add(n);
  const xs = [bx.x1, bx.x2], ys = [bx.y1, bx.y2], near = (x: number, y: number) => x > bx.x1 - 500 && x < bx.x2 + 500 && y > bx.y1 - 500 && y < bx.y2 + 500;
  m.wires.forEach((w, i) => {
    const n = m.wire_nodes[i];
    if ((n && n !== '0' && nodes.has(n)) || (n === '0' && near(w[0], w[1]) && near(w[2], w[3]))) { xs.push(w[0], w[2]); ys.push(w[1], w[3]); }
  });
  const x1 = Math.min(...xs) - MARGIN, y1 = Math.min(...ys) - MARGIN;
  return { x: x1, y: y1, w: Math.max(...xs) + MARGIN - x1, h: Math.max(...ys) + MARGIN - y1 };
}
const GEO0 = makeGeo({ x: 950, y: 980, w: 7750, h: 5910 });
// where the segment p-q crosses the border of r (Liang-Barsky): the points strictly inside the segment
function crossings(p: number[], q: number[], r: R4): number[][] {
  const dx = q[0] - p[0], dy = q[1] - p[1], out: number[][] = [];
  let t0 = 0, t1 = 1;
  for (const [pp, qq] of [[-dx, p[0] - r.x1], [dx, r.x2 - p[0]], [-dy, p[1] - r.y1], [dy, r.y2 - p[1]]]) {
    if (pp === 0) { if (qq < 0) return []; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return []; if (t > t0) t0 = t; } else { if (t < t0) return []; if (t < t1) t1 = t; }
  }
  for (const t of [t0, t1]) if (t > 1e-9 && t < 1 - 1e-9) out.push([p[0] + dx * t, p[1] + dy * t]);
  return out;
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

// two hex colours blended (an opaque tint for the cover of a closed box)
const mix = (a: string, b: string, k: number) => { const p = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const x = p(a), y = p(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(',')})`; };
const within = (outer: string, inner: string) => { let v: string | undefined = inner; while (v) { v = PARENT[v]; if (v === outer) return true; } return false; };
const inPlant = (id: string) => within(PLANT, id);
interface DashVar { name: string; ref: string; group: string; expr: string; box: string | null; readers: { name: string; ref: string; sector: string | null }[] }
type DashVals = { years: number[]; series: Record<string, number[]> };
const T_END = 13.33;
type Sel = { type: 'block' | 'port' | 'node' | 'el' | 'instr'; id: string; q?: 'e' | 'f' };
const fmt = (v: number) => !isFinite(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3);

// current along the drawn wires (POST /api/wireflow), positive in a segment's drawn direction
type WireFlow = { years: number[]; segments: { w: number; p: number[]; node: string; i: number[] }[] };
const PLAY_SECONDS = 20;   // playing the whole run (13.3 years) takes this long
const DOT_PERIODS = [100, 200, 400, 800, 1600];   // dot spacing in drawing units; one is picked for about 30 screen pixels

export function ModelMap({ scenario, closed, run, busy = false, expectSec = 12 }: { scenario: unknown; closed: boolean; run?: SavedRun; busy?: boolean; expectSec?: number }) {
  const t = useTheme();
  const KIND = kindColor(t);
  const [m, setM] = useState<MapData>();
  const [dash, setDash] = useState<DashVar[]>([]);
  const [vals, setVals] = useState<DashVals>();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string[]>([]);       // every opened block (several agents can be open)
  const [focus, setFocus] = useState<string>();          // the block toggled last: the camera and the breadcrumbs follow it
  const [win, setWin] = useState<[number, number]>([0, 13.33]);   // time window (years) for the plots and the dashboard
  const [wf, setWf] = useState<WireFlow>();       // currents along the wires of the active run
  const [tNow, setTNow] = useState(0);            // the moment shown by the dots and the time bar (years)
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);      // seconds since the running simulation started
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

  // ---------------------------------------------------------------- time: playback and the running simulation
  // the wires' currents of the active run, fetched once the plant is open; a new run plays from the start
  const scenarioKey = JSON.stringify(scenario);
  useEffect(() => {
    if (!plantOpen || busy) return;
    let live = true;
    api<WireFlow>('/wireflow', scenario).then(r => { if (live) { setWf(r); setTNow(0); setPlaying(true); } }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantOpen, scenarioKey, busy]);
  useEffect(() => {   // playback: T_END years in PLAY_SECONDS
    if (!playing) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setTNow(v => { const n = v + dt * T_END / PLAY_SECONDS; if (n >= T_END) { setPlaying(false); return T_END; } return n; });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  useEffect(() => {   // while a simulation runs: seconds elapsed, for the progress estimate
    if (!busy) { setElapsed(0); return; }
    const t0 = performance.now(), id = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 200);
    return () => window.clearInterval(id);
  }, [busy]);
  // a typical current (95th percentile over wires and time) sets the dots' speed scale
  const iRef = useMemo(() => {
    if (!wf) return 1;
    const all = wf.segments.flatMap(sg => sg.i.map(Math.abs)).filter(v => v > 0).sort((a, b) => a - b);
    return all[Math.floor(all.length * 0.95)] || 1;
  }, [wf]);
  const ti = wf ? Math.min(wf.years.length - 1, Math.round(tNow / (wf.years[1] - wf.years[0]))) : 0;   // dots change per sample
  const geo = useMemo(() => m && rects.Households ? makeGeo(plantView(m, rects, inPlant)) : GEO0, [m, rects]);
  const layoutFor = useCallback((o: string[]) => ({ boxes: o.includes(PLANT)
    ? { [PLANT]: geo.P_OPEN, ...Object.fromEntries(Object.entries(rects).filter(([k]) => inPlant(k)).map(([k, r]) => [k, geo.mapRect(r)])) } as Record<string, Box>
    : {} as Record<string, Box> }), [rects, geo]);
  const lay = useMemo(() => layoutFor(open), [layoutFor, open]);
  const loopLeaf = open.find(o => o === 'Controller' || o === 'Output');   // controller / output: shown over a scrim
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
  const focusBoxOf = (id: string | undefined, o: string[]): Box => {
    const l = layoutFor(o), po = o.includes(PLANT);
    if (!id) return loopView(po ? boxIn(PLANT, l, po) : P_CLOSED);
    if (id === PLANT) return loopView(boxIn(PLANT, l, po));
    if (!inPlant(id) && !CHILDREN[id]) return expanded(id);
    return boxIn(id, l, po);
  };
  function toggle(id: string) {
    if (id === 'Target setting' || id === 'Rate path') { setSel({ type: 'block', id }); return; }
    let next: string[], f: string | undefined;
    if (open.includes(id)) { next = open.filter(o => o !== id && !within(id, o)); f = PARENT[id]; }
    else {
      next = [...open, ...pathTo(id).filter(x => !open.includes(x))];
      if (id === 'Controller' || id === 'Output') next = next.filter(o => o === id || (o !== 'Controller' && o !== 'Output'));
      f = id;
    }
    setOpen(next); setFocus(f); setSel(undefined);
    flyTo(view(focusBoxOf(f, next), 0.04));
  }
  const trail = focus ? pathTo(focus).filter(x => open.includes(x)) : [];
  function crumb(i: number) {   // the first crumb closes everything; the others fly to that level
    if (i === 0) { setOpen([]); setFocus(undefined); setSel(undefined); flyTo(view(loopView(P_CLOSED), 0.04)); return; }
    setFocus(trail[i - 1]); flyTo(view(focusBoxOf(trail[i - 1], open), 0.04));
  }
  function showWhole(on: boolean) {
    setWhole(on); setSel(undefined); cancelAnimationFrame(anim.current);
    if (on && m) { const b = m.bounds; setVb([b[0], b[1], b[2] - b[0], b[3] - b[1]]); } else setVb(view(focusBoxOf(focus, open), 0.03));
  }
  useEffect(() => { if (m) setVb(view(loopView(P_CLOSED), 0.04)); }, [m]);   // start: the feedback loop

  // ---------------------------------------------------------------- the plant as drawn
  // Visible plant boxes that are closed cover their part of the circuit. Port marks sit where a wire crosses the edge
  // of a visible box (closed or open): f on a flow wire, a small ring on a return (ground) wire.
  const plantDraw = useMemo(() => {
    if (!m || !plantOpen) return null;
    const shownPlant = shownBlocks.filter(id => inPlant(id));
    const closedBoxes = shownPlant.filter(id => !open.includes(id)).map(id => rects[id]).filter(Boolean);
    const coveredBy = (x: number, y: number) => closedBoxes.find(r => x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2);
    // the colour of a node: its hub agent (the agent in every flow on that node)
    const hub: Record<string, string> = {};
    const byNode: Record<string, Flow[]> = {};
    for (const f of m.flows) (byNode[f.node] ??= []).push(f);
    for (const [n, fl] of Object.entries(byNode)) {
      const common = [fl[0].from, fl[0].to].find(a => fl.every(f => f.from === a || f.to === a));
      if (common) hub[n] = common;
    }
    const wires = m.wires.map((w, i) => ({ w, i, node: m.wire_nodes[i] })).filter(({ w }) => {
      if (!geo.inView(w[0], w[1]) && !geo.inView(w[2], w[3])) return false;
      const a = coveredBy(w[0], w[1]), b = coveredBy(w[2], w[3]);
      return !(a && a === b);
    });
    const shown = (x: number, y: number) => geo.inView(x, y) && !coveredBy(x, y);
    const els = m.elements.filter(e => { const cx = (e.pins[0][0] + e.pins[1][0]) / 2, cy = (e.pins[0][1] + e.pins[1][1]) / 2; return shown(cx, cy); });
    const flags = m.flags.filter(f => shown(f.x, f.y));
    const texts = m.texts.filter(x => shown(x.x, x.y) && !rects[x.text.trim()]);
    const ports: { x: number; y: number; node: string; box: string; ground: boolean; gap: number }[] = [];
    const seen = new Set<string>();
    for (const id of shownPlant) {
      const r = rects[id]; if (!r) continue;
      for (const { w, node } of wires) {
        if (!node) continue;
        for (const [x, y] of crossings([w[0], w[1]], [w[2], w[3]], r)) {
          const k = `${Math.round(x)}|${Math.round(y)}`; if (seen.has(k)) continue; seen.add(k);
          if (ports.some(q => q.node === node && Math.hypot(q.x - x, q.y - y) < 160)) continue;   // the same wire at two close edges
          ports.push({ x, y, node, box: id, ground: node === '0', gap: Infinity });
        }
      }
    }
    for (const q of ports) for (const o of ports) if (o !== q) q.gap = Math.min(q.gap, Math.hypot(o.x - q.x, o.y - q.y));
    return { wires, els, flags, texts, ports, hub };
  }, [m, plantOpen, shownBlocks, open, rects]);

  // what to plot: nothing until a port, an element, the input u or a dashboard tile is clicked
  // a port (box|node) or a wire's node: e is the node voltage, f the current of the box's flow element on that node
  const portSel = sel?.type === 'port' || sel?.type === 'node' ? (() => {
    const [box, node] = sel.type === 'port' ? sel.id.split('|') : [undefined, sel.id];
    const onNode = (m?.elements ?? []).filter(e => e.nodes.includes(node));
    const inBox = (e: El) => !!box && (e.sector === box || (!!e.sector && within(box, e.sector)));
    const carriers = onNode.filter(e => (box ? inBox(e) : true) && ['inductor', 'behavioural current', 'current source'].includes(e.kind));
    return { box, node, onNode, carriers };
  })() : undefined;
  const traceOf = portSel ? (portSel.node === '0' ? undefined : sel?.q === 'f' && portSel.carriers[0] ? portSel.carriers[0].name : `V(${portSel.node})`)
    : sel?.type === 'el' ? sel.id : sel?.type === 'instr' ? 'B§R' : undefined;
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

  // ---------------------------------------------------------------- header bars of the plant boxes
  // As in the housing app, every agent carries a bar with its title and its +/-. The bar sits on top of the box (in
  // the room the cleaned-up drawing leaves between the boxes), so it never covers the circuit; it is as high as a block
  // header (HEAD) where there is room, lower where a sub-agent sits close under its parent's top or under another box.
  const barAt: Record<string, { h: number; w: number; fs: number }> = {};
  for (const id of shownBlocks.filter(x => inPlant(x))) {
    const r = rects[id]; if (!r) continue;
    const par = PARENT[id], pr = par && par !== PLANT ? rects[par] : undefined;
    const above = Object.entries(rects).filter(([k, q]) => k !== id && q.y2 <= r.y1 && !(q.x2 < r.x1 || q.x1 > r.x2)).map(([, q]) => r.y1 - q.y2);
    const h = Math.max(12, Math.min(HEAD, Math.min(pr ? r.y1 - pr.y1 : Infinity, ...above) * K - 3));
    const fs = Math.min(h * 0.62, Math.max(13 * px, 12));
    barAt[id] = { h, fs, w: Math.max(boxOf(id).w, id.length * 0.6 * fs + h * 1.5) };
  }

  // ---------------------------------------------------------------- a block (as the housing app draws them: header band, toggle)
  function block(id: string) {
    const isOpen = open.includes(id), leaf = !CHILDREN[id], b = isOpen && id === loopLeaf ? expanded(id) : boxOf(id);
    const fig = loopStyle(id), c = fig ? fig.stroke : colorOf(id);
    const selected = sel?.type === 'block' && sel.id === id, hl = hover === id, big = !!fig;
    const offLoop = (id === 'Controller' && !closed) || (id === 'Rate path' && closed);
    const plantBox = inPlant(id), bar = barAt[id];
    const fill = fig ? (isOpen ? withAlpha(fig.fill, 0.18) : fig.fill) : isOpen ? 'none' : mix(t.panel, c, 0.16);
    const title = TITLE[id];
    const dr = drawingOf(id), r = dr ? rects[dr] : undefined;
    let innerSvg: ReactNode = null;
    if (isOpen && r && leaf && !plantBox) {   // controller / output: their circuit fitted in the grown block
      const vw = r.x2 - r.x1 + 80, vh = r.y2 - r.y1 + 80, iw = b.w - 12, ih = b.h - HEAD - 8, k = Math.max(vw / iw, vh / ih);
      innerSvg = <svg x={b.x + 6} y={b.y + HEAD + 2} width={iw} height={ih} viewBox={`${r.x1 - 40} ${r.y1 - 40} ${vw} ${vh}`} preserveAspectRatio="xMidYMid meet" className="inner-circuit">{circuit(dr!, k)}</svg>;
    }
    return <g key={id} className={'blk' + (isOpen ? ' open' : '') + (selected ? ' sel' : '') + (hl ? ' focus' : '') + (fig ? ' fig' : '') + (offLoop ? ' offloop' : '')} data-block={id}
      onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover(h => h === id ? undefined : h)}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={big ? 4 : 6} className={plantBox && isOpen ? 'see-through' : undefined} style={{ fill, stroke: c, strokeWidth: selected ? 2.6 : 1.4, strokeDasharray: offLoop ? '8 6' : plantBox && isOpen ? '10 6' : undefined }}/>
      {plantBox ? bar && <>
        <path d={`M${b.x} ${b.y} V${b.y - bar.h + 5} Q${b.x} ${b.y - bar.h} ${b.x + 5} ${b.y - bar.h} H${b.x + bar.w - 5} Q${b.x + bar.w} ${b.y - bar.h} ${b.x + bar.w} ${b.y - bar.h + 5} V${b.y} Z`}
          className="plant-bar" style={{ fill: mix(t.panel, c, 0.32), stroke: c, strokeWidth: selected ? 2.2 : 1.2 }}/>
        <text x={b.x + bar.h * 0.3} y={b.y - bar.h / 2} dominantBaseline="central" fontSize={bar.fs} className="blk-title">{id}</text>
      </> : fig && !isOpen ? <>
        <text x={b.x + b.w / 2} y={b.y + b.h / 2 - 8} textAnchor="middle" fontSize={27} className="fig-title">{title[0]}</text>
        <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 22} textAnchor="middle" fontSize={id === PLANT ? 17 : 19} style={{ fill: fig.sub }}>{offLoop ? (id === 'Controller' ? '(ECB) · out of the loop' : '(given) · not used') : title[1]}</text>
      </> : <>
        <path d={`M${b.x} ${b.y + HEAD} V${b.y + 6} Q${b.x} ${b.y} ${b.x + 6} ${b.y} H${b.x + b.w - 6} Q${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + 6} V${b.y + HEAD} Z`} style={{ fill: fig ? fig.fill : withAlpha(c, 0.3), stroke: c, strokeWidth: 1.2 }}/>
        <text x={b.x + 12} y={b.y + HEAD / 2} dominantBaseline="central" fontSize={Math.min(Math.max(13 * px, 15), HEAD * 0.62)} className="blk-title">{title ? `${title[0]} ${title[1]}` : id}</text>
        {INFO[id] && !isOpen && b.h > HEAD + 30 && <text x={b.x + 12} y={b.y + HEAD + 24} fontSize={Math.min(Math.max(11 * px, 12), 22)} className="blk-sub">{INFO[id].role}</text>}
      </>}
      {innerSvg}
      {id !== 'Target setting' && id !== 'Rate path' && <g className="blk-toggle" data-toggle={id} transform={plantBox && bar ? `translate(${b.x + bar.w - bar.h / 2} ${b.y - bar.h / 2}) scale(${bar.h * 0.6 / 20})` : `translate(${b.x + b.w - 20} ${b.y + (fig && !isOpen ? 20 : HEAD / 2)})`}>
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
  const crumbs = ['Feedback loop', ...trail];
  const groups = [...new Set(dash.map(d => d.group))];
  // the time window applied to a trace (charts) and to the dashboard series
  const inWin = (years: number[], values: number[]) => { const x: number[] = [], y: number[] = []; years.forEach((v, i) => { if (v >= win[0] - 1e-9 && v <= win[1] + 1e-9) { x.push(v); y.push(values[i]); } }); return { x, y }; };
  const wTrace = trace ? inWin(trace.years, trace.values) : undefined;
  const at = (ys: number[], v: number) => { const yrs = vals!.years; let i = yrs.findIndex(t2 => t2 >= v - 1e-9); if (i < 0) i = yrs.length - 1; return ys[i]; };

  return <div className="mapwrap">
    <div className="panel map-panel">
      <div className="pick-row map-head">
        {whole ? <span className="crumbs"><b>Whole circuit</b></span> : <nav className="crumbs" aria-label="Layers">{crumbs.map((p, i) => <span key={p}>{i > 0 && <span className="sep">›</span>}
          <button className={'link-btn' + (i === crumbs.length - 1 ? ' here' : '')} onClick={() => crumb(i)}>{p}</button></span>)}</nav>}
        <div className="map-tools">
          <span className={`mode ${closed ? 'closed' : 'open'}`}>{closed ? 'closed loop' : 'open loop'}</span>
          <div className="win" role="group" aria-label="Time window">
            <span className="small">Time</span>
            <input type="range" min={0} max={T_END} step={0.25} value={win[0]} aria-label="From (years)" onChange={e => { const v = Math.min(Number(e.target.value), win[1] - 0.25); setWin([v, win[1]]); }}/>
            <input type="range" min={0} max={T_END} step={0.25} value={win[1]} aria-label="To (years)" onChange={e => { const v = Math.max(Number(e.target.value), win[0] + 0.25); setWin([win[0], v]); }}/>
            <output className="small">{win[0].toFixed(1)}–{win[1].toFixed(1)} yr</output>
          </div>
          <label className="check small"><input type="checkbox" checked={whole} onChange={e => showWhole(e.target.checked)}/>Whole circuit</label>
          <button className="ghost icon" onClick={() => zoomCentre(1 / 1.4)} aria-label="Zoom in" title="Zoom in">+</button>
          <button className="ghost icon" onClick={() => zoomCentre(1.4)} aria-label="Zoom out" title="Zoom out">−</button>
          <button className="ghost" onClick={() => whole ? showWhole(true) : flyTo(view(focusBoxOf(open.includes(PLANT) ? PLANT : undefined, open), 0.03))} title="Show everything">Fit</button>
        </div>
      </div>
      <div className="timebar" role="group" aria-label="Simulation time">
        {busy ? <>
          <span className="small tb-label">Simulating…</span>
          <div className="tb-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(elapsed / expectSec, 0.95) * 100)}>
            <div className="tb-fill busy" style={{ width: `${Math.min(elapsed / expectSec, 0.95) * 100}%` }}/></div>
          <output className="small">{elapsed.toFixed(0)} s of about {Math.round(expectSec)} s</output>
        </> : <>
          <button className="ghost icon" disabled={!wf} onClick={() => { if (tNow >= T_END - 1e-6) setTNow(0); setPlaying(v => !v); }} aria-label={playing ? 'Pause' : 'Play'} title={wf ? (playing ? 'Pause' : 'Play the run') : 'Open the plant to see the currents'}>{playing ? '❚❚' : '▶'}</button>
          <div className="tb-track">
            <div className="tb-fill" style={{ width: `${(tNow / T_END) * 100}%` }}/>
            <input type="range" min={0} max={T_END} step={0.05} value={tNow} aria-label="Moment shown (years)" disabled={!wf} onChange={e => { setPlaying(false); setTNow(Number(e.target.value)); }}/>
          </div>
          <output className="small">{wf ? `t = ${tNow.toFixed(1)} of ${T_END.toFixed(1)} yr` : 'open the plant for the currents'}</output>
        </>}
      </div>
      <p className="muted note">Click <b>+</b> to open a block: the plant is your drawing, with each agent's circuit under its box; opening a box lifts it (Banks and NFC first show their sub-agents). The wires between the agents are your own. Click a port mark <b>f</b> on a box edge, a wire, the input u, an element or a dashboard tile to plot it. The loop follows the Open / Closed switch on the left.</p>
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
          const tg = hit?.closest('[data-toggle]'), elh = hit?.closest('[data-el]'), pm = hit?.closest('[data-port]'), wn = hit?.closest('[data-node]'), ins = hit?.closest('[data-instr]'), bl = hit?.closest('[data-block]');
          if (tg) toggle(tg.getAttribute('data-toggle')!);
          else if (hit?.closest('[data-scrim]') && loopLeaf) toggle(loopLeaf);
          else if (elh) setSel({ type: 'el', id: elh.getAttribute('data-el')! });
          else if (pm) setSel({ type: 'port', id: pm.getAttribute('data-port')!, q: 'f' });
          else if (wn && wn.getAttribute('data-node')) setSel({ type: 'node', id: wn.getAttribute('data-node')!, q: 'e' });
          else if (ins) { const id = ins.getAttribute('data-instr')!; setSel(id === 'd' ? { type: 'el', id: 'B§Shock' } : id === 'pi*' ? { type: 'el', id: 'B§Target_CPI' } : id === 'pi' ? { type: 'el', id: 'B§CPI_filtered' } : id === 'P' ? { type: 'el', id: 'B§P' } : { type: 'instr', id }); }
          else if (bl) { const id = bl.getAttribute('data-block')!; setSel(id === 'Rate path' ? { type: 'instr', id: 'u' } : { type: 'block', id }); }
          else setSel(undefined);
        }}
        onDoubleClick={e => { const tg = e.target as Element, bl = tg.closest('[data-block]'); if (bl && !tg.closest('[data-el]') && !tg.closest('[data-toggle]') && !tg.closest('[data-port]')) { const id = bl.getAttribute('data-block')!; if (!open.includes(id)) toggle(id); } }}>
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
          {/* the plant block, then its circuit as drawn, then the plant's boxes (closed ones cover their part), then the ports */}
          {shownBlocks.filter(id => !inPlant(id) && id !== loopLeaf).map(block)}
          {plantDraw && <svg x={geo.P_OPEN.x} y={geo.P_OPEN.y + HEAD} width={geo.VIEW.w * K} height={geo.VIEW.h * K} viewBox={`${geo.VIEW.x} ${geo.VIEW.y} ${geo.VIEW.w} ${geo.VIEW.h}`} className="plant-drawing">
            {plantDraw.texts.filter(x => (10 + x.size * 9) * 1.4 * K / px >= 4).map((x, i) => <text key={i} x={x.x} y={x.y} className="asctext halo" fontSize={(10 + x.size * 9) * 1.4} textAnchor={x.align.endsWith('Right') ? 'end' : 'start'} dominantBaseline="middle"
              transform={x.align.startsWith('V') ? `rotate(-90 ${x.x} ${x.y})` : undefined}>{x.text}</text>)}
            {plantDraw.wires.map(({ w, i, node }) => {
              const hubA = node ? plantDraw.hub[node] : undefined, c = hubA ? colorOf(hubA) : undefined, ground = node === '0';
              const on = sel?.type === 'node' && sel.id === node;
              return <g key={i} data-node={node ?? ''} className={'pw' + (ground ? ' ground' : '') + (c ? ' flow' : '') + (on ? ' on' : '')}>
                <line x1={w[0]} y1={w[1]} x2={w[2]} y2={w[3]} className="pw-hit"/>
                <line x1={w[0]} y1={w[1]} x2={w[2]} y2={w[3]} style={c ? { stroke: c } : undefined}/>
              </g>;
            })}
            {wf && (() => {
              // moving dots: direction = sign of the current at the shown moment, speed grows with its size
              const shownW = new Set(plantDraw.wires.map(x => x.i)), unit = px / K;   // drawing units per screen pixel
              const period = DOT_PERIODS.find(q => q / unit >= 26) ?? DOT_PERIODS[DOT_PERIODS.length - 1];
              const dot = 7 * unit;   // about 7 screen pixels at every zoom
              return <g className="flow-dots-layer" aria-hidden="true">{wf.segments.map((sg, k) => {
                if (!shownW.has(sg.w)) return null;
                const v = sg.i[ti] ?? 0, a = Math.abs(v) / iRef;
                if (a < 2e-3) return null;
                const hubA = plantDraw.hub[sg.node], c = hubA ? colorOf(hubA) : t.ink2;
                const dur = 2.6 / (0.25 + 1.75 * Math.sqrt(Math.min(a, 4)));
                return <line key={k} x1={sg.p[0]} y1={sg.p[1]} x2={sg.p[2]} y2={sg.p[3]} className={`flow-dots p${period}`}
                  style={{ stroke: c, strokeWidth: dot, strokeDasharray: `0 ${period}`, animationDuration: `${dur.toFixed(2)}s`, animationDirection: v > 0 ? 'normal' : 'reverse' }}/>;
              })}</g>;
            })()}
            {plantDraw.flags.map((f, i) => f.ground ? <path key={i} className="gnd" d={`M${f.x} ${f.y} v14 m-22 0 h44 m-32 10 h20 m-10 10 h0`}/>
              : 40 * K / px >= 4 && <text key={i} x={f.x + 8} y={f.y - 10} className="flag" fontSize={40}>{f.name}</text>)}
            {plantDraw.els.map(e => {
              const cx = (e.pins[0][0] + e.pins[1][0]) / 2, cy = (e.pins[0][1] + e.pins[1][1]) / 2, onE = sel?.type === 'el' && sel.id === e.name;
              return <g key={e.name} data-el={e.name} className={'el' + (onE ? ' sel' : '')}>
                <g transform={transform(e)} style={{ stroke: KIND[e.kind] }} className="glyph"><Glyph symbol={e.symbol}/></g>
                <circle cx={cx} cy={cy} r={46} className="mark" style={{ fill: KIND[e.kind] }}/>
                <circle cx={cx} cy={cy} r={Math.max(56, 9 * px / K)} className="hit"/>
                {px / K < 9 && <text x={cx + 40} y={cy} className="ellabel" fontSize={Math.min(Math.max(11 * px / K, 22), 300)} dominantBaseline="middle">{e.ref}</text>}
              </g>;
            })}
          </svg>}
          {shownBlocks.filter(id => inPlant(id) && open.includes(id)).map(block)}
          {shownBlocks.filter(id => inPlant(id) && !open.includes(id)).map(block)}
          {plantDraw && <svg x={geo.P_OPEN.x} y={geo.P_OPEN.y + HEAD} width={geo.VIEW.w * K} height={geo.VIEW.h * K} viewBox={`${geo.VIEW.x} ${geo.VIEW.y} ${geo.VIEW.w} ${geo.VIEW.h}`} className="plant-ports">
            {plantDraw.ports.map((pt, i) => {
              const r0 = Math.min(7 * px / K, pt.gap / 2.3), hubA = plantDraw.hub[pt.node], c = hubA ? colorOf(hubA) : t.ink2, onP = sel?.type === 'port' && sel.id === `${pt.box}|${pt.node}`;
              return <g key={i} data-port={`${pt.box}|${pt.node}`} className={'port-mark' + (pt.ground ? ' ret' : '') + (onP ? ' on' : '')}>
                <circle cx={pt.x} cy={pt.y} r={pt.ground ? r0 * 0.55 : r0} style={{ stroke: c }}/>
                {!pt.ground && r0 * K / px >= 4 && <text x={pt.x} y={pt.y} fontSize={r0 * 1.25} style={{ fill: c }}>f</text>}
                <title>{pt.ground ? `${pt.box}: return (ground)` : `${pt.box} · node ${pt.node}: click for its flow f and effort e`}</title>
              </g>;
            })}
          </svg>}
          {loopLeaf && <rect className="scrim" x={-20000} y={-20000} width={60000} height={60000} data-scrim="1"/>}
          {loopLeaf && block(loopLeaf)}
        </>}
      </svg>
      <p className="muted note legend-line">Wires as in your .asc: coloured by the agent that holds the node (the hub of its flows), grey for the return (ground) · <b>f</b> marks: a flow wire crossing an agent's edge, small rings: its return · loop blocks in the colours of the ECB figure</p>

      {/* the dashboard: the current sources outside the plant boxes, which the plant imports */}
      <section className="dash">
        <h3>Imported variables <span className="muted small">· current sources drawn outside the plant: the plant reads them, they are not part of its circuit yet · values at the end of the time window</span></h3>
        {!vals && <p className="muted note">Values appear once a simulation has run.</p>}
        {groups.map(g => <div key={g} className="dash-group">
          <h4>{g}</h4>
          <div className="dash-grid">{dash.filter(d => d.group === g).map(d => {
            const ser = vals?.series[d.name], v = ser ? { start: at(ser, win[0]), end: at(ser, win[1]) } : undefined, onT = sel?.type === 'el' && sel.id === d.name;
            return <button key={d.name} className={'dash-tile' + (onT ? ' on' : '')} onClick={() => setSel({ type: 'el', id: d.name })} title={d.expr}>
              <span className="dash-name">{pretty(d.ref)}</span>
              <span className="dash-val">{v ? fmt(v.end) : '–'}</span>
              <span className="dash-sub">{v ? `at ${win[1].toFixed(1)} yr · ${win[0].toFixed(1)} yr: ${fmt(v.start)}` : ' '}{d.readers.length ? ` · read by ${d.readers.length}` : ''}</span>
            </button>;
          })}</div>
        </div>)}
      </section>

      {sel && <aside className="panel elinfo floating">
        <button className="pin-close" onClick={() => setSel(undefined)} aria-label="Hide details" title="Hide details">×</button>
        {portSel ? <>
          <h3>{portSel.box ? `${portSel.box} · port on ${portSel.node}` : `Node ${portSel.node}`}</h3>
          {portSel.node === '0' ? <p className="small">The return (ground) of the port pairs: every flow returns through it.</p> : <>
            <div className="segmented small-seg qpick" role="group" aria-label="Quantity">
              <button className={sel?.q === 'f' ? 'active' : ''} disabled={!portSel.carriers.length} onClick={() => setSel({ ...sel!, q: 'f' })}>f: flow</button>
              <button className={sel?.q !== 'f' ? 'active' : ''} onClick={() => setSel({ ...sel!, q: 'e' })}>e: effort</button>
            </div>
            <p className="muted small">{sel?.q === 'f' && portSel.carriers[0]
              ? <>The flow through the port: the current through <code>{portSel.carriers[0].name}</code>{portSel.carriers.length > 1 ? ` (and ${portSel.carriers.length - 1} more on this node)` : ''}.</>
              : <>The effort: the voltage of node <code>{portSel.node}</code> against ground.</>}</p>
            {traceBusy ? <p className="muted note">Simulating the current scenario…</p>
              : trace ? <Chart title={trace.trace} unit={sel?.q === 'f' ? 'flow per time unit' : 'effort (node voltage)'} height={220} group={null} lines={[{ name: trace.trace, x: wTrace!.x, y: wTrace!.y, color: colorOf(plantDraw?.hub[portSel.node] ?? '') }]}/>
              : <p className="muted note">No trace.</p>}
            <h3 className="mt">On this node</h3>
            <ul className="conn">{portSel.onNode.map(e => <li key={e.name}><button className="link-btn" onClick={() => setSel({ type: 'el', id: e.name })}>{e.ref}</button>
              <small className="muted"> {e.kind}{e.sector ? ` · ${blockOfDrawing(e.sector)}` : ''}</small></li>)}</ul>
          </>}
        </> : sel.type === 'instr' ? <>
          <h3>u: the policy rate r</h3>
          <p className="muted small">The plant's input, element <code>B§R</code>: {closed ? 'set by the controller (the rule B_PI through the smoothing R15·C8): closed loop.' : 'the given rate path (base rate, then a step; the sliders on the left): open loop, the controller is out of the loop.'}</p>
          {traceBusy ? <p className="muted note">Simulating…</p> : trace ? <Chart title={trace.trace} unit="rate" height={220} group={null} lines={[{ name: 'u = r', x: wTrace!.x, y: wTrace!.y, color: FIG.ctrl.stroke }]}/> : null}
        </> : el ? <>
          <h3>{el.ref}</h3>
          <p className="muted small">{el.kind}{el.sector ? ` · ${blockOfDrawing(el.sector)}` : ' · outside the plant boxes (dashboard)'} · netlist name <code>{el.name}</code></p>
          {el.nodes.length > 0 && <p className="small">Nodes: <code>{el.nodes.join(' → ')}</code></p>}
          <pre className="expr">{el.expr || '—'}</pre>
          {dashOf(el.name)?.readers.length ? <p className="small">Read by: {dashOf(el.name)!.readers.map(r => `${r.ref}${r.sector ? ` (${blockOfDrawing(r.sector)})` : ''}`).join(', ')}</p> : null}
          {traceBusy ? <p className="muted note">Simulating the current scenario for this trace…</p>
            : trace ? <Chart title={trace.trace} unit={el.kind === 'inductor' || el.kind.includes('current') ? 'current (flow)' : 'value'} height={220} group={null}
                lines={[{ name: trace.trace, x: wTrace!.x, y: wTrace!.y, color: KIND[el.kind] ?? t.inflation }]}/>
            : <p className="muted note">No trace for this element.</p>}
        </> : selBlock ? <>
          <h3>{TITLE[selBlock] ? `${TITLE[selBlock][0]} ${TITLE[selBlock][1]}` : selBlock}</h3>
          {INFO[selBlock] && <><p className="muted small">{INFO[selBlock].role}</p><p className="small">{INFO[selBlock].about}</p></>}
          {INFO[selBlock]?.element ? <button className="ghost" onClick={() => setSel({ type: 'el', id: INFO[selBlock].element! })}>Show {INFO[selBlock].element}</button>
            : <button className="ghost" onClick={() => toggle(selBlock)}>{open.includes(selBlock) ? 'Close' : 'Open'} {selBlock}</button>}
        </> : null}
      </aside>}
    </div>
  </div>;
}
