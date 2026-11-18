"""Transfer function between two flows of the circuit (ctrl-click two elements on the circuit map).

Input A, output B, both elements of the netlist. The model is linearised by ngspice's AC analysis at the same moment as
the frequency analysis (frequency.plant_lines: the steady state of the scenario, or its states at a later year), with
the policy rate R as an external source, so the plant is open:
- an extra flow d is pushed into A: a behavioural source gets "+ d" in its expression (I = ... + d, or V = ... + d for a
  behavioural voltage); any other two-node element gets d as a current source in parallel (an extra flow at its nodes);
- every element's current responds; G_AB = dI(B)/dd, and G_Api the response of inflation (I(CPI_filtered)).
Open loop: T = G_AB. Closed loop, with the rule R = K pi (K = C H, frequency.controller and smoothing, the same loop as
in the frequency analysis) and the plant P = dpi/dR:
    R = K (P R + G_Api d)  ->  R = S K G_Api d,  S = 1/(1 - K P) = 1/(1 + L)
    T = G_AB + G_RB S K G_Api,   G_RB = dI(B)/dR (a second AC run, with R excited).
Two special inputs: R itself (an extra rate on top of the rule: T = G_RB S) and the target pi* (R = K (pi - pi*):
T = -G_RB S K). Elements inside the controller (the rule B_PI, its derivative filter and the smoothing R15 C8) are not
part of the plant netlist's signal path in the AC analysis (their time guards are off at t = 0); in closed loop pick
u (the policy rate) instead.

The rational model and the step response come from a vector fit of T (frequency.vector_fit), with its error reported.
"""
from __future__ import annotations
from functools import lru_cache
import re

import numpy as np

from . import frequency as fq, ngspice as ng
from .scenario import Scenario, UNITS_PER_YEAR

RATE, PI, TARGET = "B§R", "I(CPI_filtered)", "B§Target_CPI"
CONTROLLER = {"B_PI", "B§PI_D", "R15", "C8"}
INJ = "n_tfinj"


def _ref(name: str) -> str:
    return name.split("§")[-1]


def _inject(lines: list[str], element: str) -> list[str]:
    """The netlist with an extra flow d = V(INJ) pushed into the element."""
    out = list(lines)
    i = next((k for k, l in enumerate(out) if l.split() and l.split()[0] == element), None)
    if i is None:
        raise KeyError(f"{element} is not in the netlist")
    tok = out[i].split()
    kind = element[0].upper()
    if kind == "B":
        parts = out[i].split(None, 3)
        m = re.match(r"\s*([IV])\s*=\s*(.*)$", parts[3], re.S)
        expr = m.group(2)
        r = re.search(r"\s+Rser=\S+", expr, re.I)
        expr, tail = (expr[:r.start()], expr[r.start():]) if r else (expr, "")
        out[i] = f"{' '.join(parts[:3])} {m.group(1)}=({expr.strip()})+V({INJ}){tail}"
    elif len(tok) >= 3:
        out.insert(i + 1, f"B§tfinj {tok[1]} {tok[2]} I=V({INJ})")
    else:
        raise ValueError(f"{element} cannot take an extra flow")
    return out


def _ac(lines: list[str], ic: dict, override: dict, r0: float, excite: str) -> tuple[np.ndarray, dict, dict]:
    """AC run with either R (excite='rate') or the injection (excite='inj') as the unit source; every vector."""
    text, names, _ = ng.translate(lines, ic, override)
    out = []
    for l in text.splitlines():
        if l.startswith(".ic "):
            for k, v in re.findall(r"v\((\w+)\)=(\S+)", l):
                out += [f"V{k}hold {k}h 0 {v}", f"L{k}hold {k} {k}h {fq.L_HOLD:g}"]
        elif l.startswith(".tran"):
            out += [f"Vrin n_rin 0 DC {r0:.12g}" + (" AC 1" if excite == "rate" else ""), "R_rin n_rin 0 1e12",
                    f"Vtfinj {INJ} 0 DC 0" + (" AC 1" if excite == "inj" else ""), f"R_tfinj {INJ} 0 1e12",
                    f".ac dec {fq.PER_DECADE} {fq.W_MIN / (2 * np.pi):.6g} {fq.W_MAX / (2 * np.pi):.6g}"]
        else:
            out.append(l)
    vec, log = ng._run_text("\n".join(out))
    if "frequency" not in vec:
        raise RuntimeError("AC analysis failed: " + " | ".join(log))
    return 2 * np.pi * np.real(vec["frequency"]), vec, names


def _read(vec: dict, names: dict, element: str) -> np.ndarray:
    k = names.get(f"I({_ref(element)})")
    if k is None:
        raise KeyError(f"no current for {element}")
    if k == "zero":
        return np.zeros(len(vec["frequency"]), dtype=complex)
    k = k.lower()
    if k.startswith("i(") and k not in vec:
        k = k[2:-1] + "#branch"
    if k.startswith("v(") and k not in vec:
        k = k[2:-1]
    return np.asarray(vec[k], dtype=complex)


@lru_cache(maxsize=48)
def _responses(key: str, t_op: float, element: str) -> dict:
    """Responses of every element's current to a unit extra flow into element (or to R for element=RATE)."""
    s = Scenario.model_validate_json(key)
    lines, ic, override, r0 = fq.plant_lines(s, t_op)
    if element == RATE:
        w, vec, names = _ac(lines, ic, override, r0, "rate")
    else:
        w, vec, names = _ac(_inject(lines, element), ic, override, r0, "inj")
    resp = {}
    for trace in names:
        try:
            resp[trace] = _read(vec, names, trace[2:-1])
        except KeyError:
            pass
    return {"w": w, "resp": resp}


def _response_of(r: dict, element: str) -> np.ndarray:
    k = f"I({_ref(element)})"
    if k not in r["resp"]:
        raise KeyError(f"no current for {element}")
    return r["resp"][k]


def _step(fit: dict, years: np.ndarray) -> np.ndarray:
    A, B, C, D = fit["A"], fit["B"], fit["C"], fit["D"]
    y = fq.step_response(A, B, np.vstack([C]), years * UNITS_PER_YEAR)[:, 0]
    return y + D


def transfer(s: Scenario, inp: str, out: str, closed: bool, t_op_years: float = 0.0) -> dict:
    t_op = round(float(t_op_years) * UNITS_PER_YEAR, 3)
    key = fq._plant_key(s, t_op).model_dump_json()
    if closed and (inp in CONTROLLER or out in CONTROLLER):
        raise ValueError("Inside the controller the AC model has no signal path. In closed loop pick u (the policy rate) instead.")
    rate = _responses(key, t_op, RATE)
    w = rate["w"]
    if inp == RATE:
        G_AB = _response_of(rate, out)
    else:
        inj = _responses(key, t_op, inp)
        G_AB = _response_of(inj, out)
    note = ""
    if closed:
        P = _response_of(rate, "CPI_filtered")
        K = fq.controller(s, w) * fq.smoothing(w)
        S = 1 / (1 - K * P)
        G_RB = _response_of(rate, out)
        if inp == RATE:
            T = G_RB * S
            note = "Extra rate on top of the rule: T = G(R→out)·S."
        elif inp == TARGET:
            T = -G_RB * S * K
            note = "The target enters the rule: T = −G(R→out)·S·K."
        else:
            G_Api = _response_of(inj, "CPI_filtered")
            T = G_AB + G_RB * S * K * G_Api
            note = "T = G(in→out) + G(R→out)·S·K·G(in→π): the direct path plus the rule's answer to the inflation it causes."
    else:
        T = G_AB
        if inp == TARGET:
            note = "Open loop: the target only acts through the rule, so the response is zero."
    y = UNITS_PER_YEAR
    mag = np.abs(T)
    res = {"input": inp, "output": out, "closed": closed, "t_op_years": t_op_years, "note": note,
           "w": (w * y).tolist(), "cycle_yr": (2 * np.pi / (w * y)).tolist(),
           "mag_db": (20 * np.log10(np.maximum(mag, 1e-300))).round(3).tolist(),
           "phase_deg": np.degrees(np.unwrap(np.angle(T))).round(2).tolist(),
           "dc_gain": float(np.real(T[0])), "zero": bool(mag.max() < 1e-12)}
    if res["zero"]:
        res.update(fit=None, poles=[], zeros=[], step=None)
        return res
    best = None
    for n in range(4, 33, 4):
        f = fq.vector_fit(w, T, n)
        if best is None or f["rel_rms"] < best["rel_rms"]:
            best = f
        if f["rel_rms"] < 0.005:
            break
    poles = best["poles"]
    # zeros of the fit: eigenvalues of A - B C / D (D != 0), else the finite zeros from the numerator polynomial
    zeros = np.array([])
    try:
        if abs(best["D"]) > 1e-12 * max(1.0, float(np.abs(best["C"]).max())):
            zeros = np.linalg.eigvals(best["A"] - np.outer(best["B"], best["C"]) / best["D"])
    except np.linalg.LinAlgError:
        pass

    def info(z):
        z = z[np.argsort(-z.real)]
        return [{"re": float(a.real * y), "im": float(a.imag * y),
                 "cycle_yr": float(2 * np.pi / abs(a.imag * y)) if abs(a.imag) > 1e-12 else None} for a in z]
    years = np.linspace(0, 12, 721)
    verdict, _ = fq._verdict(poles * y)   # slow real growth modes of the economy count as drift, not instability
    step = None
    if best["rel_rms"] < 0.05 and verdict != "unstable":
        with np.errstate(all="ignore"):
            yy = _step(best, years)
        if np.isfinite(yy).all():
            step = {"years": years.tolist(), "y": yy.tolist()}
    res.update(fit={"order": len(poles), "rel_rms_pct": float(best["rel_rms"] * 100)},
               poles=info(poles), zeros=info(zeros), verdict=verdict, step=step)
    return res
