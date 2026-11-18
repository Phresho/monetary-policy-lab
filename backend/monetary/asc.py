"""Writes a steady-start copy of the LTspice schematic (.asc), so the model also starts in steady state when it is
opened and run in LTspice itself.

    .venv/Scripts/python.exe -m monetary.asc            (from backend/; open loop, the netlist's policy)
    .venv/Scripts/python.exe -m monetary.asc --closed   (closed loop, R = V(n_rate), filtered derivative Kd*s/(1+s*tau_d))
    .venv/Scripts/python.exe -m monetary.asc --closed --ki 0.04   (and a different integral gain: the netlist's Ki = 0.44
                                                                    oscillates; 0.04 is stable, phase margin about 50 deg)

The schematic is never edited in place: the result is model/<name>_steady[_closed].asc. Every element whose
expression differs between the netlist and the steady-start netlist (netlist.with_start) gets the new expression;
the .ic directives are turned into comments (! -> ;). Rerun after changing parameters in the schematic: the
steady state depends on them. The .net must be exported from the same .asc (View > SPICE Netlist).
"""
from __future__ import annotations
import argparse
from pathlib import Path

from . import netlist as nl, steady

ASC = nl.MODEL.with_suffix(".asc")


def _by_element(lines: list[str]) -> dict[str, str]:
    out = {}
    for l in lines:
        tok = l.split(None, 3)
        if l and not l.startswith((".", "*")) and len(tok) == 4:
            out[tok[0]] = tok[3]
    return out


def write(closed: bool = False, asc: Path = ASC, out: Path | None = None, ki: float | None = None) -> tuple[Path, steady.Steady]:
    policy = nl.Policy(closed=closed, derivative="filtered" if closed else "netlist", ki=ki)
    base = nl.read_model()
    lines = nl.build(policy, steady_start=True)
    s = steady.steady_start(lines, nl.IC_SIGNALS)
    final = nl.with_start(lines, s.override, s.ic_signals)
    old, new = _by_element(base), _by_element(final)
    text = asc.read_text(encoding="utf-8", errors="strict").split("\n")
    changed, added = [], []
    first_symbol = next(i for i, l in enumerate(text) if l.startswith("SYMBOL "))
    # new parts go next to the policy rule B_PI (left of it), wherever the drawing has it
    pi_at = next(i for i, l in enumerate(text) if l.rstrip("\r") == "SYMATTR InstName B_PI")
    bx, by = (int(v) for v in next(text[i] for i in range(pi_at, -1, -1) if text[i].startswith("SYMBOL ")).split()[2:4])
    for element, value in new.items():
        if old.get(element) == value:
            continue
        if element not in old:
            # A new ground-referenced behavioural current source (B§PI_D 0 0 I=...): a bi2 symbol (pins at (0,0) and
            # (0,80)) with both pins flagged to ground, left of the policy rule B_PI.
            line = next(l for l in final if l.split(None, 1)[0] == element)
            if not element.startswith("B§") or line.split()[1:3] != ["0", "0"]:
                raise ValueError(f"cannot place new element {line!r} in the schematic")
            x, y = bx - 588, by + 176 + 160 * len(added)
            text[first_symbol:first_symbol] = [f"FLAG {x} {y} 0", f"FLAG {x} {y + 80} 0", f"SYMBOL bi2 {x} {y} R0",
                                               f"SYMATTR InstName {element[2:]}", f"SYMATTR Value {value}"]
            first_symbol += 5
            added.append(element)
            continue
        target = f"SYMATTR Value {old[element]}"
        hits = [i for i, l in enumerate(text) if l.rstrip("\r") == target]
        if len(hits) != 1:
            raise ValueError(f"{element}: expected its expression once in {asc.name}, found {len(hits)} "
                             f"(is the .net exported from this .asc?)")
        text[hits[0]] = f"SYMATTR Value {value}"
        changed.append(element)
    removed = [l for l in base if l.lower().startswith(".ic")]
    for directive in removed:
        hits = [i for i, l in enumerate(text) if l.startswith("TEXT ") and l.rstrip("\r").endswith(f"!{directive}")]
        if len(hits) != 1:
            raise ValueError(f"expected directive {directive!r} once in {asc.name}, found {len(hits)}")
        text[hits[0]] = text[hits[0]].replace(f"!{directive}", f";{directive}")
    note = ("Steady start (backend/monetary/asc.py): .ic lines and the start-up time guards removed, idt() start "
            "values solved so every integrator is at rest at t = 0. Rerun the script after changing parameters.")
    anchor = next(i for i, l in enumerate(text) if l.startswith("TEXT "))
    x, y = text[anchor].split()[1:3]
    text.insert(anchor, f"TEXT {x} {int(y) - 120} Left 2 ;{note}")
    # a .param line whose values changed (a gain) replaces its directive in the drawing, so no name is defined twice;
    # a .param line that is new (tau_Dfilt) is added next to B_PI
    new_params = [l for l in final if l.lower().startswith(".param") and l not in base]
    for old_line in [l for l in base if l.lower().startswith(".param") and l not in final]:
        first = old_line.split()[1].split("=")[0].lower()
        repl = next(l for l in new_params if l.split()[1].split("=")[0].lower() == first)
        hits = [i for i, l in enumerate(text) if l.startswith("TEXT ") and l.rstrip("\r").endswith(f"!{old_line}")]
        if len(hits) != 1:
            raise ValueError(f"expected directive {old_line!r} once in {asc.name}, found {len(hits)}")
        text[hits[0]] = text[hits[0]].rstrip("\r")[: -len(old_line)] + repl
        new_params.remove(repl)
        changed.append(repl)
    for k, directive in enumerate(new_params):
        text.insert(anchor, f"TEXT {bx - 588} {by - 4 - 40 * k} Left 2 !{directive}")
        added.append(directive)
    out = out or asc.with_name(asc.stem + ("_steady_closed" if closed else "_steady") + ".asc")
    out.write_text("\n".join(text), encoding="utf-8")
    print(f"{out.name}: {len(changed)} expressions changed ({', '.join(changed)}), added {added}, {len(removed)} .ic lines commented out")
    return out, s


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--closed", action="store_true", help="closed loop: R follows V(n_rate), filtered derivative Kd*s/(1+s*tau_d)")
    ap.add_argument("--ki", type=float, help="integral gain instead of the netlist's Ki")
    args = ap.parse_args()
    write(closed=args.closed, ki=args.ki)
