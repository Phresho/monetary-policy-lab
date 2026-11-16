import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Chart, Line, Marker } from './Chart';

interface Scenario {
  name: string; closed: boolean; steady_start: boolean;
  kp: number; ki: number; kd: number; derivative: 'filtered' | 'netlist'; tau_d: number;
  r_star: number; target_pct: number; t_start: number;
  rate_pct: number; step_pct: number; step_time: number;
}
interface Series { label: string; unit: string; values: number[] }
interface Run {
  scenario: Scenario; years: number[]; series: Record<string, Series>; seconds: number;
  metrics: { inflation_rmse_pts: number; inflation_max_dev_pts: number; inflation_end_pct: number; rate_min_pct: number; rate_max_pct: number; gdp_growth_pct_per_year: number };
}
interface Catalogue { defaults: Scenario; netlist: Record<string, number>; series: { key: string; label: string; unit: string }[]; time: { units_per_year: number; t_stop: number }; solver: string | null }

const C = { now: '#1f6fc4', prev: '#8a9692', target: '#3f9a1f', rule: '#b8741a' };

function Slider({ label, value, min, max, step, onChange, hint, format = v => v.toFixed(2) }:
  { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; hint?: string; format?: (v: number) => string }) {
  return <label className="slider">
    <span className="slider-head">{label}<output>{format(value)}</output></span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}/>
    {hint && <small>{hint}</small>}
  </label>;
}

export default function App() {
  const [cat, setCat] = useState<Catalogue>();
  const [s, setS] = useState<Scenario>();
  const [run, setRun] = useState<Run>();
  const [prev, setPrev] = useState<Run>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [extra, setExtra] = useState('I(Exchange_rate)');
  const [showPrev, setShowPrev] = useState(true);

  useEffect(() => { api<Catalogue>('/catalogue').then(c => { setCat(c); setS(c.defaults); }).catch(e => setError(String(e.message ?? e))); }, []);
  const upy = cat?.time.units_per_year ?? 120;
  const set = (patch: Partial<Scenario>) => setS(old => old && { ...old, ...patch });

  async function simulate(next = s) {
    if (!next) return;
    setBusy(true); setError('');
    try {
      const r = await api<Run>('/runs', next);
      setPrev(run); setRun(r);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (s && !run && !busy) void simulate(s); }, [s]);  // first run with the defaults

  const markers = useMemo<Marker[]>(() => {
    const sc = run?.scenario; if (!sc) return [];
    return sc.closed ? [{ x: sc.t_start / upy, label: ' rule fully on' }] : [{ x: sc.step_time / upy, label: ` rate step ${sc.step_pct >= 0 ? '+' : ''}${sc.step_pct}` }];
  }, [run, upy]);

  function lines(key: string, color = C.now, extraLines: Line[] = []): Line[] {
    if (!run) return [];
    const out: Line[] = [{ name: run.series[key].label + (prev && showPrev ? ' (this run)' : ''), x: run.years, y: run.series[key].values, color }];
    if (prev && showPrev && prev.series[key]) out.push({ name: 'previous run', x: prev.years, y: prev.series[key].values, color: C.prev, dash: 'dash', width: 1.6 });
    return [...out, ...extraLines];
  }

  if (!cat || !s) return <div className="startup">{error ? <p className="notice bad">{error}</p> : <p className="muted">Loading…</p>}</div>;
  const m = run?.metrics;
  const nl = cat.netlist;
  return <>
    <header className="topbar">
      <div className="brand"><span className="mark">%</span>Monetary Policy Lab</div>
      <div className="top-actions">
        <span className={`mode ${s.closed ? 'closed' : 'open'}`}>{s.closed ? 'Closed loop: policy rule sets the rate' : 'Open loop: rate path given'}</span>
        <span className="muted small">solver: {cat.solver ?? 'not available'}</span>
      </div>
    </header>
    <div className="layout">
      <aside className="panel controls">
        <div className="segmented" role="group" aria-label="Loop">
          <button className={!s.closed ? 'active' : ''} onClick={() => set({ closed: false })}>Open loop</button>
          <button className={s.closed ? 'active' : ''} onClick={() => set({ closed: true })}>Closed loop</button>
        </div>
        {s.closed ? <>
          <h2>Policy rule</h2>
          <p className="muted note">R = R* + Kp·(π − π*) + Ki·∫(π − π*) + Kd·filtered dπ/dt, smoothed by R15·C8 (207 units). Integral and derivative act from the start time.</p>
          <Slider label="Kp (proportional)" value={s.kp} min={0} max={2} step={0.01} onChange={v => set({ kp: v })} hint={`netlist ${nl.kp}`}/>
          <Slider label="Ki (integral)" value={s.ki} min={0} max={2} step={0.01} onChange={v => set({ ki: v })} hint={`netlist ${nl.ki}`}/>
          <Slider label="Kd (derivative)" value={s.kd} min={0} max={10} step={0.05} onChange={v => set({ kd: v })} hint={`netlist ${nl.kd}`}/>
          <Slider label="Derivative filter" value={s.tau_d} min={0.1} max={30} step={0.1} onChange={v => set({ tau_d: v })} format={v => `${v.toFixed(1)} units`} hint="Kd·s/(1 + s·τd); a raw derivative stalls the solver"/>
          <Slider label="Neutral rate R*" value={s.r_star} min={-1} max={6} step={0.05} onChange={v => set({ r_star: v })} format={v => `${v.toFixed(2)} %`}/>
          <Slider label="Inflation target π*" value={s.target_pct} min={0} max={5} step={0.1} onChange={v => set({ target_pct: v })} format={v => `${v.toFixed(1)} %`}/>
          <Slider label="Integral and derivative start" value={s.t_start} min={0} max={600} step={12} onChange={v => set({ t_start: v })} format={v => `${(v / upy).toFixed(1)} yr`}/>
        </> : <>
          <h2>Interest-rate path</h2>
          <p className="muted note">The policy rate is given: a base rate, then a step. The rule's output is still computed, so you can see what it would have asked for.</p>
          <Slider label="Base rate" value={s.rate_pct} min={-1} max={8} step={0.05} onChange={v => set({ rate_pct: v })} format={v => `${v.toFixed(2)} %`}/>
          <Slider label="Step size" value={s.step_pct} min={-3} max={3} step={0.05} onChange={v => set({ step_pct: v })} format={v => `${v >= 0 ? '+' : ''}${v.toFixed(2)} pt`}/>
          <Slider label="Step at" value={s.step_time} min={0} max={cat.time.t_stop} step={12} onChange={v => set({ step_time: v })} format={v => `${(v / upy).toFixed(1)} yr`}/>
        </>}
        <label className="check"><input type="checkbox" checked={s.steady_start} onChange={e => set({ steady_start: e.target.checked })}/>Start in steady state</label>
        {!s.steady_start && <p className="notice warn">The netlist's own start: P jumps 0.13 → 0.27 and inflation spikes to ~26 000 % in the first months.</p>}
        <button className="primary" onClick={() => void simulate()} disabled={busy}>{busy ? 'Simulating… (10–15 s)' : 'Run simulation'}</button>
        <p className="muted note">Time axis: 120 model time units = 1 year (assumed from the /120 in the interest flows).</p>
      </aside>
      <main className="results">
        {error && <p className="notice bad">{error}</p>}
        {!run ? <div className="panel empty"><p className="muted">{busy ? 'Running the first simulation…' : 'No run yet.'}</p></div> : <>
          <div className="kpis">
            <div className="kpi"><span>Inflation vs target (RMS)</span><strong>{m!.inflation_rmse_pts.toFixed(2)} <em>pt</em></strong><small>largest deviation {m!.inflation_max_dev_pts.toFixed(1)} pt{run.scenario.closed ? ', after the rule is fully on' : ''}</small></div>
            <div className="kpi"><span>Inflation at the end</span><strong>{m!.inflation_end_pct.toFixed(2)} <em>%</em></strong><small>target {run.scenario.target_pct} %</small></div>
            <div className="kpi"><span>Policy rate range</span><strong>{m!.rate_min_pct.toFixed(2)}–{m!.rate_max_pct.toFixed(2)} <em>%</em></strong></div>
            <div className="kpi"><span>Real GDP growth</span><strong>{m!.gdp_growth_pct_per_year.toFixed(2)} <em>%/yr</em></strong><small>run took {run.seconds} s</small></div>
          </div>
          {prev && <label className="check compare"><input type="checkbox" checked={showPrev} onChange={e => setShowPrev(e.target.checked)}/>Show previous run (dashed)</label>}
          <div className="panel"><Chart title="Inflation" unit="%" markers={markers} lines={lines('I(CPI_filtered)', C.now, [{ name: 'target', x: run.years, y: run.series['I(Target_CPI)'].values, color: C.target, dash: 'dot', width: 1.6 }])}/></div>
          <div className="grid2">
            <div className="panel"><Chart title="Policy rate" unit="%" markers={markers} lines={lines('I(R)', C.now, run.scenario.closed ? [] : [{ name: 'rule would ask', x: run.years, y: run.series['V(n_pi)'].values, color: C.rule, dash: 'dot', width: 1.4 }])}/></div>
            <div className="panel"><Chart title="Real GDP" unit="per time unit" markers={markers} lines={lines('I(GDP_real)')}/></div>
          </div>
          <div className="panel">
            <label className="pick">More signals <select value={extra} onChange={e => setExtra(e.target.value)}>
              {cat.series.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select></label>
            <Chart title={run.series[extra].label} unit={run.series[extra].unit} markers={markers} lines={lines(extra)}/>
          </div>
        </>}
      </main>
    </div>
  </>;
}
