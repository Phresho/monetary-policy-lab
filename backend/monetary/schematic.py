"""The LTspice schematic (.asc) as data for the model map: wires, elements with their pins, the sector boxes and
labels, and which sector every element sits in.

The drawing is the user's own schematic, not a redrawn one. Its connectivity (wires joined at end points and at
T-junctions, pins, named flags) is checked against the netlist in tests/test_monetary.py: every netlist node must be
exactly one connected net of the drawing. That also checks the pin positions and rotations used here.

Symbols are drawn with simple glyphs of our own between the pins (LTspice's symbol files are not copied); the pin
positions are those of LTspice's standard symbols (lib/sym/*.asy).
"""
from __future__ import annotations
from functools import lru_cache
from pathlib import Path
import re

from . import netlist as nl

ASC = nl.MODEL.with_suffix(".asc")
# pins in symbol coordinates, in SpiceOrder (node 1, node 2)
PINS = {
    "res": [(16, 16), (16, 96)], "ind": [(16, 16), (16, 96)], "ind2": [(16, 16), (16, 96)],
    "cap": [(16, 0), (16, 64)], "bi": [(0, 0), (0, 80)], "bi2": [(0, 80), (0, 0)], "current": [(0, 0), (0, 80)],
    "bv": [(0, 16), (0, 96)], "voltage": [(0, 16), (0, 96)],
}
KIND = {"res": "resistor", "ind": "inductor", "ind2": "inductor", "cap": "capacitor", "bi": "behavioural current",
        "bi2": "behavioural current", "current": "current source", "bv": "behavioural voltage", "voltage": "voltage source"}
PREFIX = {"res": "R", "ind": "L", "ind2": "L", "cap": "C", "bi": "B", "bi2": "B", "bv": "B", "current": "I", "voltage": "V"}


def transform(x: int, y: int, rot: str) -> tuple[int, int]:
    """Symbol coordinates -> sheet offset for LTspice orientations R0/R90/R180/R270 and mirrored M0/M90/M180/M270
    (rotate clockwise on screen, then mirror in x; the order that makes the drawn nets match the netlist)."""
    for _ in range(int(rot[1:]) // 90):
        x, y = -y, x
    if rot.startswith("M"):
        x = -x
    return x, y


def _spice_name(symbol: str, inst: str) -> str:
    """LTspice puts the prefix in front with § when the instance name does not start with it (Target_CPI -> B§Target_CPI)."""
    p = PREFIX[symbol]
    return inst if inst.upper().startswith(p) else f"{p}§{inst}"


@lru_cache(maxsize=2)
def parse(path: Path = ASC) -> dict:
    wires, flags, symbols, rects, texts = [], [], [], [], []
    cur = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        t = raw.split()
        if not t:
            continue
        if t[0] == "WIRE":
            wires.append([int(v) for v in t[1:5]])
        elif t[0] == "FLAG":
            flags.append({"x": int(t[1]), "y": int(t[2]), "name": t[3]})
        elif t[0] == "SYMBOL":
            cur = {"symbol": t[1], "x": int(t[2]), "y": int(t[3]), "rot": t[4], "inst": None, "value": ""}
            symbols.append(cur)
        elif t[0] == "SYMATTR" and cur is not None:
            if t[1] == "InstName":
                cur["inst"] = t[2]
            elif t[1] == "Value":
                cur["value"] = raw.split("Value", 1)[1].strip()
        elif t[0] == "RECTANGLE":
            x1, y1, x2, y2 = (int(v) for v in t[2:6])
            rects.append({"x1": min(x1, x2), "y1": min(y1, y2), "x2": max(x1, x2), "y2": max(y1, y2)})
        elif t[0] == "TEXT":
            m = re.match(r"TEXT (-?\d+) (-?\d+) (\w+) (\d+) ([;!])(.*)$", raw)
            if m:
                texts.append({"x": int(m[1]), "y": int(m[2]), "align": m[3], "size": int(m[4]), "directive": m[5] == "!", "text": m[6]})
    for s in symbols:
        s["name"] = _spice_name(s["symbol"], s["inst"])
        s["ref"] = s["name"].split("§")[-1]
        s["kind"] = KIND[s["symbol"]]
        s["pins"] = [[s["x"] + dx, s["y"] + dy] for dx, dy in (transform(px, py, s["rot"]) for px, py in PINS[s["symbol"]])]
    _sectors(rects, texts, symbols)
    return {"wires": wires, "flags": flags, "symbols": symbols, "rects": rects, "texts": texts}


def _inside(r: dict, x: int, y: int, pad: int = 0) -> bool:
    return r["x1"] - pad <= x <= r["x2"] + pad and r["y1"] - pad <= y <= r["y2"] + pad


def _sectors(rects: list[dict], texts: list[dict], symbols: list[dict]) -> None:
    """Title of each box: the largest comment text inside (or on the edge of) it; an element belongs to the smallest
    box that contains its centre."""
    for r in rects:
        inside = [t for t in texts if not t["directive"] and _inside(r, t["x"], t["y"], 40)]
        big = max(inside, key=lambda t: t["size"], default=None)
        # a big title, or a small one when it is the box's only text and the box holds elements ("Interest Rates");
        # the parameter boxes ("Tax rates", ...) hold no elements and stay untitled
        holds = any(_inside(r, s["x"], s["y"]) for s in symbols)
        r["title"] = big["text"].strip() if big and (big["size"] >= 4 or (len(inside) == 1 and holds)) else None
    for s in symbols:
        cx = sum(p[0] for p in s["pins"]) / 2; cy = sum(p[1] for p in s["pins"]) / 2
        boxes = [r for r in rects if r["title"] and _inside(r, cx, cy)]
        s["sector"] = min(boxes, key=lambda r: (r["x2"] - r["x1"]) * (r["y2"] - r["y1"]))["title"] if boxes else None


def nets(d: dict) -> dict[tuple[int, int], int]:
    """Connected net id of every point that matters (pins, wire ends, flags): wires joined at end points and where an
    end point lies on another wire (T-junction), flags with the same name joined, pins joined to what they touch."""
    parent: dict = {}

    def find(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a

    def join(a, b):
        parent[find(a)] = find(b)

    def on(w, p):
        """p on the segment w; wires need not be straight (one runs from (416, 6304) to (400, 1280))."""
        x1, y1, x2, y2 = w
        if not (min(x1, x2) <= p[0] <= max(x1, x2) and min(y1, y2) <= p[1] <= max(y1, y2)):
            return False
        return (x2 - x1) * (p[1] - y1) == (y2 - y1) * (p[0] - x1)
    points = {(w[0], w[1]) for w in d["wires"]} | {(w[2], w[3]) for w in d["wires"]}
    points |= {tuple(p) for s in d["symbols"] for p in s["pins"]} | {(f["x"], f["y"]) for f in d["flags"]}
    for w in d["wires"]:
        a = (w[0], w[1])
        for p in points:
            if on(w, p):
                join(p, a)
    by_name: dict[str, tuple] = {}
    for f in d["flags"]:
        p = (f["x"], f["y"])
        if f["name"] in by_name:
            join(p, by_name[f["name"]])
        by_name[f["name"]] = p
    return {p: find(p) for p in points}


def wire_nodes(d: dict, nodes: dict[str, list[str]]) -> list[str | None]:
    """The netlist node of every drawn wire (through the pins on its net); None for a net without pins."""
    net = nets(d)
    node_of_net = {}
    for s in d["symbols"]:
        for p, node in zip(s["pins"], nodes.get(s["name"], [])):
            node_of_net[net[tuple(p)]] = node
    for f in d["flags"]:
        node_of_net.setdefault(net[(f["x"], f["y"])], f["name"])
    return [node_of_net.get(net[(w[0], w[1])]) for w in d["wires"]]


def links(d: dict, exprs: dict[str, str]) -> list[dict]:
    """Connections between sectors: 'flow' where elements of two sectors share a net (a current flows between them),
    'signal' where an expression in one sector reads I(x) or V(node) of another sector."""
    net = nets(d)
    by_net: dict = {}
    for s in d["symbols"]:
        for p in s["pins"]:
            by_net.setdefault(net[tuple(p)], set()).add(s["name"])
    sector = {s["name"]: s["sector"] for s in d["symbols"]}
    ref_to = {s["ref"].lower(): s["name"] for s in d["symbols"]}
    ground = {net[(f["x"], f["y"])] for f in d["flags"] if f["name"] == "0"}  # the common return, not a flow
    out: dict = {}
    for n, members in by_net.items():
        if n in ground:
            continue
        secs = {sector[m] for m in members if sector[m]}
        for a in secs:
            for b in secs:
                if a < b:
                    out.setdefault((a, b, "flow"), set()).update(m for m in members if sector[m] in (a, b))
    for s in d["symbols"]:
        for ref in re.findall(r"(?<![A-Za-z0-9_])[Ii]\(([^()]+)\)", exprs.get(s["name"], "")):
            other = ref_to.get(ref.strip().lower())
            a, b = s["sector"], sector.get(other)
            if a and b and a != b:
                out.setdefault((b, a, "signal"), set()).add(f"{other} -> {s['name']}")
    return [{"from": a, "to": b, "kind": k, "via": sorted(v)} for (a, b, k), v in sorted(out.items())]


def model_map() -> dict:
    """Everything the front end draws."""
    d = parse()
    lines = nl.read_model()
    exprs = {l.split()[0]: l.split(None, 3)[3] if len(l.split(None, 3)) > 3 else "" for l in lines if l and not l.startswith((".", "*"))}
    nodes = {l.split()[0]: l.split()[1:3] for l in lines if l and not l.startswith((".", "*")) and l[0] not in "Kk"}
    sectors = sorted({r["title"] for r in d["rects"] if r["title"]})
    xs = [v for w in d["wires"] for v in (w[0], w[2])] + [s["x"] for s in d["symbols"]]
    ys = [v for w in d["wires"] for v in (w[1], w[3])] + [s["y"] for s in d["symbols"]]
    return {
        "bounds": [min(xs) - 200, min(ys) - 200, max(xs) + 200, max(ys) + 200],
        "wires": d["wires"],
        "flags": [{**f, "ground": f["name"] == "0"} for f in d["flags"]],
        "rects": d["rects"], "sectors": sectors, "links": links(d, exprs), "flows": agent_flows(),
        "wire_nodes": wire_nodes(d, nodes),
        "texts": [t for t in d["texts"] if not t["directive"]],
        "elements": [{"name": s["name"], "ref": s["ref"], "symbol": s["symbol"], "kind": s["kind"], "rot": s["rot"],
                      "x": s["x"], "y": s["y"], "pins": s["pins"], "sector": s["sector"],
                      "expr": exprs.get(s["name"], s["value"]), "nodes": nodes.get(s["name"], [])}
                     for s in d["symbols"]],
    }


# ---------------------------------------------------------------- flows between agents (for the block diagram)
# Elements drawn outside every box that carry a current between sectors, and the box they belong to.
OUTSIDE_AGENT = {"B_coup_bank": "Wholesale banks", "B§Forein_Cons": "Foreign Sector", "C_NFA": "Foreign Sector", "R14": "Foreign Sector"}
CARRIERS = {"inductor", "behavioural current", "current source"}   # elements whose current is a flow


def _box_of(d: dict, x: float, y: float) -> str | None:
    boxes = [r for r in d["rects"] if r["title"] and _inside(r, x, y)]
    return min(boxes, key=lambda r: (r["x2"] - r["x1"]) * (r["y2"] - r["y1"]))["title"] if boxes else None


@lru_cache(maxsize=1)
def _steady_currents() -> dict[str, float]:
    """I(element) at the steady state of the default scenario (open loop): the operating point, no time steps."""
    from . import ngspice as ng, steady
    from .scenario import Scenario, build
    lines = build(Scenario())
    st = steady.steady_start(lines, nl.IC_SIGNALS)
    text, names, _ = ng.translate(lines, st.ic_signals, st.override)
    vec, _ = ng._run_text(ng.op_text(text))
    tr = ng._traces(vec, names, 1)
    return {k: float(v[0]) for k, v in tr.items() if k.startswith("I(")}


def agent_flows() -> list[dict]:
    """Every flow between two boxes, read from the netlist at the steady state of the default scenario.

    At every node where elements of two or more boxes meet, the hub is the box with the most current-carrying elements
    on it (a box's own bus: hh_bus is the households', N012 the government's); at a tie, the box with the largest net
    current into or out of the node (a market: on N001 the firms' Aggregate_Supply delivers, households, government
    and abroad take). Each element of another box on that node is a flow between that box and the hub, in the direction its
    steady-state current runs. Current-carrying elements are used; a box that touches the node only through a
    resistor (R2, R8 on the loan node N019) gets one flow named after the hub's own element (Retail_loan)."""
    d = parse()
    agent = {s["name"]: s["sector"] or OUTSIDE_AGENT.get(s["name"]) for s in d["symbols"]}
    kind = {s["name"]: s["kind"] for s in d["symbols"]}
    ref = {s["name"]: s["ref"] for s in d["symbols"]}
    lines = [l for l in nl.read_model() if l and not l.startswith((".", "*")) and l[0] not in "Kk"]
    nodes = {l.split()[0]: l.split()[1:3] for l in lines}
    cur = _steady_currents()
    current = lambda name: cur.get(f"I({name.split('§')[-1]})", 0.0)
    into: dict = {}   # node -> [(element, current into the node)]
    for name, (n1, n2) in nodes.items():
        if agent.get(name):
            for node, sign in ((n1, -1), (n2, 1)):   # I runs n1 -> n2: it leaves n1 and enters n2
                if node != "0":
                    into.setdefault(node, []).append((name, sign * current(name)))
    out = []
    for node, members in into.items():
        net: dict = {}
        for name, i in members:
            net[agent[name]] = net.get(agent[name], 0.0) + i
        if len(net) < 2:
            continue
        ncar = {a: sum(1 for n, _ in members if agent[n] == a and kind[n] in CARRIERS) for a in net}
        hub = max(net, key=lambda a: (ncar[a], abs(net[a])))
        # names for a resistor-only connection: the hub's flow element, else its source (the bond nodes N007, N013
        # are driven by the government's bond incentive sources)
        hub_named = sorted((n for n, _ in members if agent[n] == hub and kind[n] not in ("resistor", "capacitor")),
                           key=lambda n: (kind[n] not in CARRIERS, -abs(current(n))))
        for a in net:
            if a == hub:
                continue
            mine = [(n, i) for n, i in members if agent[n] == a]
            carriers = [(n, i) for n, i in mine if kind[n] in CARRIERS]
            if not carriers:   # only resistors: one flow, named after the hub's element
                n, i = max(mine, key=lambda x: abs(x[1]))
                label = ref[hub_named[0]] if hub_named else ref[n]
                carriers = [(n, i)]
            else:
                label = None
            for n, i in carriers:
                src, dst = (a, hub) if i > 0 else (hub, a)
                out.append({"element": n, "ref": label or ref[n], "kind": kind[n], "from": src, "to": dst, "node": node,
                            "steady": abs(i)})
    return out


# ---------------------------------------------------------------- dashboard: imported variables outside the plant
# Boxes of the drawing that make up the plant (the user's plant figure) and the blocks of the loop around it.
PLANT_BOXES = {"Households", "Banks", "Wholesale banks", "Retail banks", "Fiscal Authority", "NFC",
               "Domestic goods producers", "Capital producers", "Foreign Sector"}
LOOP_BOXES = {"Central Bank": "Controller", "CPI values": "Output", "Shock": "Disturbance"}
DASH_GROUPS = {   # the signal-only sources outside the plant boxes, by what they describe
    "Interest rates": ["R_Savings", "R_D", "R_wholesale", "R_retail", "R_ret_target", "y_LT", "R_for", "Coupon_LT", "Leverage"],
    "Balance sheets and stocks": ["Savings_Account_Balance", "B_loanbal", "B_NW", "Capital_Stock", "Government_Debt", "Issuance",
                                  "B_LT", "B_ST", "BLh_tgt", "dBLh", "B_L_hh", "B_L_bank", "B_F", "B_F_eur", "RWA", "D_bank", "Bonds_Clearing_Check"],
    "Returns and prices": ["ROI", "Endo_ROI", "Simple_ROI", "MPK", "Profit", "Wage_index", "Exchange_rate", "lnE"],
    "Aggregates": ["GDP_real", "GDP_nom", "HH_Capital"],
    "Policy instruments": ["APP"],
}


def dashboard() -> list[dict]:
    """Every signal-only source (both nodes ground or unconnected) outside the plant and loop boxes: the variables the
    plant imports. With its group, expression, and the elements that read it (and where they sit)."""
    m = model_map()
    group_of = {r: g for g, refs in DASH_GROUPS.items() for r in refs}
    exprs = {e["name"]: e["expr"] for e in m["elements"]}
    readers: dict[str, list[dict]] = {}
    for e in m["elements"]:
        for ref in set(re.findall(r"(?<![A-Za-z0-9_])[Ii]\(([^()]+)\)", e["expr"])):
            readers.setdefault(ref.strip().lower(), []).append({"name": e["name"], "ref": e["ref"], "sector": e["sector"]})
    out = []
    for e in m["elements"]:
        signal_only = set(e["nodes"]) <= {"0"} or all(n.upper().startswith("NC_") for n in e["nodes"])
        if e["sector"] in PLANT_BOXES or e["sector"] in LOOP_BOXES or not signal_only or e["kind"] not in ("behavioural current", "current source"):
            continue
        out.append({"name": e["name"], "ref": e["ref"], "group": group_of.get(e["ref"], "Other"), "expr": exprs[e["name"]],
                    "box": e["sector"], "readers": [r for r in readers.get(e["ref"].lower(), []) if r["name"] != e["name"]]})
    return out
