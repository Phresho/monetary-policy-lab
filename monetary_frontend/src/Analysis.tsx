import { useMemo, useState } from 'react';
import { Plot } from './Plot';
import { useTheme } from './viz';

interface Bode { mag_db: number[]; phase_deg: number[] }
interface Pole { re: number; im: number; cycle_yr: number | null; half_life_yr: number | null }
interface Crossing { w: number; cycle_yr: number; pm_deg?: number; gm_db?: number }
export interface AnalysisResult {
  t_op_years: number; rate_at_op_pct: number; w: number[]; cycle_yr: number[];
  plant: Bode; controller: Bode; loop: Bode; S_db: number[]; T_db: number[];
  nyquist: { re: number[]; im: number[] };
  others: Record<string, Bode & { label: string }>;
  margins: { pm: Crossing | null; gm: Crossing | null; crossovers: Crossing[]; phase_crossovers: Crossing[]; ms: number; ms_w: number };
  fit: { order: number; rel_rms_pct: number; plant_db: number[] };
  open_poles: Pole[]; closed_poles: Pole[]; verdict: 'stable' | 'drift' | 'unstable'; drift_doubling_yr: number[]; unstable_open: number;
  step: { years: number[]; inflation: number[]; rate: number[] };
}

const LOGX = { type: 'log', title: { text: 'frequency (rad/yr)' }, exponentformat: 'power' };
const fmt = (v: number | null | undefined, d = 1) => v == null || !isFinite(v) ? '–' : v.toFixed(d);
const cyc = (v: number) => v >= 1 ? `${v.toFixed(1)} yr` : v >= 1 / 12 ? `${(v * 12).toFixed(1)} months` : `${(v * 365).toFixed(0)} days`;

export function Analysis({ a, busy, tOp, setTOp, closedMode }: { a?: AnalysisResult; busy: boolean; tOp: number; setTOp: (v: number) => void; closedMode: boolean }) {
  const [show, setShow] = useState({ loop: true, plant: false, ctrl: false });
  const [other, setOther] = useState('I(GDP_real)');
  const th = useTheme();
  // loop and |T| (inflation follows) blue, plant and |S| orange, rule aqua: the validated three-colour set.
  const C = { loop: th.inflation, plant: th.rate, ctrl: th.real, fit: th.muted, s: th.rate, t: th.inflation };

  const hover = useMemo(() => a?.cycle_yr.map(cyc), [a]);
  const bode = useMemo(() => {
    if (!a) return null;
    const tr = (name: string, y: number[], color: string, dash = 'solid') => ({ type: 'scatter', mode: 'lines', name, x: a.w, y, customdata: hover, line: { color, width: 2.2, dash }, hovertemplate: `%{y:.1f}<extra>${name} · cycle %{customdata}</extra>` });
    const mag = [], ph = [];
    if (show.loop) { mag.push(tr('loop L = −P·H·C', a.loop.mag_db, C.loop)); ph.push(tr('loop L', a.loop.phase_deg, C.loop)); }
    if (show.plant) { mag.push(tr('plant P: rate → inflation', a.plant.mag_db, C.plant), tr('plant, fitted model', a.fit.plant_db, C.fit, 'dot')); ph.push(tr('plant P', a.plant.phase_deg, C.plant)); }
    if (show.ctrl) { mag.push(tr('rule × smoothing C·H', a.controller.mag_db, C.ctrl)); ph.push(tr('C·H', a.controller.phase_deg, C.ctrl)); }
    const marks = [a.margins.pm, a.margins.gm].filter(Boolean).map(m => ({ type: 'line', x0: m!.w, x1: m!.w, yref: 'paper', y0: 0, y1: 1, line: { color: th.muted, dash: 'dot', width: 1 } }));
    const cy = (v: number) => v >= 1 ? `${v.toFixed(1)} yr` : `${(v * 12).toFixed(1)} mo`;
    const notes = [
      ...(a.margins.pm ? [{ x: Math.log10(a.margins.pm.w), y: 1, yref: 'paper', yanchor: 'top', xanchor: 'left', xshift: 4, showarrow: false, text: `PM ${a.margins.pm.pm_deg!.toFixed(0)}° @ ${cy(a.margins.pm.cycle_yr)}`, font: { size: 11, color: th.ink2 } }] : []),
      ...(a.margins.gm ? [{ x: Math.log10(a.margins.gm.w), y: 0.88, yref: 'paper', yanchor: 'top', xanchor: 'left', xshift: 4, showarrow: false, text: `GM ${a.margins.gm.gm_db!.toFixed(1)} dB @ ${cy(a.margins.gm.cycle_yr)}`, font: { size: 11, color: th.ink2 } }] : []),
    ];
    return { mag, ph, marks, notes };
  }, [a, show, hover, th]);

  if (!a) return <div className="panel empty"><p className="muted">{busy ? 'Linearising the model with ngspice (first time ~15 s, later moments ~40 s)…' : 'No analysis yet.'}</p></div>;
  const m = a.margins;
  const verdict = { stable: ['✓ Stable', 'good'], drift: ['✓ Stable, apart from slow drift', 'good'], unstable: ['✕ Unstable', 'bad'] }[a.verdict];
  const pm = m.pm, gm = m.gm;
  const ny = { re: a.nyquist.re, im: a.nyquist.im };
  const circle = Array.from({ length: 181 }, (_, i) => i * 2 * Math.PI / 180);
  const cp = a.closed_poles, op = a.open_poles;
  const stepUnstable = a.verdict === 'unstable';
  const o = a.others[other];

  return <div className={busy ? 'busy' : ''}>
    <div className="panel analysis-head">
      <label className="slider tight">
        <span className="slider-head">Linearise at<output>{tOp === 0 ? 'the steady state (year 0)' : `year ${tOp.toFixed(1)}`}</output></span>
        <input type="range" min={0} max={13} step={0.5} value={tOp} onChange={e => setTOp(Number(e.target.value))}/>
        <small>The economy grows, so the plant changes over time: at a later year the states come from the {closedMode ? 'closed-loop' : 'open-loop'} simulation of this scenario. Policy rate there: {fmt(a.rate_at_op_pct, 2)} %.</small>
      </label>
      {busy && <p className="muted note">Updating…</p>}
    </div>
    <div className="kpis">
      <div className={`kpi verdict ${verdict[1]}`}><span>Closed loop (linear)</span><strong>{verdict[0]}</strong>
        <small>{a.verdict === 'drift' ? `growth mode doubling in ${a.drift_doubling_yr.map(v => v.toFixed(0)).join(', ')} yr, not policy-related` : a.verdict === 'unstable' ? 'a pole pair in the right half-plane: oscillation grows until the rule hits its limits' : 'all poles in the left half-plane'}</small></div>
      <div className="kpi"><span>Phase margin</span><strong>{fmt(pm?.pm_deg)} <em>°</em></strong><small>{pm ? `at a cycle of ${cyc(pm.cycle_yr)}` : 'no gain crossover'}{m.crossovers.length > 1 ? ` (${m.crossovers.length} crossovers, worst shown)` : ''}</small></div>
      <div className="kpi"><span>Gain margin</span><strong>{fmt(gm?.gm_db)} <em>dB</em></strong><small>{gm ? `at a cycle of ${cyc(gm.cycle_yr)}` : 'phase never reaches −180°'}</small></div>
      <div className="kpi"><span>Peak sensitivity Ms</span><strong>{fmt(m.ms, 2)}</strong><small>{m.ms < 2 ? 'robust (< 2)' : 'shocks near that cycle are amplified ×' + fmt(m.ms, 1)}; rule of thumb Ms &lt; 2</small></div>
    </div>

    <div className="panel">
      <div className="pick-row">
        <h3>Bode diagram</h3>
        <label className="check"><input type="checkbox" checked={show.loop} onChange={e => setShow({ ...show, loop: e.target.checked })}/>loop L</label>
        <label className="check"><input type="checkbox" checked={show.plant} onChange={e => setShow({ ...show, plant: e.target.checked })}/>plant P (rate → inflation)</label>
        <label className="check"><input type="checkbox" checked={show.ctrl} onChange={e => setShow({ ...show, ctrl: e.target.checked })}/>rule × smoothing</label>
      </div>
      <p className="muted note">From ngspice's AC analysis of the full netlist. Hover shows the cycle length. Dotted lines: where the margins are read. Inflation is 120·d ln P/dt, so the plant gain rises with frequency.</p>
      <div className="grid2">
        <Plot title="Magnitude" height={280} data={bode!.mag} layout={{ xaxis: LOGX, yaxis: { title: { text: 'dB' } }, shapes: [...bode!.marks, { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: th.ink2, width: 1 } }], annotations: bode!.notes }}/>
        <Plot title="Phase" height={280} data={bode!.ph} layout={{ xaxis: LOGX, yaxis: { title: { text: 'degrees' } }, shapes: [...bode!.marks, { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: -180, y1: -180, line: { color: th.ink2, width: 1 } }] }}/>
      </div>
    </div>

    <div className="grid2">
      <div className="panel"><Plot title="Nyquist diagram of L" height={320}
        note="The curve must keep clear of −1 (red). The grey circle around −1 has radius 1/Ms."
        data={[
          { type: 'scatter', mode: 'lines', name: 'L(jω), ω > 0', x: ny.re, y: ny.im, customdata: hover, line: { color: C.loop, width: 2 }, hovertemplate: 'cycle %{customdata}<extra></extra>' },
          { type: 'scatter', mode: 'lines', name: 'ω < 0', x: ny.re, y: ny.im.map(v => -v), line: { color: C.loop, width: 1, dash: 'dot' }, hoverinfo: 'skip' },
          { type: 'scatter', mode: 'lines', name: '1/Ms', x: circle.map(t => -1 + Math.cos(t) / m.ms), y: circle.map(t => Math.sin(t) / m.ms), line: { color: th.muted, width: 1 }, hoverinfo: 'skip', showlegend: false },
          { type: 'scatter', mode: 'markers', name: '−1', x: [-1], y: [0], marker: { color: th.critical, size: 11, symbol: 'x' }, hoverinfo: 'skip' },
        ]} layout={{ xaxis: { range: [-4, 2], title: { text: 'Re L' }, zeroline: true }, yaxis: { range: [-3, 3], title: { text: 'Im L' }, scaleanchor: 'x' } }}/></div>
      <div className="panel"><Plot title="Sensitivity" height={320}
        note="|S|: how much a shock at that cycle is damped (< 0 dB) or amplified (> 0 dB). |T|: how inflation follows the target."
        data={[
          { type: 'scatter', mode: 'lines', name: '|S|', x: a.w, y: a.S_db, customdata: hover, line: { color: C.s, width: 2.2 }, hovertemplate: '%{y:.1f} dB<extra>|S| · cycle %{customdata}</extra>' },
          { type: 'scatter', mode: 'lines', name: '|T|', x: a.w, y: a.T_db, customdata: hover, line: { color: C.t, width: 2.2 }, hovertemplate: '%{y:.1f} dB<extra>|T| · cycle %{customdata}</extra>' },
        ]} layout={{ xaxis: LOGX, yaxis: { title: { text: 'dB' } }, shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 20 * Math.log10(2), y1: 20 * Math.log10(2), line: { color: th.muted, dash: 'dot', width: 1 } }] }}/></div>
    </div>

    <div className="grid2">
      <div className="panel"><Plot title="Poles" height={320}
        note={`× closed loop, ○ plant (fitted, order ${a.fit.order}, error ${a.fit.rel_rms_pct.toFixed(2)} %). Right of the axis grows; distance from the real axis sets the cycle. Plant: ${a.unstable_open} slow unstable pole(s), the economy's growth.`}
        data={[
          { type: 'scatter', mode: 'markers', name: 'closed loop', x: cp.map(p => p.re), y: cp.map(p => p.im), customdata: cp.map(p => p.cycle_yr ? `cycle ${cyc(p.cycle_yr)}` : 'no cycle'), marker: { symbol: 'x', size: 10, color: C.loop }, hovertemplate: 'Re %{x:.3f}, Im %{y:.2f} /yr · %{customdata}<extra></extra>' },
          { type: 'scatter', mode: 'markers', name: 'plant', x: op.map(p => p.re), y: op.map(p => p.im), marker: { symbol: 'circle-open', size: 9, color: C.plant }, hovertemplate: 'Re %{x:.3f}, Im %{y:.2f} /yr<extra>plant</extra>' },
        ]} layout={{ xaxis: { title: { text: 'Re (1/yr)' }, zeroline: true, zerolinecolor: th.ink2, range: [-30, 10] }, yaxis: { title: { text: 'Im (rad/yr)' }, range: [-80, 80] },
          shapes: [{ type: 'rect', x0: 0, x1: 10, yref: 'paper', y0: 0, y1: 1, fillcolor: th.critical, opacity: 0.08, line: { width: 0 }, layer: 'below' }],
          annotations: [{ x: 5, y: 1, yref: 'paper', yanchor: 'top', text: 'unstable: grows', showarrow: false, font: { size: 11, color: th.ink2 } }] }}/></div>
      <div className="panel"><Plot title="Linear response to the target +1 point" height={320}
        note={stepUnstable ? 'Unstable: the linear response grows without bound (first 2 years shown; the simulation is held by the limits in the rule).' : 'Small-signal prediction; compare with the Simulation tab for the full nonlinear model.'}
        data={[
          { type: 'scatter', mode: 'lines', name: 'inflation (pt)', x: a.step.years, y: a.step.inflation, line: { color: C.loop, width: 2.2 } },
          { type: 'scatter', mode: 'lines', name: 'policy rate (pt)', x: a.step.years, y: a.step.rate, line: { color: C.plant, width: 2 } },
          { type: 'scatter', mode: 'lines', name: 'target', x: [0, 12], y: [1, 1], line: { color: th.ink2, width: 1.5, dash: 'dot' } },
        ]} layout={{ xaxis: { title: { text: 'years after the step' }, ...(stepUnstable ? { range: [0, 2] } : {}) }, yaxis: { title: { text: 'points' }, ...(stepUnstable ? { range: [-5, 5] } : {}) } }}/></div>
    </div>

    <div className="panel">
      <label className="pick">Rate → other variable <select value={other} onChange={e => setOther(e.target.value)}>
        {Object.entries(a.others).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select></label>
      <div className="grid2">
        <Plot title={`Magnitude: rate → ${o.label}`} height={240} data={[{ type: 'scatter', mode: 'lines', x: a.w, y: o.mag_db, customdata: hover, line: { color: C.plant, width: 2 }, hovertemplate: '%{y:.1f} dB<extra>cycle %{customdata}</extra>' }]} layout={{ xaxis: LOGX, yaxis: { title: { text: 'dB' } }, showlegend: false }}/>
        <Plot title="Phase" height={240} data={[{ type: 'scatter', mode: 'lines', x: a.w, y: o.phase_deg, customdata: hover, line: { color: C.plant, width: 2 }, hovertemplate: '%{y:.0f}°<extra>cycle %{customdata}</extra>' }]} layout={{ xaxis: LOGX, yaxis: { title: { text: 'degrees' } }, showlegend: false }}/>
      </div>
      <p className="muted note">Open-loop response to the policy rate (per unit: 1 = one point of rate gives one unit of the variable).</p>
    </div>
  </div>;
}
