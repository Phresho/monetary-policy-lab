import { useEffect, useRef } from 'react';

// A Plotly figure with the app's styling; data and layout are passed straight through (axes merged with defaults).
const AXIS = { gridcolor: '#e8ece9', zerolinecolor: '#aab5b0' };

export function Plot({ title, data, layout = {}, height = 300, note }: { title: string; data: object[]; layout?: Record<string, unknown>; height?: number; note?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const node = box.current;
    void import('plotly.js-dist-min').then(({ default: Plotly }) => {
      if (!live || !node) return;
      const l = layout as Record<string, Record<string, unknown>>;
      Plotly.react(node, data, {
        height, margin: { l: 60, r: 14, t: 8, b: 44 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        font: { family: 'Inter, system-ui, sans-serif', size: 12, color: '#3c4a45' }, legend: { orientation: 'h', y: -0.2 },
        ...layout, xaxis: { ...AXIS, ...(l.xaxis ?? {}) }, yaxis: { ...AXIS, ...(l.yaxis ?? {}) },
      }, { displayModeBar: false, responsive: true });
    });
    return () => { live = false; };
  }, [data, layout, height]);
  return <figure className="chart"><figcaption>{title}</figcaption>{note && <p className="muted note">{note}</p>}<div ref={box} style={{ minHeight: height }} aria-label={title}/></figure>;
}
