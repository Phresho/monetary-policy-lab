"""Monetary model: netlist edits, ngspice translation and the steady-state start (backend/monetary)."""
import sys
from pathlib import Path
import numpy as np
import pytest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from monetary import asc, ngspice as ng, netlist as nl, steady

pytestmark = pytest.mark.skipif(not ng.available(), reason="ngspice shared library not found")


def test_default_build_is_the_netlist():
    assert nl.build(nl.Policy()) == nl.read_model()


def test_closed_loop_changes_only_the_rate_source():
    base, closed = nl.read_model(), nl.build(nl.Policy(closed=True))
    diff = [(a, b) for a, b in zip(base, closed) if a != b]
    assert diff == [(nl.R_OPEN, "B§R 0 0 I =if(time<t_start, 0.02, V(n_rate))")]


def test_params_are_evaluated_like_ltspice():
    p = ng.parse_params(nl.read_model())
    assert p["a_n"] == pytest.approx((1 - 0.865 ** 28) / (28 * (1 - 0.865)))
    assert p["nw0"] == pytest.approx((12.3 + 0.25 * 12.6) / 6)
    assert p["k0"] == 33.6 and p["y_ss"] == pytest.approx(0.133)


@pytest.fixture(scope="module")
def open_steady():
    lines = nl.build(nl.Policy(), steady_start=True)
    return lines, steady.steady_start(lines, nl.IC_SIGNALS)


def test_steady_state_integrators_at_rest(open_steady):
    _, s = open_steady
    for name in set(steady.FREE) - steady.OPTIONAL:
        assert abs(s.residual[name]) < 1e-8, name


def test_steady_start_has_no_jumps(open_steady):
    """From the steady start nothing jumps: over the first 5 time units every key signal moves < 1 %, and
    CPI_filtered changes < 0.1 point per 0.1 time unit (the netlist's own start: P 0.13 -> 0.27, CPI up to 260).
    CPI_filtered does drift (7.7 % -> 6.9 % over 5 units): that is the economy's inflation, not a start-up jump."""
    lines, s = open_steady
    short = [".tran 0 5 0 20ms" if l.startswith(".tran") else l for l in lines]
    r = ng.run_lines(short, s.ic_signals, s.override)
    for k in ["I(P)", "I(GDP_real)", "I(L_cons)", "I(Investment)", "I(R_retail)", "I(B_NW)", "I(Exchange_rate)", "V(n_wage)"]:
        v = r[k]
        assert np.abs(v / v[0] - 1).max() < 0.01, k
    # At the operating point P has zero slope, so measured inflation (120*ddt ln P) starts at 0 and reaches the
    # economy's rate in ~0.5 units: CPI_filtered dips 0.18 points in the first 0.1 unit, then moves < 0.08 per 0.1.
    grid = np.arange(0, 5.0001, 0.1)
    step = np.abs(np.diff(np.interp(grid, r["time"], r["I(CPI_filtered)"])))
    assert step[0] < 0.0025 and step[1:].max() < 0.001


def test_closed_loop_steady_state_exists_with_filtered_derivative():
    lines = nl.build(nl.Policy(closed=True, derivative="filtered"), steady_start=True)
    s = steady.steady_start(lines, nl.IC_SIGNALS)
    assert max(abs(s.residual[n]) for n in steady.FREE) < 1e-8  # pi_d included


def test_steady_asc_matches_the_steady_netlist(tmp_path):
    out, s = asc.write(closed=False, out=tmp_path / "m.asc")
    text = out.read_text(encoding="utf-8")
    for value in s.override.values():
        assert f"{value:.10g}" in text
    assert "!.ic" not in text


def test_duplicate_parameter_is_rejected_like_ltspice():
    """SPICE names ignore case: tau_d would redefine the tax rate tau_D (LTspice: 'already defined elsewhere')."""
    with pytest.raises(ValueError, match="defined twice"):
        ng.parse_params(nl.read_model() + [".param tau_d=1"])


def test_filtered_derivative_adds_one_state():
    lines = nl.build(nl.Policy(closed=True, derivative="filtered", tau_d=2.0))
    assert nl.PI_D_LINE in lines and ".param tau_Dfilt=2" in lines
    assert ng.parse_params(lines)["tau_d"] == 0.0  # the tax rate is untouched
