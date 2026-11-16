import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Chart } from './Chart';
import { SavedRun } from './types';
import { sectorColor, seriesColor, Theme, useTheme, withAlpha } from './viz';

// The circuit map: layers that unfold in place (after the housing app's model map).
//   0  the policy loop: central bank (controller) → interest rates → economy (plant) → CPI values (sensor) → back;
//   1  the economy opened: its sectors and the flows and signals between them;
//   2  any block opened: its own circuit from the user's LTspice drawing, embedded in the block; click an element for
//      its equation and its course in the active run.
// Layers 0 and 1 are laid out by hand for reading (the drawing's own boxes differ too much in size); layer 2 is the
// drawing itself. Wheel / pinch zooms around the pointer, drag pans, the buttons zoom and fit; opening flies to the block.

interface El { name: string; ref: string; symbol: string; kind: string; rot: string; x: number; y: number; pins: number[][]; sector: string | null; expr: string; nodes: string[] }
interface Rect { x1: number; y1: number; x2: number; y2: number; title: string | null }
interface Txt { x: number; y: number; align: string; size: number; text: string }
interface Link { from: string; to: string; kind: 'flow' | 'signal'; via: string[] }
export interface MapData { bounds: number[]; wires: number[][]; flags: { x: number; y: number; name: string; ground: boolean }[]; rects: Rect[]; sectors: string[]; links: Link[]; texts: Txt[]; elements: El[] }
interface Trace { element: string; trace: string; years: number[]; values: number[] }
type Box = { x: number; y: number; w: number; h: number };
type VB = [number, number, number, number];

// ---------------------------------------------------------------- layout (map units)
const TOP: Record<string, Box> = {
  'Central Bank': { x: 40, y: 230, w: 250, h: 150 },
  'Interest Rates': { x: 380, y: 230, w: 250, h: 150 },
  Shock: { x: 840, y: 40, w: 190, h: 82 },
  'CPI values': { x: 380, y: 520, w: 250, h: 140 },
};
const ECO_CLOSED: Box = { x: 720, y: 170, w: 440, h: 270 };
const ECO_OPEN: Box = { x: 720, y: 170, w: 1000, h: 730 };
// sectors inside the opened economy, relative to its corner
const INNER: Record<string, Box> = {
  'Fiscal Authority': { x: 30, y: 64, w: 210, h: 300 },
  Households: { x: 270, y: 64, w: 400, h: 190 },
  Banks: { x: 700, y: 64, w: 270, h: 330 },
  'Wholesale banks': { x: 715, y: 104, w: 240, h: 150 },
  'Retail banks': { x: 715, y: 264, w: 240, h: 116 },
  NFC: { x: 270, y: 284, w: 400, h: 416 },
  'Domestic goods producers': { x: 290, y: 326, w: 360, h: 170 },
  'Capital producers': { x: 290, y: 512, w: 360, h: 168 },
  'Foreign Sector': { x: 700, y: 424, w: 270, h: 276 },
};
const ECONOMY = Object.keys(INNER);
const CONTAINERS: Record<string, string[]> = { Banks: ['Wholesale banks', 'Retail banks'], NFC: ['Domestic goods producers', 'Capital producers'] };
// What each block is in the loop, and the series that sums it up (sparkline and panel chart).
const INFO: Record<string, { role: string; series?: string; about: string }> = {
  'Central Bank': { role: 'controller', series: 'I(R)', about: 'The policy rule B_PI and the rate smoothing R15·C8 set the policy rate R (closed loop), or the given path B§R does (open loop).' },
  'Interest Rates': { role: 'transmission', series: 'I(R_retail)', about: 'From the policy rate to the rates the economy pays: wholesale, retail loan rate, savings and deposit rates, the long-term yield.' },
  Economy: { role: 'plant', series: 'I(GDP_real)', about: 'Households, firms, banks, government and the foreign sector. Open it to see the sectors and what flows between them.' },
  'CPI values': { role: 'sensor', series: 'I(CPI_filtered)', about: 'Measures the price level P, inflation CPI = 120·d ln P/dt and its filtered value, and holds the target π*. Fed back to the central bank.' },
  Shock: { role: 'disturbance', about: 'An external shock into the goods market.' },
  Households: { role: 'sector', series: 'I(L_cons)', about: 'Income, consumption, savings, deposits, bonds and the taxes households pay.' },
  'Fiscal Authority': { role: 'sector', series: 'I(Government_Debt)', about: 'Government spending, taxes, bonds and debt.' },
  NFC: { role: 'sector group', series: 'I(Labour_demand)', about: 'Non-financial corporations: goods producers and capital producers; aggregate supply.' },
  'Domestic goods producers': { role: 'sector', series: 'I(GDP_real)', about: 'Production, revenue, labour demand, loans and interest.' },
  'Capital producers': { role: 'sector', series: 'I(Investment)', about: 'Investment and the capital stock.' },
  Banks: { role: 'sector group', series: 'I(Leverage)', about: 'Wholesale and retail banks.' },
  'Wholesale banks': { role: 'sector', series: 'I(B_NW)', about: 'Bank balance sheet, net worth, leverage, deposits, bond holdings.' },
  'Retail banks': { role: 'sector', series: 'I(B_loanbal)', about: 'Loans to firms and households.' },
  'Foreign Sector': { role: 'sector', series: 'I(Exchange_rate)', about: 'Imports, exports and the exchange rate.' },
};
const kindColor = (t: Theme): Record<string, string> => ({ resistor: t.ink2, inductor: t.sectors[0], capacitor: t.sectors[2], 'behavioural current': t.sectors[1], 'current source': t.sectors[1], 'behavioural voltage': t.sectors[6], 'voltage source': t.sectors[6] });

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
const fit = (b: Box, k = 0.08): VB => { const p = Math.max(b.w, b.h) * k; return [b.x - p, b.y - p, b.w + 2 * p, b.h + 2 * p]; };
const mid = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];
function exitPoint(a: Box, b: Box): [number, number] {   // from the centre of a toward b, where the line leaves a
  const [ax, ay] = mid(a), [bx, by] = mid(b), dx = bx - ax, dy = by - ay;
  const s = Math.min(dx ? a.w / 2 / Math.abs(dx) : Infinity, dy ? a.h / 2 / Math.abs(dy) : Infinity, 1);
  return [ax + dx * s, ay + dy * s];
}

export function ModelMap({ scenario, closed, run }: { scenario: unknown; closed: boolean; run?: SavedRun }) {
  const t = useTheme();
  const KIND = kindColor(t);
  const [m, setM] = useState<MapData>();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string[]>([]);           // opened blocks
  const [whole, setWhole] = useState(false);                // the whole drawing, as LTspice shows it
  const [selEl, setSelEl] = useState<string>();
  const [selBlock, setSelBlock] = useState<string>('Central Bank');
  const [hover, setHover] = useState<string>();
  const [inspector, setInspector] = useState(false);  // the floating details card: shown once something is clicked
  const [trace, setTrace] = useState<Trace>();
  const [traceBusy, setTraceBusy] = useState(false);
  const [vb, setVb] = useState<VB>([0, 0, 1760, 940]);
  const [px, setPx] = useState(1);                          // map units per screen pixel
  const svg = useRef<SVGSVGElement>(null);
  const vbRef = useRef<VB>(vb);
  const anim = useRef(0);
  const drag = useRef<{ x: number; y: number; vb: VB; moved: boolean } | null>(null);
  vbRef.current = vb;

  useEffect(() => { api<MapData>('/model/map').then(setM).catch(e => setError(String(e.message ?? e))); }, []);
  const rects = useMemo(() => Object.fromEntries((m?.rects ?? []).filter(r => r.title).map(r => [r.title!, r])), [m]);
  // the smallest titled box of the drawing around a point (same rule as the backend's sector of an element)
  const ownerAt = useCallback((x: number, y: number) => {
    let best: string | null = null, area = Infinity;
    for (const [k, r] of Object.entries(rects)) { const a = (r.x2 - r.x1) * (r.y2 - r.y1); if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2 && a < area) { best = k; area = a; } }
    return best;
  }, [rects]);

  const ecoOpen = open.includes('Economy');
  const eco = ecoOpen ? ECO_OPEN : ECO_CLOSED;
  const boxOf = useCallback((id: string): Box | undefined => {
    if (id === 'Economy') return ecoOpen ? ECO_OPEN : ECO_CLOSED;
    if (TOP[id]) return TOP[id];
    const r = INNER[id]; return r && { x: ECO_OPEN.x + r.x, y: ECO_OPEN.y + r.y, w: r.w, h: r.h };
  }, [ecoOpen]);
  const ALL: Box = { x: 0, y: 0, w: ECO_OPEN.x + (ecoOpen ? ECO_OPEN.w : ECO_CLOSED.w) + 40, h: ecoOpen ? 940 : 700 };
  const LOOP_VIEW: Box = { x: 0, y: 0, w: ECO_CLOSED.x + ECO_CLOSED.w + 40, h: 700 };
  // An opened block grows (as in the housing app) and lies on top: a sector fills the economy, a top-level block
  // grows about 2.6 times around its centre (kept on the canvas). Its circuit then has room to be read.
  const expanded = useCallback((id: string): Box => {
    if (ECONOMY.includes(id)) return { x: ECO_OPEN.x + 16, y: ECO_OPEN.y + 50, w: ECO_OPEN.w - 32, h: ECO_OPEN.h - 66 };
    const b = TOP[id], w = Math.max(b.w * 2.6, 620), h = Math.max(b.h * 2.6, 420);
    return { x: Math.max(10, b.x + b.w / 2 - w / 2), y: Math.max(10, b.y + b.h / 2 - h / 2), w, h };
  }, []);
  const shown = open.find(o => o !== 'Economy');  // the one opened block besides the economy
  // The camera box for b: b (padded) fits in the part of the canvas left of the floating details card.
  const inspectorRef = useRef(true); inspectorRef.current = inspector;
  const view = useCallback((b: Box, k = 0.08): VB => {
    const cw = svg.current?.clientWidth ?? 1000, ch = svg.current?.clientHeight ?? 700;
    const avail = inspectorRef.current && cw > 900 ? cw - 370 : cw;
    const p = Math.max(b.w, b.h) * k, bw = b.w + 2 * p, bh = b.h + 2 * p, sc = Math.max(bw / avail, bh / ch);
    return [b.x - p - (sc * avail - bw) / 2, b.y - p - (sc * ch - bh) / 2, sc * cw, sc * ch];
  }, []);

  // ---------------------------------------------------------------- camera
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
    const w = Math.min(Math.max(v[2] * k, 30), whole ? 80000 : 6000), kk = w / v[2];
    setVb([cx - (cx - v[0]) * kk, cy - (cy - v[1]) * kk, v[2] * kk, v[3] * kk]);
  }, [whole]);
  const toSvg = (clientX: number, clientY: number) => {
    const p = new DOMPoint(clientX, clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse()); return [p.x, p.y];
  };
  // native, non-passive wheel listener: React's is passive, so the page would scroll (and a touchpad pinch would zoom
  // the whole browser page) instead of the map
  useEffect(() => {
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

  // ---------------------------------------------------------------- open, close, select
  // Top-level blocks open side by side; inside the economy one sector is open at a time.
  // Opening flies to the block, closing flies back to its parent.
  function toggle(id: string) {
    if (open.includes(id)) {
      const next = open.filter(o => o !== id && !(id === 'Economy' && ECONOMY.includes(o)));
      setOpen(next);
      flyTo(view(next.includes('Economy') ? ECO_OPEN : LOOP_VIEW, 0.04));
    } else if (id === 'Economy') {
      setOpen(['Economy']); flyTo(view(ECO_OPEN, 0.04));
    } else {
      setOpen([...(ECONOMY.includes(id) || ecoOpen ? ['Economy'] : []), id]);
      flyTo(view(expanded(id), 0.03));
    }
    setSelBlock(id); setSelEl(undefined);
  }
  function crumb(i: number) {
    if (i === 0) { setOpen([]); flyTo(view(LOOP_VIEW, 0.04)); setSelBlock('Central Bank'); setSelEl(undefined); return; }
    const id = open[i - 1];
    if (id === 'Economy') { setOpen(['Economy']); flyTo(view(ECO_OPEN, 0.04)); } else flyTo(view(expanded(id), 0.03));
    setSelBlock(id); setSelEl(undefined);
  }
  function showWhole(on: boolean) {
    setWhole(on); setSelEl(undefined);
    cancelAnimationFrame(anim.current);
    if (on && m) { const b = m.bounds; setVb([b[0], b[1], b[2] - b[0], b[3] - b[1]]); }
    else setVb(view(ALL, 0.03));
  }
  useEffect(() => { if (m) setVb(view(LOOP_VIEW, 0.04)); }, [m]);  // start: the policy loop, once the canvas exists
  useEffect(() => {
    if (!selEl) return;
    let live = true; setTrace(undefined); setTraceBusy(true);
    api<Trace>('/trace', { scenario, element: selEl }).then(r => { if (live) setTrace(r); }).catch(() => { if (live) setTrace(undefined); }).finally(() => { if (live) setTraceBusy(false); });
    return () => { live = false; };
  }, [selEl, scenario]);

  if (error) return <p className="notice bad">{error}</p>;
  if (!m) return <div className="panel empty"><p className="muted">Loading the circuit…</p></div>;

  const S = (n: number) => n * px;  // screen pixels -> map units
  const series = (id: string) => { const k = INFO[id]?.series; return k && run?.series[k] ? { key: k, ...run.series[k] } : undefined; };
  const colorOf = (id: string) => id === 'Economy' ? t.ink2 : sectorColor(t, id);
  const topOf = (s: string | null) => s && ECONOMY.includes(s) ? 'Economy' : s;
  const focus = hover ?? selBlock;

  // ---------------------------------------------------------------- the drawing, whole or of one box
  // owner: the box whose own elements, wires, flags and notes are drawn (null: everything)
  // k: drawing units per map unit (1 for the whole circuit); labels keep about 11 screen pixels
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
        const cx = (e.pins[0][0] + e.pins[1][0]) / 2, cy = (e.pins[0][1] + e.pins[1][1]) / 2, on = e.name === selEl;
        return <g key={e.name} data-el={e.name} className={'el' + (on ? ' sel' : '')}>
          <g transform={transform(e)} style={{ stroke: KIND[e.kind] }} className="glyph"><Glyph symbol={e.symbol}/></g>
          <circle cx={cx} cy={cy} r={46} className="mark" style={{ fill: KIND[e.kind] }}/>
          <circle cx={cx} cy={cy} r={Math.max(56, 9 * px * k)} className="hit"/>
          <text x={cx + 40} y={cy} className="ellabel" fontSize={fs} dominantBaseline="middle">{e.ref}</text>
        </g>;
      })}
    </>;
  }

  // ---------------------------------------------------------------- blocks
  function block(id: string) {
    const isOpen = open.includes(id), b = isOpen && id !== 'Economy' ? expanded(id) : boxOf(id)!, c = colorOf(id), container = !!CONTAINERS[id];
    const info = INFO[id], ser = series(id), sel = selBlock === id && !selEl, head = 40;
    const r = rects[id];
    const spark = ser && !isOpen && !container ? (() => {
      const y = ser.values, n = y.length, lo = Math.min(...y), hi = Math.max(...y), span = hi - lo || 1;
      const sx = b.x + 14, sy = b.y + b.h - 26, ww = b.w - 28, hh = Math.max(16, b.h - head - 52);
      const d = y.filter((_, i) => i % 8 === 0 || i === n - 1).map((v, i, a) => `${sx + ww * i / (a.length - 1)},${sy - hh * (v - lo) / span}`).join(' ');
      return <><polyline points={d} fill="none" stroke={seriesColor(t, ser.key)} strokeWidth={2}/>
        <text x={b.x + b.w - 12} y={b.y + b.h - 9} textAnchor="end" fontSize={11} className="blk-sub">{ser.label}: {y[n - 1].toPrecision(3)}{ser.unit === '%' ? ' %' : ''}</text></>;
    })() : null;
    // an opened block shows its own circuit from the drawing, scaled into the block below its header
    const inner = isOpen && r && id !== 'Economy' ? (() => {
      const vw = r.x2 - r.x1 + 80, vh = r.y2 - r.y1 + 80, iw = b.w - 12, ih = b.h - head - 6, k = Math.max(vw / iw, vh / ih);
      return <svg x={b.x + 6} y={b.y + head} width={iw} height={ih} viewBox={`${r.x1 - 40} ${r.y1 - 40} ${vw} ${vh}`} preserveAspectRatio="xMidYMid meet" className="inner-circuit">{circuit(id, k)}</svg>;
    })() : null;
    const toggleable = id !== 'Banks';
    return <g key={id} className={'blk' + (isOpen ? ' open' : '') + (container ? ' container' : '') + (sel ? ' sel' : '') + (focus === id ? ' focus' : '')} data-block={id}
      onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover(h => h === id ? undefined : h)}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} style={{ fill: isOpen ? t.panel : withAlpha(c, container ? 0.05 : 0.13), stroke: c, strokeWidth: sel ? 3 : 1.6 }}/>
      <text x={b.x + 12} y={b.y + 22} fontSize={id === 'Economy' ? 19 : 15} className="blk-title">{id}{id === 'Economy' ? ' (plant)' : ''}</text>
      {info && <text x={b.x + 12} y={b.y + 36} fontSize={11} className="blk-sub">{info.role}{id === 'Central Bank' ? (closed ? ' · rule sets R' : ' · R given (open loop)') : ''}{isOpen && id !== 'Economy' ? ' · circuit from your drawing' : ''}</text>}
      {spark}{inner}
      {toggleable && <g className="blk-toggle" data-toggle={id} transform={`translate(${b.x + b.w - 18} ${b.y + 18})`}>
        <circle r={11} strokeWidth={1.5}/><path d={'M-5 0 H5' + (isOpen ? '' : ' M0 -5 V5')} strokeWidth={2}/>
        <title>{isOpen ? `Close ${id}` : `Open ${id}`}</title></g>}
    </g>;
  }

  // the loop's signals at layer 0 (hand-routed), and the links between sectors at layer 1 (from the netlist)
  const R = (id: string) => boxOf(id)!;
  const cb = R('Central Bank'), ir = R('Interest Rates'), sh = R('Shock'), cpi = R('CPI values');
  const yIr = ir.y + ir.h / 2, yCpi = cpi.y + cpi.h / 2, xCb = cb.x + cb.w / 2;
  const ecoToCpi = eco.y + eco.h > yCpi + 20 ? `M${eco.x} ${yCpi} H${cpi.x + cpi.w}` : `M${eco.x + 70} ${eco.y + eco.h} V${yCpi} H${cpi.x + cpi.w}`;
  const loop = [
    { d: `M${cb.x + cb.w} ${yIr} H${ir.x}`, label: closed ? 'policy rate R' : 'policy rate R (given path)', at: [(cb.x + cb.w + ir.x) / 2, yIr - 10], key: 'I(R)' },
    { d: `M${ir.x + ir.w} ${yIr} H${eco.x}`, label: 'loan, deposit and bond rates', at: [(ir.x + ir.w + eco.x) / 2, yIr - 10], key: 'I(R_retail)' },
    { d: `M${sh.x + sh.w / 2} ${sh.y + sh.h} V${eco.y}`, label: 'shock', at: [sh.x + sh.w / 2 + 8, (sh.y + sh.h + eco.y) / 2 + 4], anchor: 'start' as const },
    { d: ecoToCpi, label: 'prices P', at: [(cpi.x + cpi.w + Math.min(eco.x, eco.x + 70)) / 2, yCpi - 10] },
    { d: `M${cpi.x} ${yCpi} H${xCb} V${cb.y + cb.h}`, label: 'inflation π and target π*', at: [(cpi.x + xCb) / 2 + 30, yCpi - 10], key: 'I(CPI_filtered)', feedback: true },
  ];
  const lastVal = (k?: string) => { const s = k && run?.series[k]; return s ? ` = ${s.values[s.values.length - 1].toFixed(2)}${s.unit === '%' ? ' %' : ''}` : ''; };
  const edges = new Map<string, { a: string; b: string; kind: Link['kind']; via: string[] }>();
  if (ecoOpen) for (const l of m.links) {
    const a = l.from, b = l.to;
    if (!INNER[a] || !INNER[b] || a === b || CONTAINERS[a]?.includes(b) || CONTAINERS[b]?.includes(a)) continue;
    const key = l.kind === 'flow' ? [a, b].sort().join('|') + '|f' : `${a}|${b}|s`;
    const e = edges.get(key) ?? { a, b, kind: l.kind, via: [] }; e.via.push(...l.via); edges.set(key, e);
  }
  const blockIds = [...Object.keys(TOP), 'Economy', ...(ecoOpen ? ECONOMY : [])];

  const el = m.elements.find(e => e.name === selEl);
  const sb = selBlock, sbInfo = INFO[sb], sbSeries = series(sb);
  const sbLinks = m.links.filter(l => { const a = l.from === sb || (sb === 'Economy' && topOf(l.from) === sb), b = l.to === sb || (sb === 'Economy' && topOf(l.to) === sb); return (a || b) && !(a && b); });
  const crumbs = ['Policy loop', ...open];

  return <div className="mapwrap">
    <div className="panel map-panel">
      <div className="pick-row map-head">
        {whole ? <span className="crumbs"><b>Whole circuit</b></span> : <nav className="crumbs" aria-label="Layers">{crumbs.map((p, i) => <span key={p}>{i > 0 && <span className="sep">›</span>}
          <button className={'link-btn' + (i === crumbs.length - 1 ? ' here' : '')} onClick={() => crumb(i)}>{p}</button></span>)}</nav>}
        <div className="map-tools">
          <label className="check small"><input type="checkbox" checked={whole} onChange={e => showWhole(e.target.checked)}/>Whole circuit</label>
          <button className="ghost icon" onClick={() => zoomCentre(1 / 1.4)} aria-label="Zoom in" title="Zoom in">+</button>
          <button className="ghost icon" onClick={() => zoomCentre(1.4)} aria-label="Zoom out" title="Zoom out">−</button>
          <button className="ghost" onClick={() => whole ? showWhole(true) : flyTo(view(ALL, 0.03))} title="Show everything">Fit</button>
          {!inspector && <button className="ghost" onClick={() => setInspector(true)}>Details</button>}
        </div>
      </div>
      <p className="muted note">Click <b>+</b> on a block (or double-click it) to open it in place: the economy shows its sectors, every block shows its circuit from your drawing. Click an element for its equation and its course in the active run. Scroll or pinch to zoom, drag to move.</p>
      <svg ref={svg} className="schem" viewBox={vb.join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Circuit map"
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
          const tg = hit?.closest('[data-toggle]'), elh = hit?.closest('[data-el]'), bl = hit?.closest('[data-block]');
          if (tg) toggle(tg.getAttribute('data-toggle')!);
          else if (hit?.closest('[data-scrim]') && shown) toggle(shown);
          else if (elh) { setSelEl(elh.getAttribute('data-el')!); setInspector(true); }
          else if (bl) { setSelBlock(bl.getAttribute('data-block')!); setSelEl(undefined); setInspector(true); }
        }}
        onDoubleClick={e => { const tgt = e.target as Element, bl = tgt.closest('[data-block]'); if (bl && !tgt.closest('[data-el]') && !tgt.closest('[data-toggle]')) { const id = bl.getAttribute('data-block')!; if (!open.includes(id) && id !== 'Banks') toggle(id); } }}>
        <defs>
          <marker id="map-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="context-stroke"/></marker>
        </defs>
        {whole ? circuit(null) : <>
          {/* the loop */}
          <g className="loop">{loop.map((l, i) => <g key={i}>
            <path d={l.d} className={'sig' + (l.feedback ? ' fb' : '')} markerEnd="url(#map-ah)"/>
            <text x={l.at[0]} y={l.at[1]} textAnchor={l.anchor ?? 'middle'} className="sig-label">{l.label}{lastVal(l.key)}</text>
          </g>)}</g>
          {/* economy, then the links over it, then containers and sectors; the opened block last, over a light scrim */}
          {blockIds.filter(id => id === 'Economy').map(block)}
          {/* links between sectors: flows solid (a shared node: current passes), signals dashed with an arrow (one reads the other) */}
          <g className="edges">{[...edges.values()].map((e, i) => {
            const A = R(e.a), B = R(e.b), [x1, y1] = exitPoint(A, B), [x2, y2] = exitPoint(B, A);
            const on = focus === e.a || focus === e.b;
            const nx = -(y2 - y1), ny = x2 - x1, L = Math.hypot(nx, ny) || 1, off = (e.kind === 'signal' ? 1 : -1) * Math.min(L * 0.15, 30);
            const cx = (x1 + x2) / 2 + nx / L * off, cy = (y1 + y2) / 2 + ny / L * off;
            return <path key={i} d={`M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`} className={`edge ${e.kind}${on ? ' on' : ''}`}
              markerEnd={e.kind === 'signal' ? 'url(#map-ah)' : undefined}>
              <title>{`${e.a} ${e.kind === 'flow' ? '⇄' : '→'} ${e.b}: ${[...new Set(e.via)].slice(0, 6).join(', ')}`}</title></path>;
          })}</g>
          {blockIds.filter(id => CONTAINERS[id] && id !== shown).map(block)}
          {blockIds.filter(id => !CONTAINERS[id] && id !== 'Economy' && id !== shown).map(block)}
          {shown && <rect className="scrim" x={-5000} y={-5000} width={12000} height={12000} data-scrim="1"/>}
          {shown && block(shown)}
        </>}
      </svg>
      <p className="muted note legend-line"><span className="lg sig"/> loop signal <span className="lg flow"/> flow between sectors (shared node) <span className="lg signal"/> signal between sectors (one reads the other). Hover a block to highlight its links.</p>
    {inspector && <aside className="panel elinfo floating">
      <button className="pin-close" onClick={() => setInspector(false)} aria-label="Hide details" title="Hide details">×</button>
      {el ? <>
        <button className="link-btn back" onClick={() => setSelEl(undefined)}>← {el.sector ?? sb}</button>
        <h3>{el.ref}</h3>
        <p className="muted small">{el.kind}{el.sector ? ` · ${el.sector}` : ' · outside the sector boxes'} · netlist name <code>{el.name}</code></p>
        <p className="small">Nodes: <code>{el.nodes.join(' → ')}</code></p>
        <pre className="expr">{el.expr || '—'}</pre>
        {traceBusy ? <p className="muted note">Simulating the current scenario for this trace…</p>
          : trace ? <Chart title={trace.trace} unit={el.kind === 'inductor' || el.kind.includes('current') ? 'current (flow)' : 'value'} height={220} group={null}
              lines={[{ name: trace.trace, x: trace.years, y: trace.values, color: KIND[el.kind] ?? t.inflation }]}/>
          : <p className="muted note">No trace for this element.</p>}
      </> : <>
        <h3><span className="dot" style={{ background: colorOf(sb) }}/> {sb}</h3>
        {sbInfo && <p className="muted small">{sbInfo.role}</p>}
        {sbInfo && <p className="small">{sbInfo.about}</p>}
        {sb !== 'Banks' && <button className="ghost" onClick={() => toggle(sb)}>{open.includes(sb) ? 'Close' : 'Open'} {sb}</button>}
        {sbSeries && run && <Chart title={sbSeries.label} unit={sbSeries.unit} height={200} group={null} lines={[{ name: sbSeries.label, x: run.years, y: sbSeries.values, color: seriesColor(t, sbSeries.key) }]}/>}
        {sbLinks.length > 0 && <><h3 className="mt">Connections</h3>
          <ul className="conn">{sbLinks.slice(0, 14).map((l, i) => <li key={i}><span className="dot" style={{ background: colorOf(topOf(l.from) ?? '') }}/>{l.from} <b>{l.kind === 'flow' ? '⇄' : '→'}</b> <span className="dot" style={{ background: colorOf(topOf(l.to) ?? '') }}/>{l.to}
            <small className="muted"> {l.via.slice(0, 3).map(v => v.replace(/[A-Z]§/g, '')).join(', ')}{l.via.length > 3 ? ' …' : ''}</small></li>)}</ul></>}
      </>}
    </aside>}
    </div>
  </div>;
}
