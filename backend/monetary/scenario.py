"""A scenario: the inputs the app exposes, how they become a run netlist, and the series that come back."""
from __future__ import annotations
from functools import lru_cache
import json
import time
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from . import netlist as nl, ngspice as ng, steady

UNITS_PER_YEAR = 120.0   # the interest flows divide annual rates by 120 and delta_k = 10 %/120: 120 units = 1 year
T_STOP = 1600.0
POINTS = 1601            # output grid: one point per time unit

_P = ng.parse_params(nl.read_model())
DEFAULTS = {"kp": _P["kp"], "ki": _P["ki"], "kd": _P["kd"], "r_star": _P["r_star"], "t_start": _P["t_start"]}
PHI_TARGET = _P.get("phi_target")   # target bank leverage, a reference line in the balance-sheet panel


class Scenario(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field("New scenario", max_length=80)
    closed: bool = False                    # False: the exogenous rate path below; True: the policy rule sets the rate
    steady_start: bool = True               # False: the netlist's own start (.ic lines and start-up guards)
    # Policy rule B_PI (closed loop)
    kp: float = Field(DEFAULTS["kp"], ge=0, le=5)
    ki: float = Field(DEFAULTS["ki"], ge=0, le=5)
    kd: float = Field(DEFAULTS["kd"], ge=0, le=20)
    derivative: Literal["filtered", "netlist"] = "filtered"
    tau_d: float = Field(1.0, ge=0.1, le=50)          # derivative filter, time units
    r_star: float = Field(DEFAULTS["r_star"] * 100, ge=-1, le=8)     # neutral rate, %
    target_pct: float = Field(2.0, ge=0, le=6)        # inflation target, %
    t_start: float = Field(DEFAULTS["t_start"], ge=0, le=1500)       # integral and derivative terms start, time units
    # Exogenous rate path (open loop): base rate, then a step
    rate_pct: float = Field(2.0, ge=-1, le=10)
    step_pct: float = Field(0.5, ge=-5, le=5)
    step_time: float = Field(400.0, ge=0, le=1600)


TARGET_OLD = "B§Target_CPI 0 0 I=0.02"


def build(s: Scenario) -> list[str]:
    policy = nl.Policy(closed=s.closed, kp=s.kp, ki=s.ki, kd=s.kd,
                       derivative=s.derivative if s.closed else "netlist", tau_d=s.tau_d)
    lines = nl.build(policy, steady_start=s.steady_start)
    nl.set_param(lines, "R_star", s.r_star / 100)
    nl.set_param(lines, "t_start", s.t_start)
    nl._replace(lines, TARGET_OLD, f"B§Target_CPI 0 0 I={s.target_pct / 100:.8g}")
    if not s.closed:
        i = nl._index(lines, "B§R 0 0 ")
        lines[i] = f"B§R 0 0 I =if(time<{s.step_time:g}, {s.rate_pct / 100:.8g}, {(s.rate_pct + s.step_pct) / 100:.8g})"
    return lines


# key: (trace, label, unit, scale)
SERIES = [
    ("I(CPI_filtered)", "Inflation (filtered CPI)", "%", 100),
    ("I(CPI)", "Inflation, instantaneous (120·d ln P/dt)", "%", 100),
    ("I(Target_CPI)", "Inflation target", "%", 100),
    ("I(R)", "Policy rate R", "%", 100),
    ("V(n_pi)", "Policy rule output (before smoothing)", "%", 100),
    ("I(R_retail)", "Retail loan rate", "%", 100),
    ("I(R_wholesale)", "Wholesale rate", "%", 100),
    ("I(y_LT)", "Long-term bond yield", "%", 100),
    ("I(P)", "Price level P", "index", 1),
    ("I(GDP_real)", "Real GDP", "per time unit", 1),
    ("I(L_cons)", "Consumption", "per time unit", 1),
    ("I(Investment)", "Investment", "per time unit", 1),
    ("I(Capital_Stock)", "Capital stock", "level", 1),
    ("V(n_wage)", "Wage", "level", 1),
    ("I(Labour_demand)", "Employment (labour demand)", "per time unit", 1),
    ("I(Exchange_rate)", "Exchange rate", "level", 1),
    ("I(Leverage)", "Bank leverage", "ratio", 1),
    ("I(B_NW)", "Bank net worth", "level", 1),
    ("I(B_loanbal)", "Loan balance", "level", 1),
    ("I(Government_Debt)", "Government debt", "level", 1),
]


@lru_cache(maxsize=64)
def _steady(key: str) -> steady.Steady:
    lines = json.loads(key)
    return steady.steady_start(lines, nl.IC_SIGNALS)


_RECENT: dict[str, dict] = {}   # scenario json -> all traces of the run (last few), for element plots on the map


def recent_traces(s: Scenario) -> dict:
    """All I() traces of the scenario's run (runs the scenario if it is not among the recent ones)."""
    key = s.model_copy(update={"name": ""}).model_dump_json()
    if key not in _RECENT:
        run(s)
    return _RECENT[key]


def dashboard_values(s: Scenario) -> dict:
    """Start, end, minimum and maximum of every dashboard variable in the scenario's run."""
    from .schematic import dashboard
    traces = recent_traces(s)
    low = {k.lower(): k for k in traces}
    out = {}
    for d in dashboard():
        k = low.get(f"i({d['ref'].lower()})")
        if k is not None:
            v = traces[k]
            out[d["name"]] = {"start": float(v[0]), "end": float(v[-1]), "min": float(v.min()), "max": float(v.max())}
    return out


def element_trace(s: Scenario, element: str) -> dict:
    """I(element) of the scenario's run on the output grid; "V(node)" gives a node voltage (the effort of a port)."""
    traces = recent_traces(s)
    want = element.lower() if element.upper().startswith("V(") else f"i({element.split('§')[-1].lower()})"
    hit = next((k for k in traces if k.lower() == want), None)
    if hit is None:
        raise KeyError(f"no trace for {element}")
    t = np.linspace(0, T_STOP, POINTS)
    y = np.interp(t, traces["time"], traces[hit])
    return {"element": element, "trace": hit, "years": (t / UNITS_PER_YEAR).round(5).tolist(), "values": [round(float(v), 8) for v in y]}


def run(s: Scenario) -> dict:
    t0 = time.time()
    lines = build(s)
    if s.steady_start:
        st = _steady(json.dumps(lines))
        traces = ng.run_lines(lines, st.ic_signals, st.override)
    else:
        traces = ng.run_lines(lines, nl.IC_SIGNALS)
    _RECENT[s.model_copy(update={"name": ""}).model_dump_json()] = {k: v for k, v in traces.items() if k == "time" or k.startswith(("I(", "V("))}
    while len(_RECENT) > 6:
        _RECENT.pop(next(iter(_RECENT)))
    t = np.linspace(0, T_STOP, POINTS)
    series = {}
    for key, label, unit, scale in SERIES:
        y = np.interp(t, traces["time"], traces[key]) * scale
        series[key] = {"label": label, "unit": unit, "values": [round(float(v), 6) for v in y]}
    return {"scenario": s.model_dump(), "years": [round(float(v / UNITS_PER_YEAR), 5) for v in t],
            "series": series, "metrics": metrics(s, t, series), "seconds": round(time.time() - t0, 2)}


def metrics(s: Scenario, t: np.ndarray, series: dict) -> dict:
    """Inflation-targeting scores after the rule is fully active (t_start in closed loop, 0 in open loop)."""
    pi = np.array(series["I(CPI_filtered)"]["values"])
    r = np.array(series["I(R)"]["values"])
    gdp = np.array(series["I(GDP_real)"]["values"])
    m = t >= (s.t_start if s.closed else 0)
    gap = pi[m] - s.target_pct
    return {
        "inflation_rmse_pts": round(float(np.sqrt(np.mean(gap ** 2))), 3),
        "inflation_max_dev_pts": round(float(np.abs(gap).max()), 3),
        "inflation_end_pct": round(float(pi[-1]), 3),
        "rate_min_pct": round(float(r[m].min()), 3),
        "rate_max_pct": round(float(r[m].max()), 3),
        "gdp_growth_pct_per_year": round(float(100 * np.log(gdp[-1] / gdp[0]) / (t[-1] / UNITS_PER_YEAR)), 3),
    }
