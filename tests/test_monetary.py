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


# ---------------------------------------------------------------- frequency analysis
from monetary import frequency as fr
from monetary.scenario import Scenario


def test_ac_response_matches_a_sine_in_the_simulation():
    """Rate R = r0 + a sin(w t): inflation amplitude and phase in the second cycle against the AC response at t = 0.
    Not the first cycle (it still holds the transient of switching the sine on: 5 degrees off), and not later ones
    (the gain drifts down ~10 % per cycle here because the economy grows: 112, 100, 93, ...)."""
    s = Scenario()
    p = fr.plant(s)
    lines, ic, override, r0 = fr.plant_lines(s, 0)
    w, a = 0.1, 1e-4
    T = 2 * np.pi / w

    def run(amp):
        l = [f".tran 0 {2 * T:.6g} 0 0.02" if x.startswith(".tran") else x for x in lines]
        l = [x.replace("B§R 0 0 I =V(n_rin)", f"B§R 0 0 I ={r0}+{amp}*sin({w}*time)") for x in l]
        return ng.run_lines(l, ic, override)
    base, sine = run(0), run(a)
    t = np.linspace(T, 2 * T, 800)
    d = np.interp(t, sine["time"], sine["I(CPI_filtered)"]) - np.interp(t, base["time"], base["I(CPI_filtered)"])
    c = np.linalg.lstsq(np.column_stack([np.sin(w * t), np.cos(w * t), np.ones_like(t), t]), d, rcond=None)[0]
    meas = (c[0] + 1j * c[1]) / a
    ac = np.interp(w, p["w"], p["resp"]["I(CPI_filtered)"].real) + 1j * np.interp(w, p["w"], p["resp"]["I(CPI_filtered)"].imag)
    assert abs(meas) == pytest.approx(abs(ac), rel=0.15)
    assert np.degrees(np.angle(meas / ac)) == pytest.approx(0, abs=3)


def test_netlist_gains_are_unstable_and_tuned_gains_are_not():
    """Matches the simulation: the netlist gains oscillate (inflation std 3.7 points), Kp = Ki = 0.02, Kd = 0 holds
    inflation within 0.01 point of target."""
    bad = fr.analyze(Scenario(closed=True), 0)
    assert bad["verdict"] == "unstable" and bad["margins"]["pm"]["pm_deg"] < 0
    good = fr.analyze(Scenario(closed=True, kp=0.02, ki=0.02, kd=0), 0)
    assert good["verdict"] in ("stable", "drift") and good["margins"]["pm"]["pm_deg"] > 20
    for a in (bad, good):
        assert a["fit"]["rel_rms_pct"] < 1


def test_margins_on_a_known_loop():
    """L = 2/(s (s+1)) : phase margin 38.7 deg at w = 1.25, no phase crossover (gain margin infinite)."""
    w = np.logspace(-2, 2, 4000)
    L = 2 / (1j * w * (1j * w + 1))
    m = fr.margins(w, L)
    assert m["pm"]["pm_deg"] == pytest.approx(38.67, abs=0.05) and m["pm"]["w"] == pytest.approx(1.249, abs=0.002)
    assert m["gm"] is None


def test_vector_fit_recovers_poles_including_an_unstable_one():
    w = np.logspace(-3, 1, 300); s = 1j * w
    f = 1 / (s - 0.01) + (2 + 1j) / (s + 0.5 - 2j) + (2 - 1j) / (s + 0.5 + 2j) + 0.3
    fit = fr.vector_fit(w, f, 3)
    assert fit["rel_rms"] < 1e-6
    got = sorted(fit["poles"], key=lambda p: (p.real, p.imag))
    want = [-0.5 - 2j, -0.5 + 2j, 0.01]
    assert np.allclose(got, want, atol=1e-6)  # the unstable pole at +0.01 is kept, not flipped


# ---------------------------------------------------------------- model map (the drawn schematic)
from collections import defaultdict
from monetary import schematic


def test_drawn_schematic_has_exactly_the_netlist_connectivity():
    """Every netlist node is exactly one connected net of the drawing and no drawn net joins two nodes. This checks
    the pin positions, rotations and mirroring (M270), and the one diagonal wire ((416, 6304) -> (400, 1280))."""
    d = schematic.parse(); net = schematic.nets(d)
    lines = [l for l in nl.read_model() if l and not l.startswith((".", "*")) and l[0] not in "Kk"]
    nodes = {l.split()[0]: l.split()[1:3] for l in lines}
    assert {s["name"] for s in d["symbols"]} == set(nodes)
    node_to_net, net_to_node = defaultdict(set), defaultdict(set)
    for s in d["symbols"]:
        for p, node in zip(s["pins"], nodes[s["name"]]):
            node_to_net[node].add(net[tuple(p)]); net_to_node[net[tuple(p)]].add(node)
    assert all(len(v) == 1 for v in node_to_net.values()), {k: v for k, v in node_to_net.items() if len(v) > 1}
    assert all(len(v) == 1 for v in net_to_node.values())


def test_sectors_and_links():
    m = schematic.model_map()
    for title in ("Central Bank", "Households", "Wholesale banks", "Retail banks", "Fiscal Authority", "Foreign Sector", "Interest Rates"):
        assert title in m["sectors"]
    sector = {e["ref"]: e["sector"] for e in m["elements"]}
    assert sector["B_PI"] == "Central Bank" and sector["Income"] == "Households" and sector["R_retail"] == "Interest Rates"
    pairs = {(l["from"], l["to"], l["kind"]) for l in m["links"]}
    assert ("Retail banks", "Wholesale banks", "flow") in pairs           # the loan chain
    assert ("Central Bank", "Interest Rates", "signal") in pairs          # R feeds the rates
    assert not any("0" in l["via"] for l in m["links"])                   # ground is not a flow


# ---------------------------------------------------------------- flows between sectors and the robustness map
from monetary import flows


def test_sector_flows_balance_at_every_shared_node():
    """Kirchhoff: what the sectors push into a shared node adds up to zero (up to the solver's tolerance)."""
    f = flows.sector_flows(Scenario())
    assert len(f["nodes"]) >= 10 and len(f["years"]) > 40
    for n in f["nodes"]:
        total = np.sum([v for v in n["push"].values()], axis=0)
        scale = max(np.abs(v).max() for v in n["push"].values())
        assert np.abs(total).max() <= 1e-3 * max(scale, 1e-6), n["node"]
    goods = next(n for n in f["nodes"] if n["node"] == "Goods")
    assert goods["push"]["Domestic goods producers"][20] > 0 > goods["push"]["NFC"][20]  # producers deliver goods


def test_sweep_matches_the_full_analysis():
    """The netlist gains are unstable, Kp = Ki = 0.02 with Kd = 0 is stable; the map agrees with analyze()."""
    s = Scenario(closed=True, kp=0.02, ki=0.02, kd=0)
    m = fr.sweep(s, 0, ki_max=0.04, kd_max=1.0, n=5)
    assert m["ki"][2] == pytest.approx(0.02) and m["kd"][0] == 0
    assert m["verdict"][0][2] == fr.analyze(s, 0)["verdict"]
    assert m["ms"][0][2] == pytest.approx(fr.analyze(s, 0)["margins"]["ms"], rel=1e-3)
    bad = Scenario(closed=True)
    mb = fr.sweep(bad, 0, ki_max=bad.ki, kd_max=bad.kd, n=5)
    assert mb["verdict"][-1][-1] == fr.analyze(bad, 0)["verdict"] == "unstable"
