import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Chart } from './Chart';
import { Scenario } from './types';
import { axis, baseLayout, sectorColor, useTheme, withAlpha } from './viz';

interface FlowNode { node: string; elements: string[]; push: Record<string, number[]> }
interface Flows { years: number[]; sectors: string[]; nodes: FlowNode[]; outside: string }

// Per shared node and year: each sector that pushes current in (delivers) sends to each sector that takes current out,
// in proportion to what they take. Links of the selected nodes are summed per pair of sectors.
function linksAt(f: Flows, nodes: FlowNode[], i: number) {
  const pair = new Map<string, { from: string; to: string; value: number; via: string[] }>();
  for (const n of nodes) {
    const ent = Object.entries(n.push).map(([s, v]) => [s, v[i]] as [string, number]);
    const give = ent.filter(([, v]) => v > 0), take = ent.filter(([, v]) => v < 0);
    const total = take.reduce((a, [, v]) => a - v, 0);
    if (total <= 0) continue;
    for (const [a, va] of give) for (const [b, vb] of take) {
      if (a === b) continue;
      const v = va * (-vb) / total, k = `${a}→${b}`;
      const p = pair.get(k) ?? { from: a, to: b, value: 0, via: [] };
      p.value += v; p.via.push(`${n.node} ${v.toPrecision(3)}`); pair.set(k, p);
    }
  }
  void f;
  return [...pair.values()].filter(p => p.value > 0);
}

export function FlowsView({ scenario }: { scenario: Scenario }) {
  const t = useTheme();
  const [f, setF] = useState<Flows>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [yi, setYi] = useState(20);
  const [off, setOff] = useState<string[]>([]);
  const [detail, setDetail] = useState('Goods');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true; setBusy(true);
    api<Flows>('/flows', scenario).then(d => { if (live) { setF(d); setError(''); setYi(i => Math.min(i, d.years.length - 1)); } })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [scenario]);

  const nodes = useMemo(() => f?.nodes.filter(n => !off.includes(n.node)) ?? [], [f, off]);
  const links = useMemo(() => f ? linksAt(f, nodes, yi) : [], [f, nodes, yi]);

  useEffect(() => {
    let live = true;
    const node = box.current;
    if (!f || !node) return;
    void import('plotly.js-dist-min').then(({ default: Plotly }) => {
      if (!live) return;
      // bipartite: delivering sectors on the left, receiving sectors on the right (flows run both ways between sectors)
      const left = [...new Set(links.map(l => l.from))].sort(), right = [...new Set(links.map(l => l.to))].sort();
      const labels = [...left, ...right];
      Plotly.react(node, [{
        type: 'sankey', arrangement: 'snap', valueformat: '.4f',
        node: { label: labels, color: labels.map(s => sectorColor(t, s)), pad: 14, thickness: 14, line: { color: t.panel, width: 2 },
          hovertemplate: '%{label}: %{value:.4f} per time unit<extra></extra>' },
        link: { source: links.map(l => left.indexOf(l.from)), target: links.map(l => left.length + right.indexOf(l.to)), value: links.map(l => l.value),
          color: links.map(l => withAlpha(sectorColor(t, l.from), 0.4)), customdata: links.map(l => l.via.join('<br>')),
          hovertemplate: '%{source.label} → %{target.label}: %{value:.4f}<br>via nodes:<br>%{customdata}<extra></extra>' },
        textfont: { color: t.ink, size: 12 },
      }], { ...baseLayout(t, 460), margin: { l: 8, r: 8, t: 28, b: 8 }, xaxis: axis(t), yaxis: axis(t),
        annotations: [{ xref: 'paper', yref: 'paper', x: 0, y: 1.06, text: 'delivers', showarrow: false, xanchor: 'left', font: { color: t.ink2, size: 12 } },
          { xref: 'paper', yref: 'paper', x: 1, y: 1.06, text: 'receives', showarrow: false, xanchor: 'right', font: { color: t.ink2, size: 12 } }] },
        { displayModeBar: false, responsive: true });
    });
    return () => { live = false; };
  }, [f, links, t]);

  if (error) return <p className="notice bad">{error}</p>;
  if (!f) return <div className="panel empty"><p className="muted">{busy ? 'Running the scenario for its flows…' : 'No flows yet.'}</p></div>;
  const dn = f.nodes.find(n => n.node === detail) ?? f.nodes[0];
  const year = f.years[yi];

  return <div className={busy ? 'busy' : ''}>
    <div className="panel">
      <div className="analysis-head">
        <label className="slider tight">
          <span className="slider-head">Year<output>{year.toFixed(2)} yr</output></span>
          <input type="range" min={0} max={f.years.length - 1} step={1} value={yi} onChange={e => setYi(Number(e.target.value))}/>
        </label>
        {busy && <p className="muted note">Updating…</p>}
      </div>
      <p className="notice warn">The currents are model units per time unit and not all money: goods, labour and money nodes are mixed. Untick nodes to look at one kind of flow at a time.</p>
      <h3>Flows between sectors</h3>
      <p className="muted note">Width: current at that year. At every node where sectors meet, each delivering sector is shown sending to each receiving sector in proportion to what it takes. Hover a band for the nodes behind it. Colours: sector, as on the model map; grey = boxes that group or help ({f.outside.toLowerCase()} included).</p>
      <div ref={box} style={{ minHeight: 460 }} aria-label="Flows between sectors"/>
    </div>

    <div className="panel">
      <h3>Nodes where sectors meet</h3>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>show</th><th className="left">node</th><th className="left">elements</th><th className="left">sectors at {year.toFixed(2)} yr (+ delivers, − takes)</th></tr></thead>
        <tbody>{f.nodes.map(n => <tr key={n.node} className={n.node === dn.node ? 'active' : ''}>
          <td><input type="checkbox" checked={!off.includes(n.node)} onChange={() => setOff(o => o.includes(n.node) ? o.filter(x => x !== n.node) : [...o, n.node])} aria-label={`show ${n.node}`}/></td>
          <td className="left"><button className="link-btn" onClick={() => setDetail(n.node)}>{n.node}</button></td>
          <td className="left small">{n.elements.join(', ')}</td>
          <td className="left small">{Object.entries(n.push).map(([s, v]) => <span key={s} className="push"><span className="dot" style={{ background: sectorColor(t, s) }}/>{s} {v[yi] >= 0 ? '+' : '−'}{Math.abs(v[yi]).toPrecision(3)}</span>)}</td>
        </tr>)}</tbody>
      </table></div>
    </div>

    <div className="panel">
      <Chart title={`Node ${dn.node} over time`} unit="current per time unit" group={null}
        note={`What each sector pushes into ${dn.node} (${dn.elements.join(', ')}). The lines add up to zero at every moment.`}
        lines={Object.entries(dn.push).map(([s, v]) => ({ name: s, x: f.years, y: v, color: sectorColor(t, s) }))}
        markers={[{ x: year, label: ' selected year' }]}/>
    </div>
  </div>;
}
