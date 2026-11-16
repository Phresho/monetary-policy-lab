// Chart colours and theme. Values from the dataviz reference palette; checked with validate_palette.js:
// - quantities (inflation blue, rate orange, real economy aqua): categorical, all pairs PASS in light and dark;
// - the four rates along the transmission chain (policy → wholesale → retail → long-term): one orange ordinal ramp that
//   starts at the policy-rate colour, PASS (--ordinal) in both modes;
// - Ms map: the blue sequential ramp; inflation gap: diverging blue (below target) / red (above) around a grey middle.
// Colour follows the quantity, never the position in a chart. Reference lines (target, limits) use ink, not a series colour.
// Status colours (good / critical) are only for the stability verdict and always come with an icon and a label.
import { useEffect, useState } from 'react';

export type Mode = 'light' | 'dark';

const THEMES = {
  light: {
    inflation: '#2a78d6', rate: '#eb6834', real: '#1baf7a',
    rates: ['#eb6834', '#c24e1d', '#963a12', '#66260a'],
    seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    sectors: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    below: '#2a78d6', above: '#e34948', mid: '#f0efec',
    good: '#0ca30c', critical: '#d03b3b', goodText: '#006300',
    ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb', panel: '#ffffff', band: 'rgba(11,11,11,0.05)',
  },
  dark: {
    inflation: '#3987e5', rate: '#d95926', real: '#199e70',
    rates: ['#d95926', '#e8733f', '#f29a70', '#f7c2a5'],
    seq: ['#104281', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
    sectors: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'],
    below: '#3987e5', above: '#e66767', mid: '#383835',
    good: '#0ca30c', critical: '#d03b3b', goodText: '#0ca30c',
    ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', surface: '#1a1a19', panel: '#1a1a19', band: 'rgba(255,255,255,0.06)',
  },
};
export type Theme = typeof THEMES.light;

// Which quantity a series key belongs to (its colour everywhere in the app).
export const RATE_KEYS = ['I(R)', 'I(R_wholesale)', 'I(R_retail)', 'I(y_LT)'];
export function seriesColor(t: Theme, key: string): string {
  if (/CPI|I\(P\)/.test(key)) return t.inflation;
  if (RATE_KEYS.includes(key) || key === 'V(n_pi)') return t.rate;
  if (/GDP|cons|Investment|Capital|wage|Labour/.test(key)) return t.real;
  return t.ink2;  // financial stocks and ratios: one series per chart, the title names it
}

// The eight economic sectors take the reference categorical slots in this order; group boxes (Banks, NFC), helper
// boxes (Shock, CPI values, Interest Rates) and elements outside every box stay grey, so no ninth colour is needed.
export const SECTOR_ORDER = ['Central Bank', 'Wholesale banks', 'Households', 'Retail banks', 'Domestic goods producers', 'Fiscal Authority', 'Capital producers', 'Foreign Sector'];
export function sectorColor(t: Theme, name: string): string {
  const i = SECTOR_ORDER.indexOf(name);
  return i >= 0 ? t.sectors[i] : t.muted;
}
export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function systemDark() { return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches; }
export function currentMode(): Mode {
  const set = document.documentElement.dataset.theme;
  return set === 'dark' || set === 'light' ? set : systemDark() ? 'dark' : 'light';
}

// The resolved theme; charts re-render when the OS setting or the toggle changes.
export function useTheme(): Theme {
  const [mode, setMode] = useState<Mode>(currentMode);
  useEffect(() => {
    const update = () => setMode(currentMode());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', update); mo.disconnect(); };
  }, []);
  return THEMES[mode];
}

export type ThemeChoice = 'auto' | 'light' | 'dark';
export function applyThemeChoice(c: ThemeChoice) {
  if (c === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = c;
  try { localStorage.setItem('theme', c); } catch { /* storage unavailable: choice lasts for this page */ }
}
export function storedThemeChoice(): ThemeChoice {
  try { const v = localStorage.getItem('theme'); if (v === 'light' || v === 'dark') return v; } catch { /* ignore */ }
  return 'auto';
}

// Plotly layout defaults in the theme's chrome: hairline grid, recessive axes, ink text.
export function baseLayout(t: Theme, height: number) {
  return {
    // Opaque in the panel colour: Plotly draws the spike line's halo in the plot background colour.
    height, paper_bgcolor: t.panel, plot_bgcolor: t.panel,
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12, color: t.ink2 },
    // Legend above the plot, so it never meets an x-axis title.
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { color: t.ink2 } },
    hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { color: t.ink } },
  };
}
export function axis(t: Theme, extra: Record<string, unknown> = {}) {
  return { gridcolor: t.grid, linecolor: t.axis, zerolinecolor: t.axis, tickfont: { color: t.muted }, title: { font: { color: t.ink2 } }, ...extra };
}

// Shared crosshair: hovering one time chart of a group shows the same year in the others.
type Node = HTMLElement & { on?: (ev: string, fn: (e: { points?: { x: number }[] }) => void) => void };
const groups = new Map<string, Set<Node>>();
let syncing = false;
export function joinHoverGroup(group: string, node: Node, Plotly: { Fx: { hover: (n: HTMLElement, p: object) => void; unhover: (n: HTMLElement) => void } }) {
  const set = groups.get(group) ?? new Set<Node>(); groups.set(group, set); set.add(node);
  node.on?.('plotly_hover', e => {
    if (syncing) return;
    const x = e.points?.[0]?.x; if (x == null) return;
    syncing = true;
    try { set.forEach(n => { if (n !== node && n.isConnected) { try { Plotly.Fx.hover(n, { xval: x }); } catch { /* chart without data yet */ } } }); }
    finally { syncing = false; }
  });
  node.on?.('plotly_unhover', () => {
    if (syncing) return;
    set.forEach(n => { if (n !== node && n.isConnected) { try { Plotly.Fx.unhover(n); } catch { /* ignore */ } } });
  });
  return () => { set.delete(node); };
}

// CSV of one or more series on their own x grids (rows by x of the first series).
export function toCsv(xName: string, cols: { name: string; x: number[]; y: number[] }[]): string {
  const q = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const head = [xName, ...cols.map(c => c.name)].map(q).join(',');
  const xs = cols[0]?.x ?? [];
  const rows = xs.map((x, i) => [x, ...cols.map(c => valueAt(c, x, i))].map(v => v == null || !isFinite(v) ? '' : String(+v.toPrecision(8))).join(','));
  return [head, ...rows].join('\n');
}
export function valueAt(c: { x: number[]; y: number[] }, x: number, i: number): number | null {
  if (c.x[i] === x) return c.y[i];
  let lo = 0, hi = c.x.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c.x[m] < x) lo = m + 1; else hi = m; }
  return Math.abs(c.x[lo] - x) < 1e-9 ? c.y[lo] : null;
}
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
