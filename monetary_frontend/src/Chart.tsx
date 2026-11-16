import { useEffect, useRef } from 'react';

export interface Line { name: string; x: number[]; y: number[]; color: string; dash?: string; width?: number }
export interface Marker { x: number; label: string }

export function Chart({ title, unit, lines, markers = [], height = 280 }: { title: string; unit: string; lines: Line[]; markers?: Marker[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const node = box.current;
    void import('plotly.js-dist-min').then(({ default: Plotly }) => {
      if (!live || !node) return;
      Plotly.react(node, lines.map(l => ({
        type: 'scatter', mode: 'lines', name: l.name, x: l.x, y: l.y,
        line: { color: l.color, dash: l.dash ?? 'solid', width: l.width ?? 2.2 },
        hovertemplate: `%{y:.3f}<extra>${l.name}</extra>`,
      })), {
        height, margin: { l: 56, r: 12, t: 8, b: 40 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        hovermode: 'x unified', font: { family: 'Inter, system-ui, sans-serif', size: 12, color: '#3c4a45' },
        legend: { orientation: 'h', y: -0.14 },
        xaxis: { ticksuffix: ' yr', gridcolor: '#e8ece9', zeroline: false },
        yaxis: { title: { text: unit }, gridcolor: '#e8ece9', zerolinecolor: '#aab5b0' },
        shapes: markers.map(m => ({ type: 'line', x0: m.x, x1: m.x, yref: 'paper', y0: 0, y1: 1, line: { color: '#aab5b0', width: 1, dash: 'dot' } })),
        annotations: markers.map(m => ({ x: m.x, yref: 'paper', y: 1, text: m.label, showarrow: false, xanchor: 'left', yanchor: 'top', font: { size: 11, color: '#5c6b65' } })),
      }, { displayModeBar: false, responsive: true });
    });
    return () => { live = false; };
  }, [lines, unit, height, markers]);
  return <figure className="chart"><figcaption>{title}</figcaption><div ref={box} style={{ minHeight: height }} aria-label={title}/></figure>;
}
