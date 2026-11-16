import { useEffect, useMemo, useRef, useState } from 'react';
import { Analysis, AnalysisResult } from './Analysis';
import { ModelMap } from './ModelMap';
import { FlowsView } from './FlowsView';
import { RunLibrary, SimView } from './SimView';
import { api } from './api';
import { Marker } from './Chart';
import { autoLabel, Catalogue, Run, SavedRun, Scenario } from './types';
import { applyThemeChoice, storedThemeChoice, ThemeChoice } from './viz';

const MAX_RUNS = 8;

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
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [activeId, setActiveId] = useState(0);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const nextId = useRef(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [extra, setExtra] = useState('I(Exchange_rate)');
  const [tab, setTab] = useState<'sim' | 'freq' | 'flows' | 'map'>('map');  // the circuit map is the start page
  const [an, setAn] = useState<AnalysisResult>();
  const [anBusy, setAnBusy] = useState(false);
  const [tOp, setTOp] = useState(0);
  const anSeq = useRef(0);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(storedThemeChoice);
  useEffect(() => applyThemeChoice(themeChoice), [themeChoice]);

  // Frequency tab: re-analyse 300 ms after the last change (the plant is cached, so gain changes are instant;
  // a new Kp, R* or year needs a new linearisation, 15-40 s). Only the latest request is shown.
  useEffect(() => {
    if (tab !== 'freq' || !s) return;
    const id = ++anSeq.current;
    const timer = window.setTimeout(async () => {
      setAnBusy(true);
      try {
        const r = await api<AnalysisResult>('/analysis', { scenario: s, t_op_years: tOp });
        if (id === anSeq.current) { setAn(r); setError(''); }
      } catch (e) { if (id === anSeq.current) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (id === anSeq.current) setAnBusy(false); }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [tab, s, tOp]);

  useEffect(() => { api<Catalogue>('/catalogue').then(c => { setCat(c); setS(c.defaults); }).catch(e => setError(String(e.message ?? e))); }, []);
  const upy = cat?.time.units_per_year ?? 120;
  const set = (patch: Partial<Scenario>) => setS(old => old && { ...old, ...patch });

  const run = runs.find(r => r.id === activeId);
  const compared = useMemo(() => runs.filter(r => r.id !== activeId && compareIds.includes(r.id)), [runs, activeId, compareIds]);

  // A new run becomes the active one; the run that was active is ticked for comparison (as the old "previous run").
  async function simulate(next = s) {
    if (!next) return;
    setBusy(true); setError('');
    try {
      const r = await api<Run>('/runs', next);
      const id = nextId.current++;
      setRuns(old => {
        let all = [...old, { ...r, id, label: autoLabel(id, r.scenario) }];
        while (all.length > MAX_RUNS) all = all.filter(x => x !== all.find(y => y.id !== id && y.id !== activeId) );
        return all;
      });
      setCompareIds(activeId ? [activeId] : []);
      setActiveId(id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (s && !runs.length && !busy) void simulate(s); }, [s]);  // first run with the defaults

  const markers = useMemo<Marker[]>(() => {
    const sc = run?.scenario; if (!sc) return [];
    return sc.closed ? [{ x: sc.t_start / upy, label: ' rule fully on' }] : [{ x: sc.step_time / upy, label: ` rate step ${sc.step_pct >= 0 ? '+' : ''}${sc.step_pct}` }];
  }, [run, upy]);

  if (!cat || !s) return <div className="startup">{error ? <p className="notice bad">{error}</p> : <p className="muted">Loading…</p>}</div>;
  const nl = cat.netlist;
  return <>
    <header className="topbar">
      <div className="brand"><span className="mark">%</span>Monetary Policy Lab</div>
      <div className="top-actions">
        <span className={`mode ${s.closed ? 'closed' : 'open'}`}>{s.closed ? 'Closed loop: policy rule sets the rate' : 'Open loop: rate path given'}</span>
        <span className="muted small">solver: {cat.solver ?? 'not available'}</span>
        <label className="theme-pick small">Theme <select value={themeChoice} onChange={e => setThemeChoice(e.target.value as ThemeChoice)}>
          <option value="auto">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select></label>
      </div>
    </header>
    <div className="layout">
      <aside className="panel controls">
        <div className="segmented" role="group" aria-label="Loop">
          <button className={!s.closed ? 'active' : ''} onClick={() => set({ closed: false })}>Open loop</button>
          <button className={s.closed ? 'active' : ''} onClick={() => set({ closed: true })}>Closed loop</button>
        </div>
        {s.closed || tab === 'freq' ? <>
          {tab === 'freq' && !s.closed && <p className="muted note">Analysis designs the rule; the open-loop setting only sets where the economy is linearised (the base rate below the plots).</p>}
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
        {tab === 'map' && <p className="muted note">The map shows the active run: sparklines on the blocks, traces of the elements. The first run starts by itself.</p>}
        {tab === 'flows' ? <p className="muted note">The flows are those of the active run (Simulation tab).</p> : tab === 'sim' || tab === 'map' ? <button className="primary" onClick={() => void simulate()} disabled={busy}>{busy ? 'Simulating… (10–15 s)' : 'Run simulation'}</button>
          : <p className="muted note">The analysis updates by itself when you move a slider. Then try the gains in the Simulation tab.</p>}
        <p className="muted note">Time axis: 120 model time units = 1 year (assumed from the /120 in the interest flows).</p>
      </aside>
      <main className="results">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'map'} className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>Circuit map</button>
          <button role="tab" aria-selected={tab === 'sim'} className={tab === 'sim' ? 'active' : ''} onClick={() => setTab('sim')}>Simulation</button>
          <button role="tab" aria-selected={tab === 'freq'} className={tab === 'freq' ? 'active' : ''} onClick={() => setTab('freq')}>Frequency analysis</button>
          <button role="tab" aria-selected={tab === 'flows'} className={tab === 'flows' ? 'active' : ''} onClick={() => setTab('flows')}>Sector flows</button>
        </div>
        {error && <p className="notice bad">{error}</p>}
        {tab === 'map' ? <ModelMap scenario={run?.scenario ?? s} closed={run?.scenario.closed ?? s.closed} run={run}/>
          : tab === 'flows' ? (run ? <FlowsView scenario={run.scenario}/> : <div className="panel empty"><p className="muted">Run a simulation first.</p></div>)
          : tab === 'freq' ? <Analysis a={an} busy={anBusy} tOp={tOp} setTOp={setTOp} closedMode={s.closed} scenario={s} onPick={(ki, kd) => set({ ki, kd, closed: true })}/>
          : !run ? <div className="panel empty"><p className="muted">{busy ? 'Running the first simulation…' : 'No run yet.'}</p></div> : <>
          <SimView cat={cat} run={run} compared={compared} markers={markers} extra={extra} setExtra={setExtra}/>
          <RunLibrary runs={runs} activeId={activeId} compareIds={compareIds}
            setActive={id => { setActiveId(id); setCompareIds(c => c.filter(x => x !== id)); const r = runs.find(x => x.id === id); if (r) setS(r.scenario); }}
            toggleCompare={id => setCompareIds(c => c.includes(id) ? c.filter(x => x !== id) : [...c, id])}
            rename={(id, label) => setRuns(rs => rs.map(r => r.id === id ? { ...r, label } : r))}
            remove={id => { setRuns(rs => rs.filter(r => r.id !== id)); setCompareIds(c => c.filter(x => x !== id)); if (id === activeId) { const rest = runs.filter(r => r.id !== id); setActiveId(rest[rest.length - 1]?.id ?? 0); } }}/>
        </>}
      </main>
    </div>
  </>;
}
