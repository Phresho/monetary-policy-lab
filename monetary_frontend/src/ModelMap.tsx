import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Chart } from './Chart';
import { sectorColor, Theme, useTheme } from './viz';

interface El { name: string; ref: string; symbol: string; kind: string; rot: string; x: number; y: number; pins: number[][]; sector: string | null; expr: string; nodes: string[] }
interface Rect { x1: number; y1: number; x2: number; y2: number; title: string | null }
interface Txt { x: number; y: number; align: string; size: number; text: string }
interface Link { from: string; to: string; kind: 'flow' | 'signal'; via: string[] }
export interface MapData { bounds: number[]; wires: number[][]; flags: { x: number; y: number; name: string; ground: boolean }[]; rects: Rect[]; sectors: string[]; links: Link[]; texts: Txt[]; elements: El[] }
interface Trace { element: string; trace: string; years: number[]; values: number[] }

// Sectors take the reference categorical slots in order (always named beside the colour: chips, link list);
// element kinds the first slots too, named in the element panel.
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

function transform(e: El) {
  const deg = Number(e.rot.slice(1));
  return `translate(${e.x} ${e.y})${e.rot.startsWith('M') ? ' scale(-1 1)' : ''} rotate(${deg})`;
}

// ---------------------------------------------------------------- level 1: the policy loop
function LoopDiagram({ closed, gains, onOpenEconomy, onPick }: { closed: boolean; gains: string; onOpenEconomy: () => void; onPick: (name: string) => void }) {
  const H = 84;
  const box = (x: number, y: number, w: number, title: string, sub: string, onClick?: () => void, strong = false) =>
    <g className={'lblock' + (onClick ? ' click' : '') + (strong ? ' strong' : '')} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
       onKeyDown={e => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}>
      <rect x={x} y={y} width={w} height={H} rx={12}/><text x={x + w / 2} y={y + 36}>{title}</text><text className="sub" x={x + w / 2} y={y + 63}>{sub}</text>
    </g>;
  const on = closed ? 'on' : 'off';
  const y0 = 30, yc = y0 + H / 2, y1 = 300, yb = y1 + H / 2;
  return <svg className="loopsvg" viewBox="0 0 1000 420" role="img" aria-label="Policy loop">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="context-stroke"/></marker></defs>
    {box(0, y0, 150, 'Target π*', 'Target_CPI', () => onPick('B§Target_CPI'))}
    <circle cx={195} cy={yc} r={20} className="sum"/><text x={195} y={yc + 7} className="sumtxt">Σ</text><text x={168} y={yc + 44} className="tiny">−</text>
    {box(250, y0, 200, 'Policy rule', closed ? gains : 'computed, not used', () => onPick('B_PI'), closed)}
    {box(490, y0, 190, 'Rate smoothing', 'R15·C8 = 207 units', () => onPick('R15'))}
    {box(740, y0, 250, 'Economy', 'click to open the circuit', onOpenEconomy, true)}
    {box(740, y1, 250, 'CPI filter', 'τ = 3 units → CPI_filtered', () => onPick('B§CPI_filtered'))}
    {!closed && box(490, 165, 190, 'Given rate path', 'B§R (open loop)', () => onPick('B§R'), true)}
    <path className="w on" d={`M150 ${yc} H173`} markerEnd="url(#ah)"/>
    <path className={`w ${on}`} d={`M215 ${yc} H248`} markerEnd="url(#ah)"/>
    <path className={`w ${on}`} d={`M450 ${yc} H488`} markerEnd="url(#ah)"/>
    <path className={`w ${on}`} d={`M680 ${yc} H738`} markerEnd="url(#ah)"/>
    {!closed && <path className="w on" d={`M680 207 H710 V${yc + 20} H738`} markerEnd="url(#ah)"/>}
    <text x={709} y={y0 - 8} className="tiny mid">rate R</text>
    <path className="w on" d={`M990 ${y0 + H} V${y1}`} markerEnd="url(#ah)"/>
    <text x={980} y={(y0 + H + y1) / 2} className="tiny end">prices → CPI</text>
    <path className="w on" d={`M740 ${yb} H195 V${yc + 22}`} markerEnd="url(#ah)"/>
    <text x={460} y={yb - 12} className="tiny mid">measured inflation (feedback)</text>
  </svg>;
}

// ---------------------------------------------------------------- level 2: the schematic
export function ModelMap({ scenario, closed }: { scenario: unknown; closed: boolean }) {
  const [m, setM] = useState<MapData>();
  const [error, setError] = useState('');
  const [level, setLevel] = useState<'loop' | 'circuit'>('loop');
  const [vb, setVb] = useState<number[]>();
  const [sel, setSel] = useState<string>();
  const [sector, setSector] = useState<string>();
  const [trace, setTrace] = useState<Trace>();
  const [traceBusy, setTraceBusy] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const t = useTheme();
  const KIND_COLOR = kindColor(t);
  const drag = useRef<{ x: number; y: number; vb: number[]; moved: boolean } | null>(null);

  useEffect(() => { api<MapData>('/model/map').then(d => { setM(d); setVb(fit(d.bounds)); }).catch(e => setError(String(e.message ?? e))); }, []);
  const colour = useMemo(() => Object.fromEntries((m?.sectors ?? []).map(s => [s, sectorColor(t, s)])), [m, t]);
  const el = m?.elements.find(e => e.name === sel);
  const s = scenario as { kp: number; ki: number; kd: number };

  useEffect(() => {  // trace of the selected element in the current scenario (runs it if needed, ~15 s)
    if (!sel) return;
    let live = true; setTrace(undefined); setTraceBusy(true);
    api<Trace>('/trace', { scenario, element: sel }).then(t => { if (live) setTrace(t); }).catch(() => { if (live) setTrace(undefined); }).finally(() => { if (live) setTraceBusy(false); });
    return () => { live = false; };
  }, [sel, scenario]);

  function fit(b: number[]) { return [b[0], b[1], b[2] - b[0], b[3] - b[1]]; }
  function toSvg(cx: number, cy: number) {
    const ctm = svg.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(cx, cy).matrixTransform(ctm); return [p.x, p.y];
  }
  function zoomTo(r: Rect) { const pad = 250; setVb([r.x1 - pad, r.y1 - pad, r.x2 - r.x1 + 2 * pad, r.y2 - r.y1 + 2 * pad]); }
  function pickSector(t: string) {
    setSector(t); const r = m!.rects.find(r => r.title === t); if (r) zoomTo(r);
  }
  function pick(name: string) {
    setSel(name);
    if (level === 'circuit') return;
  }
  function openElement(name: string) {
    setLevel('circuit'); setSel(name);
    const e = m?.elements.find(x => x.name === name);
    if (e) setVb([e.x - 900, e.y - 600, 1800, 1200]);
  }

  if (error) return <p className="notice bad">{error}</p>;
  if (!m || !vb) return <div className="panel empty"><p className="muted">Loading the schematic…</p></div>;
  const gains = `Kp ${s.kp} · Ki ${s.ki} · Kd ${s.kd}`;
  const outside = m.elements.filter(e => !e.sector);
  const fs = Math.max(vb[2] / 70, 30);  // label size follows the zoom

  return <div className="mapgrid">
    <div className="panel">
      <div className="pick-row">
        <div className="segmented small-seg">
          <button className={level === 'loop' ? 'active' : ''} onClick={() => setLevel('loop')}>Policy loop</button>
          <button className={level === 'circuit' ? 'active' : ''} onClick={() => setLevel('circuit')}>Circuit (your schematic)</button>
        </div>
        {level === 'circuit' && <button className="ghost" onClick={() => { setVb(fit(m.bounds)); setSector(undefined); }}>Whole schematic</button>}
      </div>
      {level === 'loop' ? <>
        <p className="muted note">The control loop of the model. Click a block for its element; open the economy to see the circuit.</p>
        <LoopDiagram closed={closed} gains={gains} onOpenEconomy={() => { setLevel('circuit'); setVb(fit(m.bounds)); }} onPick={openElement}/>
        <h3>Sectors and what connects them</h3>
        <div className="links">
          {m.links.map((l, i) => <div key={i} className="link"><span className="dot" style={{ background: colour[l.from] }}/>{l.from} <span className={'arrow ' + l.kind}>{l.kind === 'flow' ? '⇄' : '→'}</span> <span className="dot" style={{ background: colour[l.to] }}/>{l.to}
            <small className="muted"> {l.kind === 'flow' ? 'shared net' : 'reads'}: {l.via.slice(0, 4).map(v => v.replace(/[A-Z]§/g, '')).join(', ')}{l.via.length > 4 ? ' …' : ''}</small></div>)}
        </div>
      </> : <>
        <div className="chips">
          {m.sectors.map(t => <button key={t} className={sector === t ? 'on' : ''} onClick={() => pickSector(t)}><span className="dot" style={{ background: colour[t] }}/>{t}</button>)}
        </div>
        <p className="muted note">Drawn from {'model/Model_Bank_20261111_bank.asc'}; every connection is checked against the netlist. Scroll to zoom, drag to move, click an element.</p>
        <svg ref={svg} className="schem" viewBox={vb.join(' ')} preserveAspectRatio="xMidYMid meet"
          onWheel={e => {
            const [px, py] = toSvg(e.clientX, e.clientY); const k = e.deltaY > 0 ? 1.18 : 1 / 1.18;
            setVb(old => { const [x, y, w, h] = old ?? vb; return [px - (px - x) * k, py - (py - y) * k, w * k, h * k]; });
          }}
          onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, vb, moved: false }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
          onPointerMove={e => {
            const d = drag.current; if (!d) return;
            const dx = e.clientX - d.x, dy = e.clientY - d.y; if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
            if (!d.moved) return;
            const sc = d.vb[2] / svg.current!.clientWidth;
            setVb([d.vb[0] - dx * sc, d.vb[1] - dy * sc, d.vb[2], d.vb[3]]);
          }}
          onPointerUp={e => {
            const d = drag.current; drag.current = null;
            if (d && !d.moved) {
              const hit = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest('[data-el]');
              if (hit) pick(hit.getAttribute('data-el')!);
            }
          }}>
          {m.rects.map((r, i) => r.title && <rect key={i} x={r.x1} y={r.y1} width={r.x2 - r.x1} height={r.y2 - r.y1} rx={20}
            className={'sector' + (sector === r.title ? ' on' : '')} style={{ fill: colour[r.title], stroke: colour[r.title] }}/>)}
          {m.texts.map((t, i) => <text key={i} x={t.x} y={t.y} className="asctext" fontSize={10 + t.size * 9}
            textAnchor={t.align.endsWith('Right') ? 'end' : 'start'} dominantBaseline="middle"
            transform={t.align.startsWith('V') ? `rotate(-90 ${t.x} ${t.y})` : undefined}>{t.text}</text>)}
          <g className="wires">{m.wires.map((w, i) => <line key={i} x1={w[0]} y1={w[1]} x2={w[2]} y2={w[3]}/>)}</g>
          {m.flags.map((f, i) => f.ground
            ? <path key={i} className="gnd" d={`M${f.x} ${f.y} v14 m-22 0 h44 m-32 10 h20 m-10 10 h0`}/>
            : <text key={i} x={f.x + 8} y={f.y - 10} className="flag" fontSize={30}>{f.name}</text>)}
          {m.elements.map(e => {
            const cx = (e.pins[0][0] + e.pins[1][0]) / 2, cy = (e.pins[0][1] + e.pins[1][1]) / 2;
            const on = e.name === sel, dim = sector && e.sector !== sector;
            return <g key={e.name} data-el={e.name} className={'el' + (on ? ' sel' : '') + (dim ? ' dim' : '')}>
              <g transform={transform(e)} style={{ stroke: KIND_COLOR[e.kind] }} className="glyph"><Glyph symbol={e.symbol}/></g>
              <circle cx={cx} cy={cy} r={Math.max(46, vb[2] / 160)} className="mark" style={{ fill: KIND_COLOR[e.kind] }}/>
              <circle cx={cx} cy={cy} r={Math.max(46, vb[2] / 160)} className="hit"/>
              <text x={cx + 34} y={cy} className="ellabel" fontSize={fs * 0.62} dominantBaseline="middle">{e.ref}</text>
            </g>;
          })}
        </svg>
        <p className="muted note">{outside.length} elements sit outside the sector boxes in the schematic (accounts and helper signals such as {outside.slice(0, 5).map(e => e.ref).join(', ')}…); they are drawn where they are.</p>
      </>}
    </div>
    <aside className="panel elinfo">
      {!el ? <p className="muted">Click an element (or a block of the loop) to see its equation and its course in the current scenario.</p> : <>
        <h3>{el.ref}</h3>
        <p className="muted small">{el.kind}{el.sector ? ` · ${el.sector}` : ' · outside the sector boxes'} · netlist name <code>{el.name}</code></p>
        <p className="small">Nodes: <code>{el.nodes.join(' → ')}</code></p>
        <pre className="expr">{el.expr || '—'}</pre>
        {level === 'loop' && <button className="ghost" onClick={() => openElement(el.name)}>Show in the circuit</button>}
        {traceBusy ? <p className="muted note">Simulating the current scenario for this trace…</p>
          : trace ? <Chart title={trace.trace} unit={el.kind === 'inductor' || el.kind.includes('current') ? 'current (flow)' : 'value'} height={220}
              lines={[{ name: trace.trace, x: trace.years, y: trace.values, color: KIND_COLOR[el.kind] ?? t.inflation }]} group={null}/>
          : <p className="muted note">No trace for this element.</p>}
      </>}
    </aside>
  </div>;
}
