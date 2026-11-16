"""Frequency-domain analysis of the policy loop, from ngspice's AC analysis of the run netlist.

Plant P(s): policy rate R -> inflation (CPI_filtered), linearised by ngspice at a chosen moment of the scenario
(every behavioural source is linearised automatically; nothing is derived by hand):
- t = 0: the steady state of the scenario (steady.py);
- t > 0: the integrator states of the scenario's own simulation at that time. The economy grows, so the plant
  changes: at 0.1 rad per time unit the gain R -> inflation falls from 111 to 80 over 2.5 years (checked against
  transient runs with a small sine on R: first cycle 112 vs AC 111; the same gain for amplitudes 1e-4 and 2e-5).
The integrator states are held for the DC operating point by a voltage source behind a 1e12 H inductor: a short
at DC, open above ~1e-6 rad per time unit, so in the analysed band (from 1e-4) the integrators integrate. The netlist
is always the steady-start version (no start-up time guards: in an AC analysis time = 0, and a guard such as
if(time<2, 0.02, ...) would cut the signal path).

Loop (negative feedback), e = pi - pi*:
    R = H(s) C(s) e,  C(s) = Kp + Ki/s + Kd s/(1 + s tau_d),  H(s) = 1/(1 + s R15 C8)   (rate smoothing, 207 units)
    pi = P(s) R   ->   L(s) = -P(s) H(s) C(s);   S = 1/(1 + L),  T = L/(1 + L)
Ki and Kd are taken as active (after t_start) and the limit()/max() bounds of B_PI as not reached.

Poles: ngspice's .pz cannot handle this circuit ("input signal is shorted"), so P is fitted with a rational model
(vector fitting, Gustavsen & Semlyen 1999) to the exact AC response. Unstable poles are kept (not flipped), so an
unstable plant shows up. The closed-loop poles are the eigenvalues of fitted P + H + C in state-space form. The fit
error is reported with every result.
"""
from __future__ import annotations
from functools import lru_cache
import json
import re

import numpy as np
import scipy.linalg as sl

from . import netlist as nl, ngspice as ng, steady
from .scenario import Scenario, UNITS_PER_YEAR, build

W_MIN, W_MAX, PER_DECADE = 1e-4, 10.0, 40
# A real closed-loop pole with 0 < Re < DRIFT_PER_YEAR doubles in more than ln 2 / 0.1 = 7 years: the slow growth modes
# of the economy (the plant has two of them, +0.021 and +0.006 per year at the steady state), which inflation
# feedback does not remove. Reported as drift, not as an unstable policy loop.
DRIFT_PER_YEAR = 0.1
L_HOLD = 1e12
RC_RATE = 207.0 * 1.0   # R15 * C8 in the netlist
OUTPUT = "I(CPI_filtered)"
OTHER = {"I(GDP_real)": "Real GDP", "I(Investment)": "Investment", "I(L_cons)": "Consumption",
         "I(R_retail)": "Retail loan rate", "I(Exchange_rate)": "Exchange rate", "I(CPI)": "Inflation, instantaneous"}


# ---------------------------------------------------------------- plant: AC analysis at the chosen moment
@lru_cache(maxsize=32)
def _steady(key: str) -> steady.Steady:
    return steady.steady_start(json.loads(key), nl.IC_SIGNALS)


@lru_cache(maxsize=8)
def _run_states(key: str) -> dict:
    """The scenario's own simulation with the integrator states (for linearising at t > 0)."""
    s = Scenario.model_validate_json(key)
    lines = build(s)
    if s.steady_start:
        st = _steady(json.dumps(lines))
        return ng.run_lines(lines, st.ic_signals, st.override, states=True)
    return ng.run_lines(lines, nl.IC_SIGNALS, states=True)


def _plant_key(s: Scenario, t_op: float) -> Scenario:
    """Fields that do not change the plant are reset, so the cache is shared and moving a slider that does not
    change the plant re-plots at once. Open loop: no gain matters. Closed loop at the steady state (t = 0): only Kp
    (with R* and the target) sets the rate level there; Ki and Kd do not act at rest. Later moments depend on the
    whole trajectory, so on every gain."""
    upd = {"name": ""}
    if not s.closed:
        upd.update(kp=0.0, ki=0.0, kd=0.0, tau_d=1.0, derivative="filtered")
    elif t_op <= 0:
        upd.update(ki=0.0, kd=0.0, tau_d=1.0, derivative="filtered")
    return s.model_copy(update=upd)


def plant_lines(s: Scenario, t_op: float) -> tuple[list[str], dict, dict, float]:
    """Steady-start netlist with R as external input V(n_rin); start values (ic_signals, override) of the moment
    t_op (time units) and the rate level R there."""
    lines = build(s.model_copy(update={"steady_start": True}))
    st = _steady(json.dumps(lines))
    if t_op <= 0:
        override, ic = dict(st.override), st.ic_signals
        if s.closed:
            vec, _ = steady._op(lines, st.ic_signals, st.override)
            r0 = float(np.ravel(vec["n_rate"])[0])
        else:
            r0 = s.rate_pct / 100
    else:
        run = _run_states(s.model_dump_json())
        t = run["time"]
        override = {k: float(np.interp(t_op, t, v)) for k, v in run["states"].items()}
        ic = st.ic_signals
        r0 = float(np.interp(t_op, t, run["I(R)"]))
    i = nl._index(lines, "B§R 0 0 ")
    lines[i] = "B§R 0 0 I =V(n_rin)"
    return lines, ic, override, r0


def ac_text(lines: list[str], ic: dict, override: dict, r0: float, outputs: list[str]) -> tuple[str, dict[str, str]]:
    text, names, _ = ng.translate(lines, ic, override)
    out = []
    for l in text.splitlines():
        if l.startswith(".ic "):
            for k, v in re.findall(r"v\((\w+)\)=(\S+)", l):
                out += [f"V{k}hold {k}h 0 {v}", f"L{k}hold {k} {k}h {L_HOLD:g}"]
        elif l.startswith(".tran"):
            out += [f"Vrin n_rin 0 DC {r0:.12g} AC 1", "R_rin n_rin 0 1e12",
                    f".ac dec {PER_DECADE} {W_MIN / (2 * np.pi):.6g} {W_MAX / (2 * np.pi):.6g}"]
        else:
            out.append(l)
    return "\n".join(out), {k: names[k] for k in outputs}


@lru_cache(maxsize=32)
def _plant(key: str, t_op: float) -> dict:
    s = Scenario.model_validate_json(key)
    lines, ic, override, r0 = plant_lines(s, t_op)
    text, names = ac_text(lines, ic, override, r0, [OUTPUT, *OTHER])
    vec, log = ng._run_text(text)
    if "frequency" not in vec:
        raise RuntimeError("AC analysis failed: " + " | ".join(log))
    resp = {}
    for trace, v in names.items():
        k = v.lower()
        if k.startswith("i(") and k not in vec:
            k = k[2:-1] + "#branch"
        if k.startswith("v(") and k not in vec:
            k = k[2:-1]
        resp[trace] = np.asarray(vec[k], dtype=complex)
    return {"w": 2 * np.pi * np.real(vec["frequency"]), "resp": resp, "r0": r0}


def plant(s: Scenario, t_op: float = 0.0) -> dict:
    """{w: rad per time unit, resp: {trace: response per unit of R}, r0}."""
    t_op = round(float(t_op), 3)
    return _plant(_plant_key(s, t_op).model_dump_json(), t_op)


# ---------------------------------------------------------------- controller and loop
def controller(s: Scenario, w: np.ndarray) -> np.ndarray:
    jw = 1j * w
    d = s.kd * jw / (1 + jw * s.tau_d) if s.derivative == "filtered" else s.kd  # "netlist": Kd times the level
    return s.kp + s.ki / jw + d


def smoothing(w: np.ndarray) -> np.ndarray:
    return 1 / (1 + 1j * w * RC_RATE)


def _crossings(x: np.ndarray, y: np.ndarray) -> list[int]:
    return [i for i in range(len(y) - 1) if (y[i] > 0) != (y[i + 1] > 0)]


def margins(w: np.ndarray, L: np.ndarray) -> dict:
    """Gain and phase margins from the exact loop response; every crossing is listed, the worst is reported."""
    mag, ph = np.abs(L), np.angle(L)
    pms = []
    for i in _crossings(w, np.log(mag)):
        f = np.log(mag[i]) / (np.log(mag[i]) - np.log(mag[i + 1]))
        wc = w[i] * (w[i + 1] / w[i]) ** f
        Lc = L[i] + f * (L[i + 1] - L[i])
        pms.append({"w": wc, "pm_deg": float(np.degrees(np.angle(-Lc)))})  # angle from -1
    gms = []
    for i in _crossings(w, L.imag):
        if L.real[i] < 0:
            f = L.imag[i] / (L.imag[i] - L.imag[i + 1])
            Lg = L[i] + f * (L[i + 1] - L[i])
            gms.append({"w": w[i] * (w[i + 1] / w[i]) ** f, "gm_db": float(-20 * np.log10(abs(Lg)))})
    pm = min(pms, key=lambda p: p["pm_deg"]) if pms else None
    gm = min(gms, key=lambda g: g["gm_db"]) if gms else None
    S = 1 / (1 + L)
    k = int(np.argmax(np.abs(S)))
    return {"pm": pm, "gm": gm, "crossovers": pms, "phase_crossovers": gms,
            "ms": float(np.abs(S[k])), "ms_w": float(w[k])}


# ---------------------------------------------------------------- vector fitting
def _basis(s: np.ndarray, poles: np.ndarray) -> np.ndarray:
    """Real-coefficient basis: a real pole gives 1/(s-a); a pair (a, a*) gives 1/(s-a)+1/(s-a*), j/(s-a)-j/(s-a*)."""
    cols, i = [], 0
    while i < len(poles):
        a = poles[i]
        if abs(a.imag) < 1e-12 * max(1, abs(a)):
            cols.append(1 / (s - a.real)); i += 1
        else:
            cols += [1 / (s - a) + 1 / (s - a.conjugate()), 1j / (s - a) - 1j / (s - a.conjugate())]; i += 2
    return np.column_stack(cols)


def _ss_blocks(poles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """A and b of the real form matching _basis: C (sI - A)^-1 b reproduces the basis with coefficients C."""
    n = len(poles); A = np.zeros((n, n)); b = np.zeros(n); i = 0
    while i < n:
        a = poles[i]
        if abs(a.imag) < 1e-12 * max(1, abs(a)):
            A[i, i] = a.real; b[i] = 1; i += 1
        else:
            A[i:i + 2, i:i + 2] = [[a.real, a.imag], [-a.imag, a.real]]; b[i] = 2; i += 2
    return A, b


def _pairs(p: np.ndarray) -> np.ndarray:
    """Order poles as real ones, then (a, a*) pairs with Im a > 0."""
    real = np.sort(p[np.abs(p.imag) < 1e-9 * np.maximum(1, np.abs(p))].real).astype(complex)
    cplx = p[p.imag >= 1e-9 * np.maximum(1, np.abs(p))]
    return np.concatenate([real] + [[a, a.conjugate()] for a in sorted(cplx, key=lambda a: abs(a))])


def vector_fit(w: np.ndarray, f: np.ndarray, n: int, iters: int = 30) -> dict:
    """f(jw) ~ sum r_i/(s - a_i) + d, relative weighting. Poles are not forced stable."""
    s = 1j * w
    beta = np.logspace(np.log10(w[0]), np.log10(w[-1]), n // 2)
    poles = np.concatenate([[-b / 100 + 1j * b, -b / 100 - 1j * b] for b in beta])
    if n % 2:
        poles = np.concatenate([[-w[0]], poles])
    wt = 1 / np.abs(f)
    for _ in range(iters):
        Phi = _basis(s, poles)
        M = np.column_stack([Phi, np.ones_like(s), -f[:, None] * Phi]) * wt[:, None]
        rhs = f * wt
        x = np.linalg.lstsq(np.vstack([M.real, M.imag]), np.concatenate([rhs.real, rhs.imag]), rcond=None)[0]
        c = x[Phi.shape[1] + 1:]
        A, b = _ss_blocks(poles)
        new = _pairs(np.linalg.eigvals(A - np.outer(b, c)))
        if len(new) != len(poles):
            break
        poles = new
    Phi = _basis(s, poles)
    M = np.column_stack([Phi, np.ones_like(s)]) * wt[:, None]
    x = np.linalg.lstsq(np.vstack([M.real, M.imag]), np.concatenate([(f * wt).real, (f * wt).imag]), rcond=None)[0]
    A, b = _ss_blocks(poles)
    C, d = x[:-1], x[-1]
    model = Phi @ C + d
    err = float(np.sqrt(np.mean(np.abs(model / f - 1) ** 2)))
    return {"A": A, "B": b, "C": C, "D": d, "poles": poles, "rel_rms": err, "model": model}


@lru_cache(maxsize=32)
def _fit(key: str, t_op: float) -> dict:
    p = _plant(key, t_op)
    w, f = p["w"], p["resp"][OUTPUT]
    best = None
    for n in range(8, 41, 4):
        fit = vector_fit(w, f, n)
        if best is None or fit["rel_rms"] < best["rel_rms"]:
            best = fit
        if fit["rel_rms"] < 0.005:
            break
    return best


# ---------------------------------------------------------------- closed loop from the fitted plant
def closed_loop(s: Scenario, fit: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """A, B (input: target pi*), C rows (pi, R) of the closed loop: P (fit) + H + C(s), in time units."""
    Ap, Bp, Cp, Dp = fit["A"], fit["B"], fit["C"], fit["D"]
    n = len(Ap)
    filt = s.derivative == "filtered" and s.kd > 0
    m = n + 2 + (1 if filt else 0)   # x_p, x_h (smoothed rate = R), x_i (integral), [x_d]
    ih, ii, idd = n, n + 1, n + 2
    A = np.zeros((m, m)); B = np.zeros(m)
    # e = Cp x_p + Dp R - r,   R = x_h
    e_row = np.zeros(m); e_row[:n] = Cp; e_row[ih] = Dp
    kp = s.kp + (0 if s.derivative == "filtered" else s.kd)  # "netlist": Kd on the level, adds to Kp
    u_row = kp * e_row; u_r = -kp
    u_row = u_row.copy(); u_row[ii] += s.ki
    if filt:
        u_row = u_row + s.kd / s.tau_d * e_row; u_row[idd] -= s.kd / s.tau_d; u_r -= s.kd / s.tau_d
    A[:n, :n] = Ap; A[:n, ih] = Bp
    A[ih] = u_row / RC_RATE; A[ih, ih] -= 1 / RC_RATE; B[ih] = u_r / RC_RATE
    A[ii] = e_row; B[ii] = -1
    if filt:
        A[idd] = e_row / s.tau_d; A[idd, idd] -= 1 / s.tau_d; B[idd] = -1 / s.tau_d
    Cout = np.vstack([e_row, np.eye(m)[ih]])  # inflation deviation pi = Cp x_p + Dp R (e = pi - r), R
    return A, B, Cout, np.array([Dp * 0, 0.0])


def step_response(A, B, Cout, t: np.ndarray) -> np.ndarray:
    """Response to a unit step of the target at t = 0 (zero-order hold on the grid)."""
    dt = t[1] - t[0]
    m = len(A)
    M = sl.expm(np.block([[A, B[:, None]], [np.zeros((1, m + 1))]]) * dt)
    Ad, Bd = M[:m, :m], M[:m, m]
    x = np.zeros(m); y = np.zeros((len(t), Cout.shape[0]))
    for k in range(len(t)):
        y[k] = Cout @ x
        x = Ad @ x + Bd
    return y


# ---------------------------------------------------------------- everything the page needs
def analyze(s: Scenario, t_op_years: float = 0.0) -> dict:
    t_op = round(float(t_op_years) * UNITS_PER_YEAR, 3)
    key = _plant_key(s, t_op).model_dump_json()
    p = _plant(key, t_op)
    w, P = p["w"], p["resp"][OUTPUT]
    C, H = controller(s, w), smoothing(w)
    L = -P * H * C
    S, T = 1 / (1 + L), L / (1 + L)
    fit = _fit(key, t_op)
    A, B, Cout, _ = closed_loop(s, fit)
    cl = np.linalg.eigvals(A)
    ol = fit["poles"]
    yrs = np.linspace(0, 12, 1441)
    step = step_response(A, B, Cout, yrs * UNITS_PER_YEAR)
    cl_y = cl * UNITS_PER_YEAR
    fast_unstable = (cl_y.real > 1e-9) & ((np.abs(cl_y.imag) > 1e-9) | (cl_y.real >= DRIFT_PER_YEAR))
    drift = (cl_y.real > 1e-9) & ~fast_unstable
    verdict = "unstable" if fast_unstable.any() else ("drift" if drift.any() else "stable")
    y = UNITS_PER_YEAR

    def bode(z):
        return {"mag_db": (20 * np.log10(np.abs(z))).round(3).tolist(), "phase_deg": np.degrees(np.unwrap(np.angle(z))).round(2).tolist()}

    def poles(z):
        z = z[np.argsort(-z.real)]
        return [{"re": float(a.real * y), "im": float(a.imag * y),
                 "cycle_yr": float(2 * np.pi / abs(a.imag * y)) if abs(a.imag) > 1e-12 else None,
                 "half_life_yr": float(np.log(2) / abs(a.real * y)) if a.real < -1e-15 else None} for a in z]

    mg = margins(w, L)
    for item in [*mg["crossovers"], *mg["phase_crossovers"]]:  # pm and gm are among these (same objects)
        item["w"] = item["w"] * y
        item["cycle_yr"] = 2 * np.pi / item["w"]
    mg["ms_w"] *= y
    return {
        "t_op_years": t_op_years, "rate_at_op_pct": p["r0"] * 100,
        "w": (w * y).tolist(), "cycle_yr": (2 * np.pi / (w * y)).tolist(),
        "plant": bode(P), "controller": bode(C * H), "loop": bode(L),
        "S_db": (20 * np.log10(np.abs(S))).round(3).tolist(), "T_db": (20 * np.log10(np.abs(T))).round(3).tolist(),
        "nyquist": {"re": L.real.tolist(), "im": L.imag.tolist()},
        "others": {k: {"label": lab, **bode(p["resp"][k])} for k, lab in OTHER.items()},
        "margins": mg,
        "fit": {"order": len(ol), "rel_rms_pct": fit["rel_rms"] * 100, "plant_db": (20 * np.log10(np.abs(fit["model"]))).round(3).tolist()},
        "open_poles": poles(ol), "closed_poles": poles(cl), "verdict": verdict,
        "drift_doubling_yr": [float(np.log(2) / a.real) for a in cl_y[drift]],
        "unstable_open": int(np.sum(ol.real > 1e-9)),
        "step": {"years": yrs.tolist(), "inflation": step[:, 0].tolist(), "rate": step[:, 1].tolist()},
    }
