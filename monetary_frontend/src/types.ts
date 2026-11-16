export interface Scenario {
  name: string; closed: boolean; steady_start: boolean;
  kp: number; ki: number; kd: number; derivative: 'filtered' | 'netlist'; tau_d: number;
  r_star: number; target_pct: number; t_start: number;
  rate_pct: number; step_pct: number; step_time: number;
}
export interface Series { label: string; unit: string; values: number[] }
export interface Metrics { inflation_rmse_pts: number; inflation_max_dev_pts: number; inflation_end_pct: number; rate_min_pct: number; rate_max_pct: number; gdp_growth_pct_per_year: number }
export interface Run { scenario: Scenario; years: number[]; series: Record<string, Series>; seconds: number; metrics: Metrics }
// A run in the library: an id, a name the user can change.
export interface SavedRun extends Run { id: number; label: string }
export interface Catalogue {
  defaults: Scenario; netlist: Record<string, number>; series: { key: string; label: string; unit: string }[];
  time: { units_per_year: number; t_stop: number }; solver: string | null; phi_target: number | null;
}

export function autoLabel(id: number, s: Scenario): string {
  return `#${id} ` + (s.closed ? `rule Kp ${s.kp} · Ki ${s.ki} · Kd ${s.kd}` : `rate ${s.rate_pct}% ${s.step_pct >= 0 ? '+' : ''}${s.step_pct} pt`);
}
