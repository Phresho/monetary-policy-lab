"""Steady-state start for the monetary model.

The netlist starts from hand-set .ic values (I(Income)=85m, V(n_wage)=0.1, ...) and integrator start values that
are not in equilibrium with each other, so the first time units are a violent transient (P 0.13 -> 0.27, CPI up
to 260). Here the start is computed instead:

1. The forcing .ic lines are removed. The operating point then puts every inductor and capacitor in equilibrium
   (inductors carry their DC current, capacitors no current): the fast part of the economy is at rest.
2. The start values of the integrators in FREE are solved so that their inputs are zero: at the operating point
   each integrator is held by a voltage source whose current is exactly the integrator's input (d state / dt).
   scipy's root finder moves the start values until all those currents are zero.
3. Integrators that accumulate a flow that is never zero (capital, government debt, long bonds, the savings
   balance, the wage index) keep the netlist's start values: they are the initial stocks, and their growth is
   the economy's growth path, not a start-up transient.

Inflation: CPI = 120*ddt(ln P) is 0 at an operating point by construction; the netlist holds CPI at pi_bar for
t < 0.1 and CPI_filtered at 0.02 for t < 2. After the solve, the inflation the economy actually starts with is
measured with a short run and used as CPI_filtered's start value, so it does not jump at t = 2.
"""
from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
from scipy.optimize import root

from . import ngspice as ng

# Integrators solved for zero input (element name, lower case) and why they may move:
FREE = {
    "b_loanbal": "loan book: new loans = repayments (B_loanbal / T_L)",
    "r_retail": "retail rate = its target R_ret_target",
    "b_nw": "bank net worth: profit = dividends",
    "coupon_lt": "average coupon = long-term yield",
    "b_l_hh": "household long bonds = their target",
    "b_f": "foreign assets: trade balance + interest = 0",
    "lne": "exchange rate: foreign-bond flow balanced by the pull back to 0",
    "pi_d": "derivative filter state = the inflation error (only with Policy(derivative='filtered'))",
}
OPTIONAL = {"pi_d"}  # solved when the element is in the netlist


def strip_ic(lines: list[str]) -> list[str]:
    """The netlist without its .ic lines (they force values that are not an equilibrium)."""
    return [l for l in lines if not l.lower().startswith(".ic")]


def _op(lines: list[str], ic_signals: dict[str, float], override: dict[str, float]) -> tuple[dict, list[dict]]:
    info: dict = {}
    text, names, _ = ng.translate(lines, ic_signals, override, info)
    vec, log = ng._run_text(ng.op_text(text))
    if not vec:
        raise RuntimeError("no operating point: " + " | ".join(log))
    return vec, info["integrators"]


def rates(lines: list[str], ic_signals: dict[str, float], override: dict[str, float]) -> dict[str, float]:
    """d state / dt of every integrator at the operating point with these start values."""
    vec, integ = _op(lines, ic_signals, override)
    return {i["owner"]: float(np.ravel(vec[f"v{i['node']}hold#branch"])[0]) for i in integ}


@dataclass
class Steady:
    override: dict[str, float]          # solved start values {element: value}
    ic_signals: dict[str, float]        # start value of signals read by idt() (CPI)
    residual: dict[str, float]          # d state / dt of every integrator at the solution
    start: dict[str, float] = field(default_factory=dict)   # the netlist's start values, for comparison


def solve(lines: list[str], ic_signals: dict[str, float], free: dict[str, str] = FREE, tol: float = 1e-10) -> Steady:
    """Start values of the FREE integrators with zero input, the rest at the netlist's values."""
    lines = strip_ic(lines)
    _, integ = _op(lines, ic_signals, {})
    start = {i["owner"]: i["ic"] for i in integ}
    names = [n for n in free if n in start]
    missing = set(free) - set(start) - OPTIONAL
    if missing:
        raise ValueError(f"no idt() in {sorted(missing)}")
    x0 = np.array([start[n] for n in names])
    scale = np.maximum(np.abs(x0), 1e-2)

    def f(z):
        r = rates(lines, ic_signals, dict(zip(names, z * scale)))
        return np.array([r[n] for n in names]) * 1e3

    sol = root(f, x0 / scale, method="hybr", tol=tol)
    override = dict(zip(names, sol.x * scale))
    res = rates(lines, ic_signals, override)
    worst = max(abs(res[n]) for n in names)
    if worst > 1e-8:
        raise RuntimeError(f"steady state not found ({sol.message}); largest d/dt {worst:.3g}")
    return Steady(override, dict(ic_signals), res, start)


def initial_inflation(lines: list[str], ic_signals: dict[str, float], override: dict[str, float], t_end: float = 3.0) -> float:
    """Inflation the economy starts with, 120 * d ln P / dt, from a short run (slope of ln P over 0.5 .. t_end)."""
    short = [f".tran 0 {t_end:g} 0 20ms" if l.lower().startswith(".tran") else l for l in strip_ic(lines)]
    r = ng.run_lines(short, ic_signals, override)
    t, p = r["time"], np.log(r["I(P)"])
    m = t >= 0.5
    return float(120 * np.polyfit(t[m], p[m], 1)[0])


def steady_start(lines: list[str], ic_signals: dict[str, float], rounds: int = 4) -> Steady:
    """solve(), with CPI_filtered starting at the inflation the solved economy actually has. In closed loop that
    start value moves the policy rate and so the steady state, hence a few rounds (converges in 2-3)."""
    ic = dict(ic_signals)
    for _ in range(rounds):
        s = solve(lines, ic)
        pi0 = initial_inflation(lines, ic, s.override)
        if abs(pi0 - ic["I(CPI)"]) < 1e-5:
            break
        ic["I(CPI)"] = pi0
    else:
        raise RuntimeError("initial inflation did not settle")
    return s
