"""Flows between sectors, from the element currents of a run.

The model is a circuit: a node shared by elements of two or more sectors is where a flow passes between them. For
every such node the current each sector's elements push into it is summed (a SPICE current I(x) runs from the
element's first node to its second, so it enters the second node and leaves the first). By Kirchhoff's current law
the sector sums of a node add up to zero; a positive sum is a sector that delivers, a negative sum one that takes.

The currents are in model units per time unit and are not all money: goods, labour and money nodes are all here, so
the page shows them per node and never adds different nodes into one total without saying so.
"""
from __future__ import annotations
from collections import defaultdict
from functools import lru_cache

import numpy as np

from . import netlist as nl, schematic
from .scenario import T_STOP, UNITS_PER_YEAR, Scenario, recent_traces

OUTSIDE = "Outside the boxes"   # elements drawn outside every sector box (accounts, helper signals)
STEP_YEARS = 0.25


@lru_cache(maxsize=1)
def topology() -> tuple[dict[str, list[tuple[str, int]]], dict[str, str], dict[str, str]]:
    """Shared nodes {node: [(element, sign)]}, the sector and the reference name of every element."""
    m = schematic.model_map()
    sector = {e["name"]: e["sector"] or OUTSIDE for e in m["elements"]}
    ref = {e["name"]: e["ref"] for e in m["elements"]}
    by_node: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for line in nl.read_model():
        if not line or line.startswith((".", "*", "+")) or line[0] in "Kk":
            continue
        name, a, b = line.split()[:3]
        if name not in sector:
            continue
        for node, sign in ((a, -1), (b, 1)):
            if node != "0":
                by_node[node].append((name, sign))
    shared = {n: mem for n, mem in by_node.items() if len({sector[e] for e, _ in mem} - {OUTSIDE}) >= 2}
    return shared, sector, ref


def sector_flows(s: Scenario) -> dict:
    """Per shared node: what each sector pushes into it, on a grid of STEP_YEARS (model units per time unit)."""
    shared, sector, ref = topology()
    traces = recent_traces(s)
    low = {k.lower(): k for k in traces}
    t = np.arange(0, T_STOP + 1e-9, STEP_YEARS * UNITS_PER_YEAR)
    nodes = []
    for node, members in sorted(shared.items()):
        push: dict[str, np.ndarray] = defaultdict(lambda: np.zeros(len(t)))
        for el, sign in members:
            k = low.get(f"i({el.split('§')[-1].lower()})")
            if k is not None:
                push[sector[el]] += sign * np.interp(t, traces["time"], traces[k])
        nodes.append({"node": node, "elements": [ref[e] for e, _ in members],
                      "push": {sec: v.round(8).tolist() for sec, v in sorted(push.items())}})
    sectors = sorted({sec for n in nodes for sec in n["push"]}, key=lambda x: (x == OUTSIDE, x))
    return {"years": (t / UNITS_PER_YEAR).round(4).tolist(), "sectors": sectors, "nodes": nodes, "outside": OUTSIDE}
