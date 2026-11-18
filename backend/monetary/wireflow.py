"""The current along every drawn wire, for the moving dots on the circuit map.

Every netlist node is drawn as wires between the pins of its elements. A SPICE current I(x) runs from the element's
first node to its second (pins in SpiceOrder, schematic.PINS), so at its second pin it enters the node and at its first
pin it leaves it. The wires of a node are split where a pin or another wire's end touches them, and form a tree (flags
with the same name are joined by an invisible link). Then the current through a wire segment is the sum of what enters
the node on one side of it: in a tree, the net current of the subtree below an edge flows through that edge to its
parent. A wire on a closed loop of wires (rare in the drawing) gets the current of its tree edge or 0 off the tree.

Ground (node 0, the common return, with many flags) is left out: the dots show the flows, not the returns.
"""
from __future__ import annotations
from collections import defaultdict
from functools import lru_cache

import numpy as np

from . import netlist as nl, schematic
from .scenario import T_STOP, UNITS_PER_YEAR, Scenario, recent_traces

STEP_YEARS = 0.1


def _on(w, p) -> bool:
    x1, y1, x2, y2 = w
    if not (min(x1, x2) <= p[0] <= max(x1, x2) and min(y1, y2) <= p[1] <= max(y1, y2)):
        return False
    return (x2 - x1) * (p[1] - y1) == (y2 - y1) * (p[0] - x1)


@lru_cache(maxsize=1)
def topology() -> dict:
    """Wire segments, their node, and per node a rooted tree: for every vertex its parent edge and the pins on it."""
    d = schematic.parse()
    net = schematic.nets(d)
    lines = nl.read_model()
    nodes = {l.split()[0]: l.split()[1:3] for l in lines if l and not l.startswith((".", "*")) and l[0] not in "Kk"}
    node_of_net: dict = {}
    for s in d["symbols"]:
        for p, node in zip(s["pins"], nodes.get(s["name"], [])):
            node_of_net[net[tuple(p)]] = node
    for f in d["flags"]:
        node_of_net.setdefault(net[(f["x"], f["y"])], f["name"])
    node_at = lambda p: node_of_net.get(net.get(tuple(p)))

    points = {(w[0], w[1]) for w in d["wires"]} | {(w[2], w[3]) for w in d["wires"]}
    points |= {tuple(p) for s in d["symbols"] for p in s["pins"]} | {(f["x"], f["y"]) for f in d["flags"]}
    # segments: each wire cut at the points on it, in the wire's own direction
    segments = []
    for i, w in enumerate(d["wires"]):
        node = node_at((w[0], w[1]))
        if not node or node == "0":
            continue
        a = np.array(w[:2], float); v = np.array(w[2:], float) - a; L2 = float(v @ v) or 1.0
        on = sorted({p for p in points if _on(w, p)}, key=lambda p: float((np.array(p) - a) @ v) / L2)
        for p, q in zip(on, on[1:]):
            if p != q:
                segments.append({"w": i, "p": [p[0], p[1], q[0], q[1]], "node": node})
    # graph per node: edges are segments (index) and flag links (None)
    adj: dict = defaultdict(list)
    for k, s in enumerate(segments):
        p, q = tuple(s["p"][:2]), tuple(s["p"][2:])
        adj[p].append((q, k, +1)); adj[q].append((p, k, -1))   # +1: walking p -> q follows the segment's direction
    by_flag: dict = defaultdict(list)
    for f in d["flags"]:
        if f["name"] != "0":
            by_flag[f["name"]].append((f["x"], f["y"]))
    for pts in by_flag.values():
        for p, q in zip(pts, pts[1:]):
            adj[p].append((q, None, +1)); adj[q].append((p, None, -1))
    # pins: (point, element, sign) with +1 where I(element) enters the node, -1 where it leaves
    pins: dict = defaultdict(list)
    for s in d["symbols"]:
        n = nodes.get(s["name"], [])
        if len(n) != 2 or n[0] == n[1]:
            continue
        for p, sign, node in ((s["pins"][0], -1, n[0]), (s["pins"][1], +1, n[1])):
            if node != "0":
                pins[tuple(p)].append((s["name"], sign))
    # rooted spanning forest (BFS); order lists vertices so that children come after their parent
    seen, order, parent = set(), [], {}
    for root in list(adj):
        if root in seen:
            continue
        seen.add(root); queue = [root]; parent[root] = None
        while queue:
            u = queue.pop(0); order.append(u)
            for v, k, sgn in adj[u]:
                if v not in seen:
                    seen.add(v); parent[v] = (u, k, sgn); queue.append(v)
    return {"segments": segments, "order": order, "parent": parent, "pins": dict(pins)}


def wire_currents(s: Scenario) -> dict:
    """Current along every non-ground wire segment, positive in the segment's drawn direction (p[0:2] -> p[2:4])."""
    topo = topology()
    traces = recent_traces(s)
    low = {k.lower(): k for k in traces}
    t = np.arange(0, T_STOP + 1e-9, STEP_YEARS * UNITS_PER_YEAR)
    cur = {}
    def current(el):
        if el not in cur:
            k = low.get(f"i({el.split('§')[-1].lower()})")
            cur[el] = np.interp(t, traces["time"], traces[k]) if k else np.zeros(len(t))
        return cur[el]
    # net current entering each vertex's subtree, accumulated from the leaves up
    sub = {u: sum((sign * current(el) for el, sign in topo["pins"].get(u, [])), np.zeros(len(t))) for u in topo["order"]}
    flow = [np.zeros(len(t)) for _ in topo["segments"]]
    for v in reversed(topo["order"]):
        par = topo["parent"][v]
        if par is None:
            continue
        u, k, sgn = par
        sub[u] = sub[u] + sub[v]
        if k is not None:
            # what enters v's subtree leaves it through the edge toward u; the walk u -> v has direction sgn
            flow[k] = -sgn * sub[v]
    return {"years": (t / UNITS_PER_YEAR).round(4).tolist(),
            "segments": [{"w": sg["w"], "p": sg["p"], "node": sg["node"], "i": [float(f"{x:.4g}") for x in fl]}
                         for sg, fl in zip(topo["segments"], flow)]}
