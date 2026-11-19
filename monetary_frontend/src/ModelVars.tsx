import { ConstantVar, Scenario } from './types';

// Changeable model variables: the sources in the netlist with a fixed number (Simple ROI, R_for, APP, the fixed import
// and export flows). They are flat over a run; here they can be set per scenario (the next run uses them).
export function ModelVars({ vars, draft, applied, set, onRun, busy }: {
  vars: ConstantVar[]; draft: Scenario; applied?: Scenario; set: (patch: Partial<Scenario>) => void; onRun: () => void; busy: boolean;
}) {
  if (!vars.length) return null;
  const valueOf = (c: ConstantVar, s?: Scenario) => s?.constants?.[c.ref] ?? c.value;
  const setVar = (c: ConstantVar, model: number) => {
    const next = { ...(draft.constants ?? {}) };
    if (Math.abs(model - c.value) < 1e-12) delete next[c.ref]; else next[c.ref] = model;
    set({ constants: next });
  };
  const changed = vars.filter(c => Math.abs(valueOf(c, draft) - c.value) > 1e-12);
  const pending = vars.some(c => Math.abs(valueOf(c, draft) - valueOf(c, applied)) > 1e-12);
  const groups: [string, ConstantVar[]][] = [
    ['Rates and returns', vars.filter(c => !c.flow && c.unit === '%')],
    ['Policy instruments and stocks', vars.filter(c => !c.flow && c.unit !== '%')],
    ['Fixed flows', vars.filter(c => c.flow)],
  ];
  const digits = (c: ConstantVar) => c.unit === '%' ? 2 : 3;
  return <section className="mvars">
    <div className="mvars-head">
      <h3>Changeable model variables <span className="muted small">· values that are fixed in the netlist, so flat over the run · change one and run the simulation</span></h3>
      <div className="mvars-actions">
        {pending && <span className="mvars-pending small" role="status">changed, not run yet</span>}
        {changed.length > 0 && <button className="ghost" onClick={() => set({ constants: {} })}>Reset all</button>}
        <button className="primary" onClick={onRun} disabled={busy}>{busy ? 'Simulating…' : 'Run with these values'}</button>
      </div>
    </div>
    <div className="mvars-grid">{groups.flatMap(([g, cs]) => cs.map(c => {
        const v = valueOf(c, draft) * c.scale, isChanged = Math.abs(valueOf(c, draft) - c.value) > 1e-12;
        const step = (c.max - c.min) / 200;
        return <div key={c.ref} className={`mvar${isChanged ? ' changed' : ''}`}>
          <span className="mvar-group">{g}</span>
          <span className="mvar-name" title={c.name}>{c.label}</span>
          <div className="mvar-top">
            <input type="range" min={c.min} max={c.max} step={step} value={v} aria-label={c.label}
              onChange={e => setVar(c, Number(e.target.value) / c.scale)}/>
            <span className="mvar-val">
              <input type="number" value={Number(v.toFixed(digits(c) + 2))} min={c.min} max={c.max} step={step}
                aria-label={`${c.label} (${c.unit})`}
                onChange={e => { const x = Number(e.target.value); if (Number.isFinite(x)) setVar(c, Math.min(c.max, Math.max(c.min, x)) / c.scale); }}/>
              <span className="muted small">{c.unit}</span>
            </span>
          </div>
          <div className="mvar-foot small">
            <span className="muted">netlist {(c.value * c.scale).toFixed(digits(c))} {c.unit}</span>
            {isChanged && <button className="link-btn" onClick={() => setVar(c, c.value)}>reset</button>}
          </div>
          <p className="muted mvar-info">{c.info}</p>
        </div>;
      }))}</div>
  </section>;
}
