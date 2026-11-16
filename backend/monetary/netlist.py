"""Builds run netlists from the unchanged LTspice model (model/Model_Bank_20261111_bank.net).

The model file is never edited. Each option replaces exact, asserted lines, so a change in the source netlist
fails loudly instead of silently altering the run (same approach as backend/housing/netlist.py).
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import re

MODEL = Path(__file__).resolve().parents[2] / "model" / "Model_Bank_20261111_bank.net"
# Start values of idt() that read a signal: CPI_filtered starts at I(CPI), which is pi_bar while time < 0.1.
IC_SIGNALS = {"I(CPI)": 0.02}

R_OPEN = "B§R 0 0 I =if(time<400, 0.02, 0.025)"
PI_OLD = ("B_PI n_pi 0 V =max(-0.005,R_star+ Kp*(I(CPI_filtered)-I(Target_CPI))"
          "+limit(Ki*idt((I(CPI_filtered)-I(Target_CPI))*(time>t_start)), -0.03, 0.03)"
          "+limit(Kd*I(CPI_filtered)-I(Target_CPI)*(time>t_start), -0.02, 0.02))")


def read_model(path: Path = MODEL) -> list[str]:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")


def write_netlist(lines: list[str], path: Path) -> None:
    path.write_text("\n".join(lines), encoding="utf-8")


def _index(lines: list[str], prefix: str) -> int:
    hits = [i for i, line in enumerate(lines) if line.startswith(prefix)]
    if len(hits) != 1:
        raise ValueError(f"expected one line starting {prefix!r}, found {len(hits)}")
    return hits[0]


def _replace(lines: list[str], old: str, new: str) -> None:
    i = _index(lines, old.split(" ")[0] + " ")
    if lines[i] != old:
        raise ValueError(f"{old.split()[0]} changed in the model: {lines[i]!r}")
    lines[i] = new


def set_param(lines: list[str], name: str, value: float) -> None:
    """Change one .param value in place (name=value inside a .param line, case-insensitive)."""
    pat = re.compile(rf"(?<![\w])({re.escape(name)}\s*=\s*)(\{{[^}}]*\}}|\S+)", re.I)
    hits = [i for i, l in enumerate(lines) if l.lower().startswith(".param") and pat.search(l)]
    if len(hits) != 1:
        raise ValueError(f"expected parameter {name} once, found {len(hits)}")
    i = hits[0]
    lines[i] = pat.sub(lambda m: f"{m.group(1)}{value:.10g}", lines[i], count=1)


@dataclass(frozen=True)
class Policy:
    closed: bool = False           # False: the netlist's exogenous rate path (0.02, 0.025 from t = 400)
    kp: float | None = None        # None: the netlist's value
    ki: float | None = None
    kd: float | None = None
    # "netlist": the expression as written (Kd multiplies the level of CPI_filtered, the t_start gate only the target).
    # "filtered": Kd * s/(1 + s*tau_d) on the error, from t_start: D = Kd*(e - x)/tau_Dfilt with x' = (e - x)/tau_Dfilt, the
    # filter state x in an extra element B§PI_D. A raw derivative (ddt, or the exact d CPI_filtered/dt) closes an
    # algebraic loop: n_pi -> dR/dt -> capacitor currents -> d ln P/dt -> CPI -> n_pi in the same instant; LTspice's
    # time step collapsed at t_start (t = 120.108, steps of 1.7e-13 s) with both.
    derivative: str = "netlist"
    tau_d: float = 1.0             # derivative filter time constant (time units), "filtered" only


def set_policy(lines: list[str], p: Policy) -> None:
    """Open loop: B§R as in the netlist. Closed loop: B§R follows the smoothed policy rate V(n_rate) from t_start on
    (before t_start the netlist's 0.02)."""
    if p.closed:
        _replace(lines, R_OPEN, "B§R 0 0 I =if(time<t_start, 0.02, V(n_rate))")
    for name, value in (("Kp", p.kp), ("Ki", p.ki), ("Kd", p.kd)):
        if value is not None:
            set_param(lines, name, value)
    if p.derivative == "filtered":
        new = PI_OLD.replace("limit(Kd*I(CPI_filtered)-I(Target_CPI)*(time>t_start), -0.02, 0.02)",
                             "limit(Kd*(I(CPI_filtered)-I(Target_CPI)-I(PI_D))/tau_Dfilt*(time>t_start), -0.02, 0.02)")
        _replace(lines, PI_OLD, new)
        i = _index(lines, "B_PI ")
        lines.insert(i + 1, PI_D_LINE)
        j = next(k for k, l in enumerate(lines) if l.lower().startswith(".param") and "kp=" in l.lower())
        lines.insert(j + 1, f".param tau_Dfilt={p.tau_d:.10g}")
    elif p.derivative != "netlist":
        raise ValueError(f"derivative: {p.derivative!r}")


PI_D_LINE = "B§PI_D 0 0 I=idt((I(CPI_filtered)-I(Target_CPI)-I(PI_D))/tau_Dfilt)"  # derivative filter state x
SAVINGS_OLD = "B§Savings_Account_Balance 0 0 I= IF(time < 0.0001, 0, q_S0 + idt(I(Deposit)))"
CPI_OLD = "B§CPI 0 0 I = IF(time<0.1, pi_bar, 120*ddt(ln(max(I(P),1m))))"
CPIF_OLD = "B§CPI_filtered 0 0 I = if(time<2,0.02,idt((I(CPI) - I(CPI_filtered)) / {tau}, I(CPI)))"


def set_steady_start(lines: list[str], closed: bool) -> None:
    """Remove the start-up aids that only make sense for the netlist's own start (see steady.py):
    the .ic lines, and the time guards that hold the savings balance at 0 (t < 1e-4), CPI at pi_bar (t < 0.1) and
    CPI_filtered at 0.02 (t < 2). From an equilibrium start these guards are what makes the economy jump.
    Closed loop: B§R follows V(n_rate) from t = 0 (no hand-over jump at t_start; the integral term in B_PI still
    starts at t_start)."""
    lines[:] = [l for l in lines if not l.lower().startswith(".ic")]
    _replace(lines, SAVINGS_OLD, "B§Savings_Account_Balance 0 0 I= q_S0 + idt(I(Deposit))")
    _replace(lines, CPI_OLD, "B§CPI 0 0 I = 120*ddt(ln(max(I(P),1m)))")
    _replace(lines, CPIF_OLD, "B§CPI_filtered 0 0 I = idt((I(CPI) - I(CPI_filtered)) / {tau}, I(CPI))")
    if closed:
        i = _index(lines, "B§R 0 0 ")
        lines[i] = "B§R 0 0 I =V(n_rate)"


def set_idt_start(lines: list[str], element: str, value: float) -> None:
    """Write `value` as the start value of the idt() in `element` (LTspice syntax: idt(x, start)), so a netlist can
    carry a solved steady state for LTspice itself."""
    from .ngspice import _split_args
    hits = [i for i, l in enumerate(lines) if l.split(" ", 1)[0].split("§")[-1].lower() == element.lower()]
    if len(hits) != 1:
        raise ValueError(f"expected element {element} once, found {len(hits)}")
    i = hits[0]
    m = list(re.finditer(r"(?<![A-Za-z0-9_])idt\s*\(", lines[i], re.I))
    if len(m) != 1:
        raise ValueError(f"{element}: expected one idt(), found {len(m)}")
    args, end = _split_args(lines[i], m[0].end() - 1)
    lines[i] = lines[i][:m[0].start()] + f"idt({args[0]},{value:.10g})" + lines[i][end:]


def with_start(lines: list[str], override: dict[str, float], ic_signals: dict[str, float]) -> list[str]:
    """LTspice netlist with the solved start values written into the idt() calls (see steady.py)."""
    out = list(lines)
    for element, value in override.items():
        set_idt_start(out, element, value)
    for signal, value in ic_signals.items():  # idt(..., I(CPI)) -> idt(..., value)
        out = [re.sub(rf"(idt\(.*,\s*){re.escape(signal)}\)", lambda m: f"{m.group(1)}{value:.10g})", l) for l in out]
    return out


def build(p: Policy, steady_start: bool = False) -> list[str]:
    lines = read_model()
    set_policy(lines, p)
    if steady_start:
        set_steady_start(lines, p.closed)
    return lines
