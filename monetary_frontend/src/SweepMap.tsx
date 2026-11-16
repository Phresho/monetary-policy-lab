import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Scenario } from './types';
import { axis, baseLayout, useTheme } from './viz';

interface Sweep { kp: number; ki: number[]; kd: number[]; ms: number[][]; pm_deg: (number | null)[][]; verdict: string[][]; t_op_years: number; approx: boolean }

const MS_MAX = 4;   // the colour scale ends here; Ms 2 is the usual robustness limit

// Robustness map over Ki x Kd at the current Kp: colour = peak sensitivity Ms (one blue, darker = less robust),
// unstable cells crossed out in the critical colour (never colour alone). Click a cell to set Ki and Kd.
export function SweepMap({ scenario, tOp, onPick }: { scenario: Scenario; tOp: number; onPick: (ki: number, kd: number) => void }) {
  const t = useTheme();
  const [m, setM] = useState<Sweep>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [near, setNear] = useState(true);
  // 'around the current setting': up to 4x the current gains (at least Ki 0.1, Kd 2); else the sliders' full range
  const kiMax = near ? Math.max(0.1, 4 * scenario.ki) : 2, kdMax = near ? Math.max(2, 4 * scenario.kd) : 10;
  const box = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick); pick.current = onPick;
  // only Kp, R*, target, loop and year change the map; Ki and Kd are its axes
  const key = JSON.stringify({ ...scenario, ki: 0, kd: 0, name: '', kiMax, kdMax });

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      setBusy(true);
      api<Sweep>('/sweep', { scenario, t_op_years: tOp, ki_max: kiMax, kd_max: kdMax }).then(r => { if (live) { setM(r); setError(''); } })
        .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (live) setBusy(false); });
    }, 600);
    return () => { live = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tOp]);

  useEffect(() => {
    let live = true;
    const node = box.current as (HTMLDivElement & { on?: (e: string, f: (ev: { points: { x: number; y: number }[] }) => void) => void; removeAllListeners?: (e: string) => void }) | null;
    if (!m || !node) return;
    void import('plotly.js-dist-min').then(({ default: Plotly }) => {
      if (!live) return;
      const z = m.ms.map((row, i) => row.map((v, j) => m.verdict[i][j] === 'unstable' ? null : Math.min(v, MS_MAX)));
      const text = m.ms.map((row, i) => row.map((v, j) => {
        const pm = m.pm_deg[i][j];
        return `${m.verdict[i][j] === 'unstable' ? '✕ unstable' : m.verdict[i][j] === 'drift' ? '✓ stable (slow drift)' : '✓ stable'}<br>Ms ${v.toFixed(2)}${pm != null ? `, PM ${pm.toFixed(0)}°` : ''}`;
      }));
      const bad = m.verdict.flatMap((row, i) => row.map((v, j) => v === 'unstable' ? [m.ki[j], m.kd[i]] : null)).filter(Boolean) as number[][];
      const scale = t.seq.map((c, i) => [i / (t.seq.length - 1), c]);
      Plotly.react(node, [
        { type: 'heatmap', x: m.ki, y: m.kd, z, zmin: 1, zmax: MS_MAX, colorscale: scale, xgap: 2, ygap: 2, text, hovertemplate: 'Ki %{x:.3f}, Kd %{y:.2f}<br>%{text}<extra></extra>',
          colorbar: { title: { text: 'Ms', font: { color: t.ink2 } }, tickfont: { color: t.muted }, outlinewidth: 0, thickness: 12, tickvals: [1, 2, 3, 4], ticktext: ['1', '2 (limit)', '3', '≥ 4'] } },
        { type: 'scatter', mode: 'markers', name: 'unstable', x: bad.map(b => b[0]), y: bad.map(b => b[1]), marker: { symbol: 'x-thin', size: 9, color: t.critical, line: { color: t.critical, width: 2 } }, hoverinfo: 'skip' },
        { type: 'scatter', mode: 'markers', name: 'current setting', x: [scenario.ki], y: [scenario.kd], marker: { symbol: 'circle-open', size: 16, color: t.ink, line: { color: t.ink, width: 2.5 } }, hoverinfo: 'skip' },
        { type: 'contour', x: m.ki, y: m.kd, z: m.ms.map((row, i) => row.map((v, j) => m.verdict[i][j] === 'unstable' ? 99 : v)), showscale: false, hoverinfo: 'skip', name: 'Ms = 2',
          contours: { start: 2, end: 2, size: 1, coloring: 'none', showlabels: true, labelfont: { color: t.ink, size: 11 } }, line: { color: t.ink, width: 1.5, dash: 'dot' } },
      ], {
        ...baseLayout(t, 420), showlegend: true, margin: { l: 60, r: 10, t: 30, b: 44 },
        xaxis: axis(t, { title: { text: 'Ki (integral)' }, zeroline: false }), yaxis: axis(t, { title: { text: 'Kd (derivative)' }, zeroline: false }),
      }, { displayModeBar: false, responsive: true }).then(() => {
        node.removeAllListeners?.('plotly_click');
        node.on?.('plotly_click', ev => { const p = ev.points?.[0]; if (p) pick.current(+p.x.toFixed(3), +p.y.toFixed(2)); });
      });
    });
    return () => { live = false; };
  }, [m, t, scenario.ki, scenario.kd]);

  return <div className={'panel' + (busy ? ' busy' : '')}>
    <div className="pick-row">
      <h3>Robustness map: Ki × Kd at Kp = {scenario.kp}</h3>
      <div className="segmented small-seg" role="group" aria-label="Map range">
        <button className={near ? 'active' : ''} onClick={() => setNear(true)}>Near current</button>
        <button className={!near ? 'active' : ''} onClick={() => setNear(false)}>Full range</button>
      </div>
    </div>
    <p className="muted note">Every cell is the linear loop with those gains. Darker = higher peak sensitivity Ms (less robust); the dotted line is Ms = 2. ✕ = unstable. The ring is the current setting; click a cell to use its Ki and Kd.
      {m?.approx ? ' In closed loop at a later year the plant itself depends on Ki and Kd; the map keeps the plant of the current gains, so treat it as a guide and check in the Simulation tab.' : ''}</p>
    {error && <p className="notice bad">{error}</p>}
    {!m && !error && <p className="muted note">{busy ? 'Computing the map…' : ''}</p>}
    <div ref={box} style={{ minHeight: m ? 420 : 0 }} aria-label="Robustness map"/>
  </div>;
}
