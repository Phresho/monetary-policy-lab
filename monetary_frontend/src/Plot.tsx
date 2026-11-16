import { useEffect, useRef, useState } from 'react';
import { DataTable } from './Chart';
import { axis, baseLayout, download, toCsv, useTheme } from './viz';

type Trace = { name?: string; x?: number[]; y?: number[]; showlegend?: boolean };

// A Plotly figure in the app's theme; data and layout are passed straight through (axes merged with the theme's chrome).
// Table / CSV use the traces that have a name and x/y arrays.
export function Plot({ title, data, layout = {}, height = 300, note, xName = 'x', unit = '' }:
  { title: string; data: object[]; layout?: Record<string, unknown>; height?: number; note?: string; xName?: string; unit?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const t = useTheme();
  const [table, setTable] = useState(false);
  const cols = (data as Trace[]).filter(d => d.name && d.x && d.y && d.x.length > 1).map(d => ({ name: d.name!, x: d.x!, y: d.y! }));
  useEffect(() => {
    let live = true;
    const node = box.current;
    void import('plotly.js-dist-min').then(({ default: Plotly }) => {
      if (!live || !node) return;
      const l = layout as Record<string, Record<string, unknown>>;
      const many = (data as Trace[]).filter(d => d.showlegend !== false).length >= 2;
      Plotly.react(node, data, {
        ...baseLayout(t, height), showlegend: many, margin: { l: 60, r: 14, t: many ? 30 : 8, b: 44 },
        ...layout, xaxis: axis(t, l.xaxis ?? {}), yaxis: axis(t, l.yaxis ?? {}),
      }, { displayModeBar: false, responsive: true });
    });
    return () => { live = false; };
  }, [data, layout, height, t]);
  return <figure className="chart">
    <figcaption><span>{title}</span>{cols.length > 0 && <span className="chart-tools">
      <button className="link-btn" onClick={() => setTable(v => !v)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>
      <button className="link-btn" onClick={() => download(`${title.replace(/[^\w]+/g, '_')}.csv`, toCsv(xName, cols))}>CSV</button>
    </span>}</figcaption>
    {note && <p className="muted note">{note}</p>}
    <div ref={box} style={{ minHeight: height, display: table ? 'none' : undefined }} aria-label={title}/>
    {table && <DataTable xName={xName} lines={cols} unit={unit}/>}
  </figure>;
}
