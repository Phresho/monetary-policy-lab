import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Plot } from './Plot';
import { Scenario } from './types';
import { useTheme } from './viz';

// Robust control of the policy rule: H-infinity and mu for the PID (backend/monetary/robust.py).
// Weights: W_P (performance: |S| below 1/|W_P|), W_T (model error: the spread of the plant over the run, at least
// delta), W_U = 1/KS_max (control effort). For one uncertainty and one performance channel mu is exact:
// NP = max|W_P S|, RS = max|W_T T|, RP = max(|W_P S| + |W_T T|); each must stay below 1.
type Peaks = { np: number; rs: number; rp: number; ks: number; gamma: number };
interface Member { year: number; nominal: boolean; verdict: 'stable' | 'drift' | 'unstable'; max_re_per_yr: number; S_db: number[]; P_db: number[] }
interface Robust {
  t_op_years: number; gains: { kp: number; ki: number; kd: number; tau_d: number };
  weights: { M: number; wB: number; delta: number; ks_max: number };
  w: number[]; cycle_yr: number[]; S_db: number[]; T_db: number[]; KS_db: number[]; inv_WP_db: number[]; inv_WT_db: number[]; WT: number[];
  mu: { np: number[]; rs: number[]; rp: number[]; ks: number[] }; peaks: Peaks; family: Member[]; family_stable: number; family_n: number;
}
interface Tuned { method: 'hinf' | 'mu'; gains: { kp: number; ki: number; kd: number }; objective: number; after: Peaks; before: Peaks; verdict: string; free: string; approx: boolean }

const LOGX = { type: 'log', title: { text: 'frequency (rad/yr)' }, exponentformat: 'power' };
const cyc = (v: number) => v >= 1 ? `${v.toFixed(1)} yr` : v >= 1 / 12 ? `${(v * 12).toFixed(1)} months` : `${(v * 365).toFixed(0)} days`;
const f2 = (v: number) => isFinite(v) ? v.toFixed(2) : '–';

function Weight({ label, value, min, max, step, onChange, format, hint, log = false }:
  { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string; hint?: string; log?: boolean }) {
  const pos = log ? Math.log10(value) : value;
  return <label className="slider">
    <span className="slider-head">{label}<output>{format(value)}</output></span>
    <input type="range" min={log ? Math.log10(min) : min} max={log ? Math.log10(max) : max} step={step} value={pos}
      onChange={e => { const v = Number(e.target.value); onChange(log ? Number((10 ** v).toPrecision(3)) : v); }}/>
    {hint && <small>{hint}</small>}
  </label>;
}

export function RobustView({ scenario, tOp, onApply }: { scenario: Scenario; tOp: number; onApply: (g: { kp: number; ki: number; kd: number }) => void }) {
  const th = useTheme();
  const [M, setM] = useState(2);
  const [wB, setWB] = useState(2);
  const [delta, setDelta] = useState(0.1);
  const [ksMax, setKsMax] = useState(2);
  const [r, setR] = useState<Robust>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [method, setMethod] = useState<'hinf' | 'mu'>('mu');
  const [free, setFree] = useState<'ki_kd' | 'all'>('ki_kd');
  const [tuned, setTuned] = useState<Tuned>();
  const [tuning, setTuning] = useState(false);
  const seq = useRef(0);
  const weights = { M, wB, delta, ks_max: ksMax };
  const key = JSON.stringify({ scenario: { ...scenario, name: '' }, tOp, weights });

  useEffect(() => {   // re-evaluate 300 ms after the last change; only the latest answer is shown
    const id = ++seq.current;
    const timer = window.setTimeout(() => {
      setBusy(true);
      api<Robust>('/robust', { scenario, t_op_years: tOp, ...weights })
        .then(x => { if (id === seq.current) { setR(x); setError(''); } })
        .catch(e => { if (id === seq.current) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (id === seq.current) setBusy(false); });
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => setTuned(undefined), [key, method, free]);

  async function tune() {
    setTuning(true); setError('');
    try { setTuned(await api<Tuned>('/robust/tune', { scenario, t_op_years: tOp, ...weights, method, free })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setTuning(false); }
  }

  const hover = useMemo(() => r?.cycle_yr.map(cyc), [r]);
  if (!r) return <div className="panel empty">{error ? <p className="notice bad">{error}</p>
    : <p className="muted">{busy ? 'Linearising the plant at years 0, 2, …, 12 of the run (first time about 15 s)…' : 'No analysis yet.'}</p>}</div>;

  const line = (name: string, y: number[], color: string, extra: Record<string, unknown> = {}) => ({
    type: 'scatter', mode: 'lines', name, x: r.w, y, customdata: hover, line: { color, width: 2.2 }, hovertemplate: `%{y:.2f}<extra>${name} · cycle %{customdata}</extra>`, ...extra });
  const bound = (name: string, y: number[]) => line(name, y, th.ink2, { line: { color: th.ink2, width: 1.5, dash: 'dot' } });
  const famS = r.family.filter(m => !m.nominal).map((m, i) => ({ type: 'scatter', mode: 'lines', name: i === 0 ? 'plant at other years' : `year ${m.year}`, legendgroup: 'fam', showlegend: i === 0,
    x: r.w, y: m.S_db, line: { color: th.muted, width: 1 }, opacity: 0.7, hovertemplate: `%{y:.1f} dB<extra>|S|, plant at year ${m.year}</extra>` }));
  const famP = r.family.map(m => ({ type: 'scatter', mode: 'lines', name: m.nominal ? `nominal (year ${m.year})` : `year ${m.year}`,
    x: r.w, y: m.P_db, line: m.nominal ? { color: th.rate, width: 2.4 } : { color: th.muted, width: 1 }, customdata: hover, hovertemplate: `%{y:.1f} dB<extra>year ${m.year} · cycle %{customdata}</extra>` }));
  const one = { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 1, y1: 1, line: { color: th.critical, width: 1.2, dash: 'dash' } };
  const p = r.peaks;
  const tile = (label: string, v: number, ok: string, bad: string, what: string) => <div className={`kpi verdict ${v < 1 ? 'good' : 'bad'}`}>
    <span>{label}</span><strong>{v < 1 ? '✓' : '✕'} {f2(v)}</strong><small>{v < 1 ? ok : bad} · {what}</small></div>;
  const g = r.gains;

  return <div className={busy ? 'busy' : ''}>
    {error && <p className="notice bad">{error}</p>}
    <div className="panel">
      <h3>Robust control: H∞ and μ for the PID rule</h3>
      <p className="muted note">The uncertainty is the economy itself: the plant (rate → inflation) linearised at years 0, 2, …, 12 of this scenario's rate path. It mainly loses gain as the economy grows (30–66 % at most frequencies). That spread, and at least the extra model error δ, is the multiplicative model error W<sub>T</sub>. The rule has to be stable and perform for every plant in that set.
        With one scalar uncertainty μ is exact: nominal performance max|W<sub>P</sub>S|, robust stability max|W<sub>T</sub>T|, robust performance max(|W<sub>P</sub>S| + |W<sub>T</sub>T|). Each must stay below 1. Current rule: Kp {g.kp}, Ki {g.ki}, Kd {g.kd} (τ<sub>d</sub> {g.tau_d}). Linearised at {tOp === 0 ? 'the steady state' : `year ${tOp}`} (Frequency analysis tab).</p>
      <div className="grid2 tight">
        <Weight label="Peak of |S| allowed (M)" value={M} min={1.1} max={4} step={0.05} onChange={setM} format={v => v.toFixed(2)} hint="W_P → 1/M at short cycles: shocks there are amplified at most M times"/>
        <Weight label="Performance bandwidth ω_B" value={wB} min={0.1} max={30} step={0.02} log onChange={setWB} format={v => `${v} rad/yr`} hint={`|S| < 1 for cycles longer than about ${cyc(2 * Math.PI / wB)}`}/>
        <Weight label="Extra model error δ" value={delta} min={0} max={1} step={0.01} onChange={setDelta} format={v => `${(v * 100).toFixed(0)} %`} hint="W_T is at least δ at every frequency, on top of the spread over the years"/>
        <Weight label="Largest |K·S| (rate effort)" value={ksMax} min={0.2} max={20} step={0.02} log onChange={setKsMax} format={v => v.toFixed(2)} hint="how far the rate moves per unit of inflation noise"/>
      </div>
    </div>

    <div className="kpis">
      {tile('Nominal performance', p.np, 'met', 'not met', 'max |W_P S|')}
      {tile('Robust stability μ_RS', p.rs, 'every plant in the set stays stable', 'not guaranteed', 'max |W_T T|')}
      {tile('Robust performance μ_RP', p.rp, 'met for every plant in the set', 'not met for the worst plant', 'max(|W_P S| + |W_T T|)')}
      <div className="kpi"><span>H∞ norm γ</span><strong>{f2(p.gamma)}</strong><small>‖[W_P S; W_T T; W_U KS]‖∞ · effort max |W_U KS| {f2(p.ks)}</small></div>
      <div className={`kpi verdict ${r.family_stable === r.family_n ? 'good' : 'bad'}`}><span>Plant set, closed loop</span>
        <strong>{r.family_stable === r.family_n ? '✓' : '✕'} {r.family_stable} of {r.family_n} stable</strong>
        <small>fitted plants at years {r.family.map(m => m.year).join(', ')}{r.family.some(m => m.verdict === 'drift') ? ' · slow drift of the economy allowed' : ''}</small></div>
    </div>

    <div className="panel">
      <div className="pick-row">
        <h3>Design the PID</h3>
        <div className="segmented small-seg" role="group" aria-label="Method">
          <button className={method === 'hinf' ? 'active' : ''} onClick={() => setMethod('hinf')}>H∞: minimise γ</button>
          <button className={method === 'mu' ? 'active' : ''} onClick={() => setMethod('mu')}>μ: minimise μ_RP</button>
        </div>
        <div className="segmented small-seg" role="group" aria-label="Gains to tune">
          <button className={free === 'ki_kd' ? 'active' : ''} onClick={() => setFree('ki_kd')}>Ki and Kd</button>
          <button className={free === 'all' ? 'active' : ''} onClick={() => setFree('all')}>Kp, Ki and Kd (Kp ≤ 0.15)</button>
        </div>
        <button className="primary" onClick={() => void tune()} disabled={tuning || busy}>{tuning ? 'Tuning…' : 'Tune'}</button>
      </div>
      <p className="muted note">A fixed-structure design: the three gains of the rule (not a full-order H∞ controller), found by Nelder–Mead from several starts. The closed loop with the fitted plant must stay stable. That is a local optimum. Kp also sets the steady state the plant is linearised at, so by default only Ki and Kd move. Above Kp ≈ 0.3 the economy has no steady state near its starting inflation.</p>
      {tuned && <>
        <div className="table-wrap"><table className="data">
          <thead><tr><th className="left">rule</th><th>Kp</th><th>Ki</th><th>Kd</th><th>|W_P S|</th><th>μ_RS</th><th>μ_RP</th><th>γ</th><th>|W_U KS|</th></tr></thead>
          <tbody>
            <tr><td className="left">now</td><td>{g.kp}</td><td>{g.ki}</td><td>{g.kd}</td><td>{f2(tuned.before.np)}</td><td>{f2(tuned.before.rs)}</td><td>{f2(tuned.before.rp)}</td><td>{f2(tuned.before.gamma)}</td><td>{f2(tuned.before.ks)}</td></tr>
            <tr><td className="left"><b>{tuned.method === 'hinf' ? 'H∞' : 'μ'} design</b></td><td>{tuned.gains.kp}</td><td>{tuned.gains.ki}</td><td>{tuned.gains.kd}</td><td>{f2(tuned.after.np)}</td><td>{f2(tuned.after.rs)}</td><td><b>{f2(tuned.after.rp)}</b></td><td>{f2(tuned.after.gamma)}</td><td>{f2(tuned.after.ks)}</td></tr>
          </tbody>
        </table></div>
        <p className="small">{tuned.after.rp < 1 ? '✓ Robust performance met for every plant in the set.' : `✕ μ_RP ${f2(tuned.after.rp)}: with these weights no PID of this form meets robust performance; relax M, ω_B or δ.`}
          {tuned.approx ? ' Kp changed: the plant was linearised at the old Kp, so the numbers after applying are recomputed at the new one.' : ''} Closed loop of the nominal plant: {tuned.verdict}.</p>
        <button className="ghost" onClick={() => onApply(tuned.gains)}>Apply these gains (closed loop)</button>
      </>}
    </div>

    <div className="grid2">
      <div className="panel"><Plot title="Sensitivity |S| and its bound 1/|W_P|" height={300}
        note="Below the dotted bound: nominal performance. Grey: |S| with the plant of the other years (the same rule)."
        data={[...famS, line('|S| nominal', r.S_db, th.rate), bound('1/|W_P|', r.inv_WP_db)]}
        layout={{ xaxis: LOGX, yaxis: { title: { text: 'dB' } } }}/></div>
      <div className="panel"><Plot title="Complementary sensitivity |T| and 1/|W_T|" height={300}
        note="Below the dotted bound: robustly stable against the model error W_T (the plant's spread over the years, at least δ)."
        data={[line('|T|', r.T_db, th.inflation), bound('1/|W_T|', r.inv_WT_db)]}
        layout={{ xaxis: LOGX, yaxis: { title: { text: 'dB' } } }}/></div>
      <div className="panel"><Plot title="μ over frequency" height={300}
        note="Robust performance needs the sum below 1 (red dashed) at every frequency; the peaks are the tiles above."
        data={[line('|W_P S| (performance)', r.mu.np, th.rate), line('|W_T T| = μ_RS', r.mu.rs, th.inflation), line('μ_RP = |W_P S| + |W_T T|', r.mu.rp, th.real, { line: { color: th.real, width: 2.6 } })]}
        layout={{ xaxis: LOGX, yaxis: { title: { text: 'weighted gain' }, rangemode: 'tozero' }, shapes: [one] }}/></div>
      <div className="panel"><Plot title="Control effort |W_U K S|" height={300}
        note="Rate movement per unit of inflation noise, divided by the limit: it must stay below 1."
        data={[line('|K S| / KS_max', r.mu.ks, th.rate)]}
        layout={{ xaxis: LOGX, yaxis: { title: { text: 'weighted gain' }, rangemode: 'tozero' }, shapes: [one] }}/></div>
    </div>
    <div className="panel"><Plot title="The plant set: rate → inflation at years 0–12" height={300}
      note="The source of W_T. As the economy grows the plant mostly loses gain; the shape changes little."
      data={famP} layout={{ xaxis: LOGX, yaxis: { title: { text: 'dB' } } }}/></div>
  </div>;
}
