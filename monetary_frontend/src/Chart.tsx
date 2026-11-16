import { useEffect, useRef, useState } from 'react';
import { axis, baseLayout, download, joinHoverGroup, toCsv, useTheme, valueAt } from './viz';

// tag: the short text of the line's end label (defaults to the name)
export interface Line { tag?: string; name: string; x: number[]; y: number[]; color: string; dash?: string; width?: number; fill?: string; fillcolor?: string; hidden?: boolean }
export interface Marker { x: number; label: string }

const short = (s: string) => s.length > 24 ? s.slice(0, 23) + '…' : s;

// Direct labels at the right end of each line (<= 4 series), pushed apart so they do not overlap.
function endLabels(lines: Line[], height: number, yRange?: number[]) {
  const vis = lines.filter(l => !l.hidden && l.y.length);
  if (vis.length < 2 || vis.length > 4) return [];
  const ys = vis.flatMap(l => l.y.filter(Number.isFinite));
  const lo = yRange ? yRange[0] : Math.min(...ys), hi = yRange ? yRange[1] : Math.max(...ys), span = (hi - lo) || 1;
  const perPx = span * 1.1 / Math.max(height - 70, 60);
  const items = vis.map(l => ({ l, y: l.y[l.y.length - 1], x: l.x[l.x.length - 1] })).filter(i => Number.isFinite(i.y)).sort((a, b) => b.y - a.y);
  const gap = 15 * perPx;
  for (let i = 1; i < items.length; i++) if (items[i - 1].y - items[i].y < gap) items[i].y = items[i - 1].y - gap;
  return items.map(i => ({ ...i, shift: (i.y - i.l.y[i.l.y.length - 1]) / perPx }));
}

function xExtent(lines: Line[]) {
  const xs = lines.filter(l => !l.hidden && l.x.length).flatMap(l => [l.x[0], l.x[l.x.length - 1]]);
  return xs.length ? [Math.min(...xs), Math.max(...xs)] : undefined;
}

export function Chart({ title, unit, lines, markers = [], height = 280, group = 'time', xName = 'year', xSuffix = ' yr', note, shapes = [], annotations = [], compact = false, hoverFormat = '.3f', yRange }:
  { title: string; unit: string; lines: Line[]; markers?: Marker[]; height?: number; group?: string | null; xName?: string; xSuffix?: string; note?: string;
    shapes?: object[]; annotations?: object[]; compact?: boolean; hoverFormat?: string; yRange?: number[] }) {
  const box = useRef<HTMLDivElement>(null);
  const t = useTheme();
  const [table, setTable] = useState(false);
  useEffect(() => {
    let live = true, leave: (() => void) | undefined;
    const node = box.current;
    void import('plotly.js-dist-min').then(({ default: Plotly }) => {
      if (!live || !node) return;
      const labels = endLabels(lines, height, yRange);
      const many = lines.filter(l => !l.hidden).length >= 2;
      void Plotly.react(node, lines.filter(l => !l.hidden).map(l => ({
        type: 'scatter', mode: 'lines', name: l.name, x: l.x, y: l.y, fill: l.fill, fillcolor: l.fillcolor,
        line: { color: l.color, dash: l.dash ?? 'solid', width: l.width ?? 2 },
        hovertemplate: `%{y:${hoverFormat}}<extra>${l.name}</extra>`,
      })), {
        ...baseLayout(t, height), showlegend: many && !compact, hovermode: 'x unified',
        margin: { l: 56, r: labels.length ? Math.min(170, 14 + 6.3 * Math.max(...labels.map(i => short(i.l.tag ?? i.l.name).length))) : 14, t: many && !compact ? 30 : 8, b: compact ? 24 : 34 },
        // fixed to the data: Plotly would otherwise widen the axis to make room for the end labels
        xaxis: axis(t, { ticksuffix: xSuffix, zeroline: false, range: xExtent(lines), showspikes: true, spikemode: 'across', spikethickness: 1, spikecolor: t.muted, spikedash: 'solid' }),
        yaxis: axis(t, { title: { text: unit, font: { color: t.ink2 } }, ...(yRange ? { range: yRange, autorange: false } : {}) }),
        shapes: [...shapes, ...markers.map(m => ({ type: 'line', x0: m.x, x1: m.x, yref: 'paper', y0: 0, y1: 1, line: { color: t.muted, width: 1, dash: 'dot' } }))],
        annotations: [
          ...annotations,
          ...markers.filter(() => !compact).map(m => ({ x: m.x, yref: 'paper', y: 1, text: m.label, showarrow: false, xanchor: 'left', yanchor: 'top', font: { size: 11, color: t.ink2 } })),
          ...labels.map(i => ({ x: i.x, y: i.l.y[i.l.y.length - 1], yshift: i.shift, text: short(i.l.tag ?? i.l.name), showarrow: false, xanchor: 'left', xshift: 6, font: { size: 11, color: t.ink2 } })),
        ],
      }, { displayModeBar: false, responsive: true }).then(() => { if (live && group) leave = joinHoverGroup(group, node, Plotly); });
    });
    return () => { live = false; leave?.(); };
  }, [lines, unit, height, markers, t, group, xSuffix, shapes, annotations, compact, hoverFormat, yRange]);
  return <figure className="chart">
    <figcaption className={compact ? 'compact' : undefined}><span>{title}</span><span className="chart-tools">
      <button className="link-btn" onClick={() => setTable(v => !v)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>
      <button className="link-btn" onClick={() => download(`${title.replace(/[^\w]+/g, '_')}.csv`, toCsv(xName, lines.filter(l => !l.hidden)))}>CSV</button>
    </span></figcaption>
    {note && <p className="muted note">{note}</p>}
    <div ref={box} style={{ minHeight: height, display: table ? 'none' : undefined }} aria-label={title}/>
    {table && <DataTable xName={xName} lines={lines.filter(l => !l.hidden)} unit={unit}/>}
  </figure>;
}

// Table view of a chart: about 40 evenly spaced rows (the CSV has every point).
export function DataTable({ xName, lines, unit }: { xName: string; lines: { name: string; x: number[]; y: number[] }[]; unit: string }) {
  const xs = lines[0]?.x ?? [];
  const k = Math.max(1, Math.ceil(xs.length / 40));
  const idx = xs.map((_, i) => i).filter(i => i % k === 0 || i === xs.length - 1);
  const f = (v: number | null) => v == null || !isFinite(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3);
  return <div className="table-wrap"><table className="data">
    <caption className="muted small">{unit}; every {k > 1 ? `${k}th` : ''} point, CSV for all</caption>
    <thead><tr><th>{xName}</th>{lines.map(l => <th key={l.name}>{l.name}</th>)}</tr></thead>
    <tbody>{idx.map(i => <tr key={i}><td>{f(xs[i])}</td>{lines.map(l => <td key={l.name}>{f(valueAt(l, xs[i], i))}</td>)}</tr>)}</tbody>
  </table></div>;
}
