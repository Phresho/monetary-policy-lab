"""Robust control of the policy loop: H-infinity and mu for the PID rule (fixed structure, three gains).

Loop as in frequency.py: plant P (policy rate R -> inflation, ngspice AC analysis), controller K = C H (the PID rule
C = Kp + Ki/s + Kd s/(1 + s tau_d) and the rate smoothing H), L = -P K, S = 1/(1 + L), T = L/(1 + L).

Uncertainty (Claude's choice, a weight W_T from the model itself): the economy changes over the run, so the plant at
later years differs from the nominal one. The family is the plant linearised at years 0, 2, ..., 12 of the scenario's
open-loop rate path (so it does not move with the gains), plus a flat extra model error delta (slider). W_T is the
largest relative deviation |P_k/P_0 - 1| over the family (about 0.3-0.66 at every frequency: the gain rate ->
inflation falls as the economy grows), and at least delta: a multiplicative uncertainty P = P_0 (1 + W_T Delta), |Delta| <= 1.

Performance: W_P(s) = (s/M + w_B)/(s + w_B eps), so |S| < 1/|W_P|: shocks slower than about 1/w_B are damped, and the
peak of |S| stays below M. Control effort: |K S| < KS_max (how much the rate moves per unit of inflation noise).

For one scalar uncertainty and one performance channel, mu is exact (Skogestad & Postlethwaite, ch. 7-8):
    nominal performance  NP: max |W_P S| < 1
    robust stability     RS: mu_RS = max |W_T T| < 1
    robust performance   RP: mu_RP = max (|W_P S| + |W_T T|) < 1
H-infinity design: the gains that minimise ||[W_P S; W_T T; W_U K S]||_inf (the stacked norm, gamma).
mu design: the gains that minimise mu_RP, with |W_U K S| <= 1 as a constraint (penalty).
Both are fixed-structure designs (a PID, not a full-order H-inf controller): Nelder-Mead on the log gains from
several starts, with the closed loop of the fitted plant required stable (slow drift of the economy allowed, as in
frequency._verdict). That gives a local optimum, reported as such.

Which gains: Kp also sets the steady state the plant is linearised at (the rate level at the start), Ki and Kd do not
(frequency._plant_key). So by default only Ki and Kd are tuned, at the current Kp: then the design is exact for the
plant it was made for. With free='all' Kp moves too, up to KP_MAX: above about 0.3 the economy has no steady state
near its starting inflation (the steady-state start fails, 18 Nov 2026), and the result is flagged approximate
(plant linearised at the old Kp; the evaluation after applying it re-linearises).
"""
from __future__ import annotations
from functools import lru_cache

import numpy as np
from scipy.optimize import minimize

from . import frequency as fq
from .scenario import Scenario, UNITS_PER_YEAR

MOMENTS = (2.0, 4.0, 6.0, 8.0, 10.0, 12.0)   # years of the family besides the nominal plant
EPS = 1e-3
BOUNDS = {"kp": 5.0, "ki": 5.0, "kd": 20.0}   # the Scenario limits
KP_MAX = 0.15   # free='all': the steady-state start is checked up to here


def WP(w_y: np.ndarray, M: float, wB: float) -> np.ndarray:
    s = 1j * w_y
    return (s / M + wB) / (s + wB * EPS)


def _family_key(s: Scenario) -> Scenario:
    return s.model_copy(update={"closed": False, "name": ""})


def family(s: Scenario, t_op_years: float = 0.0) -> dict:
    """Nominal plant (as the frequency analysis) and the plants at the family moments (open-loop path)."""
    t_op = round(float(t_op_years) * UNITS_PER_YEAR, 3)
    nom = fq.plant(s, t_op)
    w = nom["w"]
    P0 = nom["resp"][fq.OUTPUT]
    fk = _family_key(s)
    members = [{"year": float(t_op_years), "P": P0, "key": fq._plant_key(s, t_op).model_dump_json(), "t_op": t_op, "nominal": True}]
    for yr in MOMENTS:
        if abs(yr - t_op_years) < 1e-9:
            continue
        t = round(yr * UNITS_PER_YEAR, 3)
        p = fq.plant(fk, t)
        members.append({"year": yr, "P": p["resp"][fq.OUTPUT], "key": fq._plant_key(fk, t).model_dump_json(), "t_op": t, "nominal": False})
    return {"w": w, "P0": P0, "members": members}


def wt_weight(fam: dict, delta: float) -> np.ndarray:
    env = np.zeros(len(fam["w"]))
    for m in fam["members"]:
        env = np.maximum(env, np.abs(m["P"] / fam["P0"] - 1))
    return np.maximum(env, delta)


def _with(s: Scenario, k) -> Scenario:
    return s.model_copy(update={"kp": float(k[0]), "ki": float(k[1]), "kd": float(k[2])})


def loop_parts(s: Scenario, w: np.ndarray, P: np.ndarray):
    K = fq.controller(s, w) * fq.smoothing(w)
    L = -P * K
    S = 1 / (1 + L)
    return K, S, L * S


def stable(s: Scenario, fit: dict) -> tuple[str, float]:
    A, _, _, _ = fq.closed_loop(s, fit)
    p = np.linalg.eigvals(A) * UNITS_PER_YEAR
    v, _ = fq._verdict(p)
    return v, float(p.real.max())


class Weights:
    def __init__(self, M: float, wB: float, delta: float, ks_max: float):
        self.M, self.wB, self.delta, self.ks_max = M, wB, delta, ks_max


def _measures(s, w, P0, wp, wt, wu):
    K, S, T = loop_parts(s, w, P0)
    a, b, c = np.abs(wp * S), np.abs(wt * T), np.abs(wu * K * S)
    return {"np": float(a.max()), "rs": float(b.max()), "rp": float((a + b).max()), "ks": float(c.max()),
            "gamma": float(np.sqrt(a ** 2 + b ** 2 + c ** 2).max())}, (K, S, T, a, b, c)


def evaluate(s: Scenario, t_op_years: float, wts: Weights) -> dict:
    fam = family(s, t_op_years)
    w, P0 = fam["w"], fam["P0"]
    w_y = w * UNITS_PER_YEAR
    wp, wt, wu = WP(w_y, wts.M, wts.wB), wt_weight(fam, wts.delta), 1 / wts.ks_max
    meas, (K, S, T, a, b, c) = _measures(s, w, P0, wp, wt, wu)
    members = []
    for m in fam["members"]:
        _, Sk, _ = loop_parts(s, w, m["P"])
        v, re_max = stable(s, fq._fit(m["key"], m["t_op"]))
        members.append({"year": m["year"], "nominal": m["nominal"], "verdict": v, "max_re_per_yr": re_max,
                        "S_db": (20 * np.log10(np.abs(Sk))).round(3).tolist(),
                        "P_db": (20 * np.log10(np.abs(m["P"]))).round(3).tolist()})
    db = lambda z: (20 * np.log10(np.maximum(np.abs(z), 1e-300))).round(3).tolist()
    return {
        "t_op_years": t_op_years, "gains": {"kp": s.kp, "ki": s.ki, "kd": s.kd, "tau_d": s.tau_d},
        "weights": {"M": wts.M, "wB": wts.wB, "delta": wts.delta, "ks_max": wts.ks_max},
        "w": w_y.tolist(), "cycle_yr": (2 * np.pi / w_y).tolist(),
        "S_db": db(S), "T_db": db(T), "KS_db": db(K * S),
        "inv_WP_db": db(1 / wp), "inv_WT_db": db(1 / wt), "WT": np.round(wt, 5).tolist(),
        "mu": {"np": a.round(5).tolist(), "rs": b.round(5).tolist(), "rp": (a + b).round(5).tolist(), "ks": c.round(5).tolist()},
        "peaks": meas,
        "family": members,
        "family_stable": sum(m["verdict"] != "unstable" for m in members), "family_n": len(members),
    }


def tune(s: Scenario, t_op_years: float, wts: Weights, method: str, free: str = "ki_kd") -> dict:
    """Fixed-structure PID: method 'hinf' minimises gamma, 'mu' minimises mu_RP (with |W_U K S| <= 1)."""
    fam = family(s, t_op_years)
    w, P0 = fam["w"], fam["P0"]
    w_y = w * UNITS_PER_YEAR
    wp, wt, wu = WP(w_y, wts.M, wts.wB), wt_weight(fam, wts.delta), 1 / wts.ks_max
    fit = fq._fit(fam["members"][0]["key"], fam["members"][0]["t_op"])
    lim = np.array([min(BOUNDS["kp"], KP_MAX), BOUNDS["ki"], BOUNDS["kd"]])
    all3 = free == "all"
    full = lambda x: np.exp(x) if all3 else np.array([s.kp, *np.exp(x)])

    def cost(x):
        k = full(x)
        if (k[1:] > lim[1:]).any() or (all3 and k[0] > lim[0]):
            return 1e3 + float((k / lim).max())
        c = _with(s, k)
        v, re_max = stable(c, fit)
        if v == "unstable":
            return 1e2 + re_max
        m, _ = _measures(c, w, P0, wp, wt, wu)
        return m["gamma"] if method == "hinf" else max(m["rp"], m["ks"])
    starts = [(s.kp, s.ki, s.kd), (0.06, 0.04, 1.5), (0.3, 0.1, 2.0), (0.1, 0.02, 0.5), (1.0, 0.3, 5.0), (0.03, 0.01, 0.2)]
    best = None
    for k0 in starts:
        x0 = np.log(np.maximum(np.array(k0 if all3 else k0[1:], float), 1e-3))
        r = minimize(cost, x0, method="Nelder-Mead", options=dict(xatol=1e-3, fatol=1e-5, maxiter=1500))
        if best is None or r.fun < best.fun:
            best = r
    k = full(best.x)
    c = _with(s, k)
    m, _ = _measures(c, w, P0, wp, wt, wu)
    before, _ = _measures(s, w, P0, wp, wt, wu)
    return {"method": method, "gains": {"kp": round(float(k[0]), 4), "ki": round(float(k[1]), 4), "kd": round(float(k[2]), 4)},
            "objective": float(best.fun), "after": m, "before": before, "verdict": stable(c, fit)[0],
            "free": free, "approx": bool(all3 and abs(k[0] - s.kp) > 1e-6)}
