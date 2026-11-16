import { useState } from 'react';
import { Chart, Line, Marker } from './Chart';
import { Catalogue, SavedRun } from './types';
import { RATE_KEYS, seriesColor, Theme, useTheme, withAlpha } from './viz';

// The Simulation tab: headline numbers, the inflation gap, the rates, the transmission chain, the balance sheets,
// any other signal, and the run library. The active run is in colour; compared runs are grey (emphasis form).

const CHAIN: { key: string; step: string }[] = [
  { key: 'I(R)', step: 'Central bank sets the policy rate' },
  { key: 'I(R_retail)', step: 'Banks pass it on to the loan rate' },
  { key: 'I(B_loanbal)', step: 'Borrowing responds' },
  { key: 'I(Investment)', step: 'Investment responds' },
  { key: 'I(GDP_real)', step: 'Output follows' },
  { key: 'I(CPI_filtered)', step: 'Inflation, fed back to the rule' },
];
const BALANCE = ['I(B_NW)', 'I(B_loanbal)', 'I(Government_Debt)', 'I(Leverage)'];

function Spark({ y, color }: { y: number[]; color: string }) {
  const n = y.length, k = Math.max(1, Math.floor(n / 120));
  const pts = y.filter((_, i) => i % k === 0);
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * 100},${28 - ((v - lo) / span) * 26}`).join(' ');
  return <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke"/></svg>;
}

function Delta({ now, ref: base, unit, label, digits = 2 }: { now: number; ref?: number; unit: string; label?: string; digits?: number }) {
  if (base == null || label == null) return null;
  const d = now - base;
  if (Math.abs(d) < 0.5 * 10 ** -digits) return <small className="delta">= same as {label}</small>;
  return <small className="delta">{d > 0 ? '▲' : '▼'} {Math.abs(d).toFixed(digits)} {unit} vs {label}</small>;
}

export function SimView({ cat, run, compared, markers, extra, setExtra }:
  { cat: Catalogue; run: SavedRun; compared: SavedRun[]; markers: Marker[]; extra: string; setExtra: (k: string) => void }) {
  const t = useTheme();
  const [indexed, setIndexed] = useState(false);
  const m = run.metrics, ref = compared[0], rm = ref?.metrics, refName = ref?.label;
  const target = run.series['I(Target_CPI)'].values;

  // the active run in its quantity's colour, compared runs grey dashed and named
  function lines(key: string, extraLines: Line[] = [], tf: (y: number[]) => number[] = y => y, color = seriesColor(t, key)): Line[] {
    const out: Line[] = [{ name: run.series[key].label + (compared.length ? ` (${run.label})` : ''), tag: compared.length ? run.label : run.series[key].label, x: run.years, y: tf(run.series[key].values), color }];
    compared.forEach(c => c.series[key] && out.push({ name: c.label, x: c.years, y: tf(c.series[key].values), color: t.muted, dash: 'dash', width: 1.3 }));
    return [...out, ...extraLines];
  }
  const isPct = (key: string) => run.series[key].unit === '%';
  const toIndex = (y: number[]) => y.map(v => 100 * v / (y[0] || 1));
  const toChange = (y: number[]) => y.map(v => v - y[0]);
  const tf = (key: string) => !indexed ? undefined : isPct(key) ? toChange : toIndex;
  const unitOf = (key: string) => !indexed ? run.series[key].unit : isPct(key) ? 'pt since start' : 'index, start = 100';

  const gap = run.series['I(CPI_filtered)'].values.map((v, i) => v - target[i]);
  const gapLines: Line[] = [
    { name: 'above target', x: run.years, y: gap.map(v => Math.max(v, 0)), color: t.above, width: 1, fill: 'tozeroy', fillcolor: withAlpha(t.above, 0.35) },
    { name: 'below target', x: run.years, y: gap.map(v => Math.min(v, 0)), color: t.below, width: 1, fill: 'tozeroy', fillcolor: withAlpha(t.below, 0.35) },
    ...compared.map(c => ({ name: c.label, x: c.years, y: c.series['I(CPI_filtered)'].values.map((v, i) => v - c.series['I(Target_CPI)'].values[i]), color: t.muted, dash: 'dash', width: 1.3 })),
  ];
  const tolerance = [{ type: 'rect', xref: 'paper', x0: 0, x1: 1, y0: -1, y1: 1, fillcolor: t.band, line: { width: 0 }, layer: 'below' }];

  const rateLines: Line[] = RATE_KEYS.map((k, i) => ({ name: run.series[k].label, x: run.years, y: run.series[k].values, color: t.rates[i] }));
  if (!run.scenario.closed) rateLines.push({ name: 'rule would ask', x: run.years, y: run.series['V(n_pi)'].values, color: t.ink2, dash: 'dot', width: 1.5 });
  compared.forEach(c => rateLines.push({ name: `policy rate, ${c.label}`, x: c.years, y: c.series['I(R)'].values, color: t.muted, dash: 'dash', width: 1.3 }));

  // when comparing sizes, one y-range for all level panels (index) and one for all rate panels (change in points)
  function sharedRange(keys: string[], pct: boolean) {
    if (!indexed) return undefined;
    const ys = keys.filter(k => isPct(k) === pct).flatMap(k => [run, ...compared].flatMap(r => (pct ? toChange : toIndex)(r.series[k].values)));
    if (!ys.length) return undefined;
    const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.05 || 1;
    return [lo - pad, hi + pad];
  }
  const chainKeys = CHAIN.map(c => c.key);
  // rates share one scale; inflation keeps its own (its swings would flatten the rates)
  const chainRange = { level: sharedRange(chainKeys, false), pct: sharedRange(chainKeys.filter(k => RATE_KEYS.includes(k)), true) };
  const balRange = sharedRange(BALANCE.slice(0, 3), false);
  const phi = cat.phi_target;

  return <>
    <div className="kpis">
      <Kpi t={t} label="Inflation vs target (RMS)" value={m.inflation_rmse_pts.toFixed(2)} unit="pt" spark={gap.map(Math.abs)} color={t.inflation}
        sub={`largest deviation ${m.inflation_max_dev_pts.toFixed(1)} pt${run.scenario.closed ? ', after the rule is fully on' : ''}`}
        delta={<Delta now={m.inflation_rmse_pts} ref={rm?.inflation_rmse_pts} unit="pt" label={refName}/>}/>
      <Kpi t={t} label="Inflation at the end" value={m.inflation_end_pct.toFixed(2)} unit="%" spark={run.series['I(CPI_filtered)'].values} color={t.inflation}
        sub={`target ${run.scenario.target_pct} %`} delta={<Delta now={m.inflation_end_pct} ref={rm?.inflation_end_pct} unit="pt" label={refName}/>}/>
      <Kpi t={t} label="Policy rate range" value={`${m.rate_min_pct.toFixed(2)}–${m.rate_max_pct.toFixed(2)}`} unit="%" spark={run.series['I(R)'].values} color={t.rate}
        delta={<Delta now={m.rate_max_pct - m.rate_min_pct} ref={rm && rm.rate_max_pct - rm.rate_min_pct} unit="pt width" label={refName}/>}/>
      <Kpi t={t} label="Real GDP growth" value={m.gdp_growth_pct_per_year.toFixed(2)} unit="%/yr" spark={run.series['I(GDP_real)'].values} color={t.real}
        sub={`run took ${run.seconds} s`} delta={<Delta now={m.gdp_growth_pct_per_year} ref={rm?.gdp_growth_pct_per_year} unit="pt" label={refName}/>}/>
    </div>

    <div className="panel">
      <Chart title="Inflation gap: inflation − target" unit="points" markers={markers} lines={gapLines} shapes={tolerance} hoverFormat=".2f"
        note="Red: above target, blue: below. The grey band is ±1 point around the target."/>
    </div>
    <div className="grid2">
      <div className="panel"><Chart title="Inflation" unit="%" markers={markers} lines={lines('I(CPI_filtered)', [{ name: 'target', x: run.years, y: target, color: t.ink2, dash: 'dot', width: 1.5 }])}/></div>
      <div className="panel"><Chart title="Interest rates along the chain" unit="%" markers={markers} lines={rateLines} hoverFormat=".2f"
        note="Policy → wholesale → retail loan rate → long-term yield: one orange, darker further from the central bank."/></div>
    </div>

    <div className="panel">
      <div className="pick-row">
        <h3>Transmission: from the policy rate to inflation</h3>
        <label className="check"><input type="checkbox" checked={indexed} onChange={e => setIndexed(e.target.checked)}/>Compare sizes (levels as index, start = 100; rates as change in points; one scale)</label>
      </div>
      <div className="chain">
        {CHAIN.map((c, i) => <div key={c.key} className="chain-step">
          <span className="chain-no">{i + 1}</span>
          <Chart compact height={150} title={`${run.series[c.key].label}`} unit={unitOf(c.key)} markers={markers} lines={lines(c.key, [], tf(c.key))}
            note={c.step} yRange={!isPct(c.key) ? chainRange.level : RATE_KEYS.includes(c.key) ? chainRange.pct : undefined}/>
        </div>)}
      </div>
    </div>

    <div className="panel">
      <h3>Balance sheets: banks and government</h3>
      <p className="muted note">Stocks of the model. With "Compare sizes" on, they share one index scale. Leverage has its target Φ{phi != null ? ` = ${phi}` : ''} as a reference line.</p>
      <div className="grid2 tight">
        {BALANCE.map(k => <Chart key={k} compact height={170} title={run.series[k].label} unit={k === 'I(Leverage)' ? 'ratio' : unitOf(k)} markers={markers}
          yRange={k === 'I(Leverage)' ? undefined : balRange}
          lines={lines(k, k === 'I(Leverage)' && phi != null ? [{ name: `target Φ = ${phi}`, x: run.years, y: run.years.map(() => phi), color: t.ink2, dash: 'dot', width: 1.4 }] : [], k === 'I(Leverage)' ? undefined : tf(k))}/>)}
      </div>
    </div>

    <div className="panel">
      <label className="pick">More signals <select value={extra} onChange={e => setExtra(e.target.value)}>
        {cat.series.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
      </select></label>
      <Chart title={run.series[extra].label} unit={run.series[extra].unit} markers={markers} lines={lines(extra)}/>
    </div>
  </>;
}

function Kpi({ t, label, value, unit, sub, spark, color, delta }: { t: Theme; label: string; value: string; unit: string; sub?: string; spark: number[]; color: string; delta?: React.ReactNode }) {
  void t;
  return <div className="kpi">
    <span>{label}</span>
    <div className="kpi-row"><strong>{value} <em>{unit}</em></strong><Spark y={spark} color={color}/></div>
    {sub && <small>{sub}</small>}
    {delta}
  </div>;
}

// The run library: pick the active run, tick runs to compare, rename, delete; metrics side by side.
export function RunLibrary({ runs, activeId, compareIds, setActive, toggleCompare, rename, remove }:
  { runs: SavedRun[]; activeId: number; compareIds: number[]; setActive: (id: number) => void; toggleCompare: (id: number) => void; rename: (id: number, label: string) => void; remove: (id: number) => void }) {
  return <div className="panel">
    <h3>Runs</h3>
    <p className="muted note">The active run is drawn in colour; ticked runs are drawn grey for comparison. Up to 8 runs are kept in this page.</p>
    <div className="table-wrap"><table className="data runs">
      <thead><tr><th>show</th><th>compare</th><th className="left">name</th><th>RMS gap pt</th><th>max dev pt</th><th>end π %</th><th>rate range %</th><th>GDP %/yr</th><th></th></tr></thead>
      <tbody>{runs.slice().reverse().map(r => <tr key={r.id} className={r.id === activeId ? 'active' : ''}>
        <td><input type="radio" name="active-run" checked={r.id === activeId} onChange={() => setActive(r.id)} aria-label={`show ${r.label}`}/></td>
        <td><input type="checkbox" disabled={r.id === activeId} checked={compareIds.includes(r.id)} onChange={() => toggleCompare(r.id)} aria-label={`compare ${r.label}`}/></td>
        <td className="left"><input className="name-input" value={r.label} onChange={e => rename(r.id, e.target.value)} aria-label="run name"/></td>
        <td>{r.metrics.inflation_rmse_pts.toFixed(2)}</td><td>{r.metrics.inflation_max_dev_pts.toFixed(1)}</td><td>{r.metrics.inflation_end_pct.toFixed(2)}</td>
        <td>{r.metrics.rate_min_pct.toFixed(2)}–{r.metrics.rate_max_pct.toFixed(2)}</td><td>{r.metrics.gdp_growth_pct_per_year.toFixed(2)}</td>
        <td>{runs.length > 1 && <button className="link-btn" onClick={() => remove(r.id)} aria-label={`delete ${r.label}`}>delete</button>}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}
