"""ngspice engine for the monetary model: translates the LTspice netlist into ngspice syntax and runs it through
PySpice's shared-library interface (libngspice), so the site does not need LTspice.

Derived from backend/housing/ngspice.py (the housing app). The translation keeps every element, node and value
and rewrites only LTspice-specific syntax:
- .param a=1 b={expr}      -> evaluated here (in order, SPICE suffixes, pow/sqrt/exp/...); the numbers are put
                              straight into the expressions and element values, so ngspice's numparam is not needed
- {expr} in an expression  -> the braces are dropped (the parameters inside are substituted)
- 1m, 20u ... in expressions -> plain numbers (1e-3, 2e-5)
- names: L§Rent -> L_Rent (LTspice refers to it as I(Rent); so does this module's output)
- idt(x[, ic])             -> x as a current into 1 F, start value by .ic. ic must be a number or a parameter
                              expression; an ic that reads a signal (I(CPI)) needs IC_SIGNALS (its value at t = 0)
- ddt(x)                   -> x as a current through 1 H, whose voltage is dx/dt (RPAR_DDT across it: 1 ms filter)
- if(c, a, b)              -> (c) ? (a) : (b);  limit(x, a, b) -> min(max(x, a), b)
- x**p of a signal         -> max(x, 1e-6)**p
- Rser=r on L/C            -> separate series resistor ("1e" is read as 1, as LTspice does)
- every inductor           -> plus RPAR_L in parallel (see housing/ngspice.py: stops trapezoidal ringing)
- K couplings              -> refer to the translated inductor names
- .ic V(node)=x            -> kept; .ic I(L)=x -> IC=x on that inductor (applied with uic, see run_lines)
- floating parts of the circuit (no path to ground) -> one 1 GOhm resistor to ground each
- I(element) in expressions and in the output -> current through a 0 V sense source in series with the element
- current sources that carry only a signal (both nodes 0, or a floating/dangling node) -> a B voltage source on
  its own node; I(name) then reads that node voltage.
The output uses LTspice's trace names ("I(CPI)", "V(n_rate)", time from the .tran start).
"""
from __future__ import annotations
import math
import os
import re
import threading
import time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
_LOCAL_DLL = ROOT / "tools" / "ngspice" / "Spice64_dll" / "dll-vs" / "ngspice.dll"
_LOCAL_SHARE = ROOT / "tools" / "ngspice" / "Spice64_dll" / "share" / "ngspice"
RPAR_L = 1e5
RPAR_DDT = 1e3
ABSTOL = 1e-9
CHGTOL = 1e-10
_lock = threading.Lock()
# ngspice's background thread reports start and end through a callback. Counted, not a single flag, and the end
# is confirmed with ngSpice_running(): a late end signal of an earlier run cannot end the wait for the next one
# (the housing app hit a related read-before-finished race on Windows, see the README there).
_bg = threading.Condition()
_bg_count = {"start": 0, "end": 0}
_ng = None

SUFFIX = {"t": 1e12, "g": 1e9, "meg": 1e6, "k": 1e3, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12, "f": 1e-15}
_NUM = re.compile(r"(?<![A-Za-z0-9_.])(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(meg|[tgkmunpf])?([a-z]*)(?![A-Za-z0-9_(])", re.I)
FUNCS = {"pow", "pwr", "sqrt", "exp", "ln", "log", "log10", "abs", "min", "max", "limit", "if", "idt", "sdt", "ddt",
         "tanh", "sin", "cos", "tan", "atan", "sgn", "u", "uramp", "floor", "ceil", "time", "delay", "table"}


def number(text: str) -> float:
    """A SPICE number: 1m, 20ms, 1.5k, 2meg, 1e-3, '1e' (LTspice reads it as 1)."""
    m = re.fullmatch(r"\s*([+-]?(?:\d+\.?\d*|\.\d+))(e[+-]?\d+)?(e)?(meg|[tgkmunpf])?[a-z]*\s*", text, re.I)
    if not m:
        raise ValueError(f"not a SPICE number: {text!r}")
    v = float(m.group(1) + (m.group(2) or ""))
    return v * SUFFIX.get((m.group(4) or "").lower(), 1.0)


def _plain_numbers(expr: str) -> str:
    """1m -> 0.001 inside an expression (ngspice's B-source parser does not take every suffix)."""
    def sub(m):
        mant, exp, suf, tail = m.group(1), m.group(2) or "", (m.group(3) or "").lower(), m.group(4)
        if not suf:
            return m.group(0)
        return f"{float(mant + exp) * SUFFIX[suf]:.12g}"
    return _NUM.sub(sub, expr)


# ------------------------------------------------------------------ parameters
def parse_params(rows: list[str]) -> dict[str, float]:
    """All .param values (lower-case names), evaluated in file order as LTspice does for this netlist."""
    raw: list[tuple[str, str]] = []
    for r in rows:
        if not r.lower().startswith(".param"):
            continue
        body = r[6:]
        # name = value pairs; a value is {...} or a token without spaces
        for m in re.finditer(r"([A-Za-z_]\w*)\s*=\s*(\{[^}]*\}|\S+)", body):
            if any(n == m.group(1).lower() for n, _ in raw):  # LTspice: "already defined elsewhere" (names ignore case)
                raise ValueError(f".param {m.group(1)} is defined twice (parameter names are case-insensitive)")
            raw.append((m.group(1).lower(), m.group(2)))
    values: dict[str, float] = {}
    pending = list(raw)
    for _ in range(len(pending) + 1):  # parameters may refer to ones defined later
        left = []
        for name, text in pending:
            try:
                values[name] = evaluate(text, values)
            except (NameError, KeyError):
                left.append((name, text))
        if not left:
            return values
        pending = left
    raise ValueError(f"undefined parameters in: {pending}")


def evaluate(text: str, params: dict[str, float]) -> float:
    """A constant SPICE expression (numbers, parameters, pow/sqrt/exp/...)."""
    e = text.strip().strip("{}")
    e = _plain_numbers(e)
    e = re.sub(r"(?<![\w.])(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(?![\w(])", lambda m: m.group(0), e)
    env = {"pow": pow, "pwr": pow, "sqrt": math.sqrt, "exp": math.exp, "ln": math.log, "log": math.log,
           "log10": math.log10, "abs": abs, "min": min, "max": max, "tanh": math.tanh, "__builtins__": {}}

    def name(m):
        k = m.group(0).lower()
        if k in env:
            return k
        if k in params:
            return repr(params[k])
        raise NameError(k)
    e = re.sub(r"(?<![\w.])[A-Za-z_]\w*", name, e)
    return float(eval(e, env))


def substitute_params(expr: str, params: dict[str, float]) -> str:
    """Parameter names -> numbers, outside I(...)/V(...) element and node references."""
    keep: list[str] = []

    def hold(m):
        keep.append(m.group(0)); return f"@{len(keep) - 1}@"
    e = re.sub(r"(?<![A-Za-z0-9_])[IiVv]\([^()]*\)", hold, expr)
    e = e.replace("{", "(").replace("}", ")")

    def name(m):
        k = m.group(0).lower()
        if k in params and k not in FUNCS:
            return f"({params[k]:.15g})"
        return m.group(0)
    e = re.sub(r"(?<![\w.@])[A-Za-z_]\w*\b(?!\s*\()", name, e)
    e = _plain_numbers(e)
    return re.sub(r"@(\d+)@", lambda m: keep[int(m.group(1))], e)


# ------------------------------------------------------------------ expression rewriting
def _split_args(s: str, start: int) -> tuple[list[str], int]:
    depth, args, cur, i = 0, [], [], start
    while i < len(s):
        ch = s[i]
        if ch == "(":
            depth += 1
            if depth > 1:
                cur.append(ch)
        elif ch == ")":
            depth -= 1
            if depth == 0:
                args.append("".join(cur).strip())
                return args, i + 1
            cur.append(ch)
        elif ch == "," and depth == 1:
            args.append("".join(cur).strip()); cur = []
        else:
            cur.append(ch)
        i += 1
    raise ValueError(f"Unbalanced parentheses in {s!r}")


def _rewrite_calls(expr: str, name: str, fn) -> str:
    pat = re.compile(rf"(?<![A-Za-z0-9_]){name}\s*\(", re.I)
    while True:
        hits = list(pat.finditer(expr))
        if not hits:
            return expr
        m = hits[-1]
        args, end = _split_args(expr, m.end() - 1)
        expr = expr[:m.start()] + fn(args) + expr[end:]


class _Translator:
    def __init__(self, params: dict[str, float], ic_signals: dict[str, float], ic_override: dict[str, float] | None = None):
        self.params = params
        self.ic_override = {k.lower(): v for k, v in (ic_override or {}).items()}
        self.owner = ""                      # element whose expression is being translated
        self.integrators: list[dict] = []    # {node, owner, ic}: one per idt(), in netlist order
        self.ic_signals = {k.lower().replace(" ", ""): v for k, v in ic_signals.items()}
        self.extra: list[str] = []
        self.n = 0
        self.signal: dict[str, str] = {}
        self.sensed: dict[str, str] = {}
        self.vsrc: dict[str, str] = {}
        self.ics: list[str] = []

    def new(self, kind: str) -> str:
        self.n += 1
        return f"x{kind}{self.n}"

    def current_ref(self, ref: str) -> str:
        key = ref.lower()
        if key in self.signal:
            return f"v({self.signal[key]})"
        if key in self.vsrc:
            return f"i({self.vsrc[key]})"
        if key in self.sensed:
            return f"i({self.sensed[key]})"
        raise KeyError(f"I({ref}) refers to an unknown element")

    def expr(self, e: str) -> str:
        e = substitute_params(e.strip(), self.params)
        # idt start values are read before the I() references are translated (IC_SIGNALS is keyed by LTspice name)
        e = _rewrite_calls(e, "idt", self._idt_raw)
        e = re.sub(r"(?<![A-Za-z0-9_])[Ii]\(([^()]+)\)", lambda m: self.current_ref(m.group(1).strip()), e)
        e = re.sub(r"((?:i|v)\([^()]+\))\s*\*\*", r"max(\1,1e-6)**", e)
        # pow(signal, p): same floor (ngspice ramps the sources from 0 to find the operating point; at 0 the slope
        # of x^0.36 is infinite). Only bases that read a signal; all bases in this model are positive.
        e = _rewrite_calls(e, "pow", lambda a: f"xpow(max({a[0]},1e-6),{a[1]})" if re.search(r"\b[iv]\(", a[0]) else f"xpow({a[0]},{a[1]})")
        e = e.replace("xpow(", "pow(")
        e = _rewrite_calls(e, "limit", lambda a: f"min(max({a[0]},{a[1]}),{a[2]})")
        e = _rewrite_calls(e, "if", lambda a: f"(({a[0]}) ? ({a[1]}) : ({a[2]}))")
        e = _rewrite_calls(e, "xidt", self._idt)
        e = _rewrite_calls(e, "ddt", self._ddt)
        return e

    def _idt_raw(self, a: list[str]) -> str:
        """Resolve the start value now; the integrand is translated later (as xidt)."""
        ic = a[1] if len(a) > 1 else "0"
        key = ic.replace(" ", "").lower()
        if key in self.ic_signals:
            value = self.ic_signals[key]
        else:
            try:
                value = evaluate(ic, self.params)
            except (NameError, SyntaxError) as exc:
                raise ValueError(f"idt start value {ic!r} reads a signal; give its t = 0 value in IC_SIGNALS") from exc
        return f"xidt({a[0]},{value:.15g})"

    def _idt(self, a: list[str]) -> str:
        k = self.new("int")
        if any(i["owner"] == self.owner for i in self.integrators):
            raise ValueError(f"{self.owner}: more than one idt() in one element")
        ic = self.ic_override.get(self.owner, float(a[1]))
        self.integrators.append({"node": k, "owner": self.owner, "ic": ic})
        self.extra += [f"B{k}in 0 {k} I={a[0]}", f"C{k} {k} 0 1", f"R{k} {k} 0 1e15"]
        self.ics.append(f"v({k})={ic:.12g}")
        return f"v({k})"

    def _ddt(self, a: list[str]) -> str:
        k = self.new("dt")
        # V{k}s senses the inductor current, so the two-stage start (run_lines) can carry it over
        self.extra += [f"B{k}in 0 {k} I={a[0]}", f"L{k} {k} {k}s 1", f"V{k}s {k}s 0 0", f"R{k}par {k} 0 {RPAR_DDT:g}"]
        return f"v({k})"


def _ref(token: str) -> tuple[str, str]:
    """(ngspice name, LTspice reference name) of an element token."""
    if "§" in token:
        kind, name = token.split("§", 1)
        return f"{kind}_{name}", name
    return token, token


def _floating(node: str) -> bool:
    return node.lower().startswith("nc_")


def _tran(rows: list[str]) -> tuple[str, float, float]:
    """ngspice .tran from LTspice's '.tran tstep tstop [tstart [tmax]] [keywords]'; also tstart and tstop."""
    row = next(r for r in rows if r.lower().startswith(".tran"))
    v = []
    for tok in row.split()[1:]:
        try:
            v.append(number(tok))
        except ValueError:
            pass  # 'startup', 'uic', 'steady': no independent sources here, the operating point is solved anyway
    tstep, tstop = v[0], v[1]
    tstart = v[2] if len(v) > 2 else 0.0
    tmax = v[3] if len(v) > 3 and v[3] > 0 else (tstop - tstart) / 50
    tstep = tstep if tstep > 0 else tmax
    return f".tran {tstep:.6g} {tstop:.6g} {tstart:.6g} {tmax:.6g}", tstart, tstop


def translate(lines: list[str], ic_signals: dict[str, float] | None = None, ic_override: dict[str, float] | None = None,
              info: dict | None = None) -> tuple[str, dict[str, str], float]:
    """ngspice netlist text, {LTspice trace name: ngspice vector} and the .tran start time.
    ic_override: {element name: start value} replaces the start value of the idt() in that element.
    info (out): info["integrators"] = [{node, owner, ic}] (see steady.py)."""
    rows = [l.rstrip("\r") for l in lines if l.strip() and not l.lstrip().startswith(("*", ";"))]
    params = parse_params(rows)
    T = _Translator(params, ic_signals or {}, ic_override)
    elems, out = [], []
    degree: dict[str, int] = {}
    for l in rows:
        tok = l.split()
        if l.startswith(".") or tok[0][0].upper() == "K":
            continue
        for node in tok[1:3]:
            degree[node.lower()] = degree.get(node.lower(), 0) + 1
    inductors: dict[str, str] = {}  # ref (lower) -> ngspice name
    for l in rows:
        if l.startswith("."):
            continue
        tok = l.split()
        kind = tok[0][0].upper()
        if kind == "K":
            elems.append(("K", tok)); continue
        name, ref = _ref(tok[0]); n1, n2 = tok[1], tok[2]
        if kind == "L":
            inductors[ref.lower()] = name
        is_source = kind in "IB" and (kind == "I" or re.search(r"\bI\s*=", l))
        dangling = lambda n: n != "0" and degree.get(n.lower(), 0) < 2
        signal = is_source and (n1 == n2 or (n1 == "0" and n2 == "0") or _floating(n1) or _floating(n2) or dangling(n1) or dangling(n2))
        if not is_source and (_floating(n1) and _floating(n2) or n1 == n2):
            elems.append(("drop", ref)); continue
        if signal:
            T.signal[ref.lower()] = f"s_{ref.lower()}"
        elif kind == "V":
            T.vsrc[ref.lower()] = name
        else:
            T.sensed[ref.lower()] = f"vs_{ref.lower()}"
        elems.append((kind, tok, name, ref, signal, l))
    # .ic: node voltages stay .ic; inductor currents become IC= on the inductor
    node_ics, l_ics, skipped = [], {}, []
    for r in rows:
        if not r.lower().startswith(".ic"):
            continue
        for kind, target, value in re.findall(r"([IiVv])\(([^()]+)\)\s*=\s*(\S+)", r):
            val = number(value) if re.match(r"[\d.+-]", value) else evaluate(value, params)
            if kind.upper() == "V":
                node_ics.append(f"v({target.lower()})={val:.12g}")
            elif target.lower() in inductors:
                l_ics[target.lower()] = val
            else:
                skipped.append(target)
    names = {}
    for item in elems:
        if item[0] == "drop":
            names[f"I({item[1]})"] = "zero"
            continue
        if item[0] == "K":
            tok = item[1]
            l1, l2 = (inductors.get(t.lower(), t) for t in tok[1:3])
            out.append(f"K_{tok[0][1:] or 'k'} {l1} {l2} {number(tok[3]):.6g}")
            continue
        kind, tok, name, ref, signal, l = item
        T.owner = ref.lower()
        n1, n2 = tok[1], tok[2]
        rest = l.split(None, 3)[3] if len(l.split(None, 3)) > 3 else ""
        trace = f"I({ref})"
        if signal:
            node = T.signal[ref.lower()]
            if kind == "B":
                expr = re.split(r"\bI\s*=", rest, maxsplit=1)[1]
                out.append(f"B_s_{ref.lower()} {node} 0 V={T.expr(expr)}")
            else:
                out.append(f"V_s_{ref.lower()} {node} 0 {rest}")
            out.append(f"R_s_{ref.lower()} {node} 0 1e12")
            names[trace] = f"v({node})"
            continue
        if kind == "V":
            out.append(f"{name} {n1} {n2} {rest}")
            names[trace] = f"i({name})"
            continue
        sense, mid = T.sensed[ref.lower()], f"{ref.lower()}_s"
        ser = re.search(r"\s+Rser=(\S+)", rest, re.I)
        rest = re.sub(r"\s+Rser=\S+", "", rest, flags=re.I)
        if kind == "B":
            m = re.match(r"\s*([IV])\s*=\s*(.*)$", rest, re.S)
            body = f"{m.group(1)}={T.expr(m.group(2))}"
        else:
            value = rest.split()[0].strip("{}")
            try:
                v = number(value)
            except ValueError:
                v = evaluate(value, params)
            body = f"{v:.12g}" + (f" IC={l_ics[ref.lower()]:.12g}" if kind == "L" and ref.lower() in l_ics else "")
        if ser:
            out.append(f"{name} {n1} {mid}r {body}"); out.append(f"R_{ref}_ser {mid}r {mid} {number(ser.group(1)):.6g}")
        else:
            out.append(f"{name} {n1} {mid} {body}")
        out.append(f"{sense} {mid} {n2} 0")
        if kind == "L":
            out.append(f"R_{ref}_par {n1} {mid} {RPAR_L:g}")
        names[trace] = f"i({sense})"
    out += _ground_floating_parts(out + T.extra)
    tran, tstart, _ = _tran(rows)
    head = ["* monetary model, translated from the LTspice netlist by monetary/ngspice.py"]
    ics = [".ic " + " ".join(T.ics + node_ics)] if T.ics or node_ics else []
    text = "\n".join(head + out + T.extra + ics + [tran, f".options method=trap abstol={ABSTOL:g} chgtol={CHGTOL:g}", ".end"])
    text = re.sub("error", "gap_", text, flags=re.I)
    names = {k: re.sub("error", "gap_", v, flags=re.I) for k, v in names.items()}
    if info is not None:
        info["integrators"] = T.integrators
        info["params"] = params
    return text, names, tstart


def _ground_floating_parts(rows: list[str]) -> list[str]:
    parent: dict[str, str] = {}

    def find(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for r in rows:
        tok = r.split()
        if not tok or tok[0][0] in ".*" or tok[0][0].upper() == "K":
            continue
        nodes = [n.lower() for n in tok[1:3]]
        for n in nodes[1:]:
            parent[find(nodes[0])] = find(n)
    roots = {find(n) for n in list(parent)}
    ground = find("0")
    return [f"R_gnd_{i} {root} 0 1e9" for i, root in enumerate(sorted(roots - {ground}))]


# ------------------------------------------------------------------ running
def _shared():
    global _ng
    if _ng is None:
        if "NGSPICE_LIBRARY_PATH" not in os.environ and _LOCAL_DLL.exists():
            os.environ["NGSPICE_LIBRARY_PATH"] = str(_LOCAL_DLL)
            os.environ.setdefault("SPICE_LIB_DIR", str(_LOCAL_SHARE))
        import logging
        logging.getLogger("PySpice").setLevel(logging.CRITICAL)
        from PySpice.Spice.NgSpice.Shared import NgSpiceShared, ffi

        def _bg_running(exited, ngspice_id, user_data):
            ffi.from_handle(user_data)._is_running = not exited
            with _bg:
                _bg_count["end" if exited else "start"] += 1
                _bg.notify_all()
            return 0
        NgSpiceShared._background_thread_running = staticmethod(_bg_running)
        _ng = NgSpiceShared.new_instance()
    return _ng


def available() -> bool:
    try:
        _shared(); return True
    except Exception:
        return False


def _timeout() -> float:
    return float(os.environ.get("MONETARY_NGSPICE_TIMEOUT", "120"))


def _run_text(text: str) -> tuple[dict[str, np.ndarray], list[str]]:
    """All vectors of the run ({} if it failed: a failed .op leaves a plot with empty vectors) and the log."""
    vec, log = _run_once(text)
    if vec and any(np.size(v) == 0 for v in vec.values()):
        vec = {}
    return vec, log


def _run_once(text: str) -> tuple[dict[str, np.ndarray], list[str]]:
    with _lock:
        ng = _shared()
        api = ng._ngspice_shared
        ng.clear_output()
        ng.load_circuit(text)
        limit = _timeout()
        deadline = time.monotonic() + limit
        while api.ngSpice_running() and time.monotonic() < deadline:  # an earlier thread still winding down
            time.sleep(0.001)
        with _bg:
            started = _bg_count["start"]
        api.ngSpice_Command(b"bg_run")
        with _bg:  # wait until this run's thread has started ...
            _bg.wait_for(lambda: _bg_count["start"] > started, timeout=max(0.0, deadline - time.monotonic()))
        while api.ngSpice_running() and time.monotonic() < deadline:  # ... and until it has finished
            time.sleep(0.001)
        timed_out = bool(api.ngSpice_running())
        if timed_out:
            api.ngSpice_Command(b"bg_halt")
            end = time.monotonic() + 30
            while api.ngSpice_running() and time.monotonic() < end:
                time.sleep(0.01)
        vec = {}
        try:
            plot = ng.plot(simulation=None, plot_name=ng.last_plot)
            # complex for AC analyses, float otherwise
            vec = {k.lower(): (np.asarray(v._data) if np.iscomplexobj(v._data) else np.asarray(v._data, dtype=float)) for k, v in plot.items()}
        except Exception:
            pass
        log = [l for l in ng._stderr if "Note:" not in l][-8:]
        if timed_out:
            log.append(f"stopped after {limit:g} s (MONETARY_NGSPICE_TIMEOUT)")
        api.ngSpice_Command(b"destroy all")
        api.ngSpice_Command(b"remcirc")
    return vec, log


def _traces(vec: dict[str, np.ndarray], names: dict[str, str], n: int) -> dict[str, np.ndarray]:
    traces = {}
    for trace, v in names.items():
        if v == "zero":
            traces[trace] = np.zeros(n); continue
        key = v.lower()
        if key.startswith("i(") and key not in vec:
            key = key[2:-1] + "#branch"
        if key.startswith("v(") and key not in vec:
            key = key[2:-1]
        traces[trace] = vec[key]
    for k, v in vec.items():
        if k != "time" and "#" not in k and not k.startswith(("x", "s_")) and not k.endswith(("_s", "_sr")):
            traces[f"V({k})"] = v
    return traces


_L_LINE = re.compile(r"^(L\S*) (\S+) (\S+) (\S+)(?: IC=(\S+))?$", re.I)


def op_text(text: str) -> str:
    """The translated netlist as a DC operating point (.op), with LTspice's start conditions:
    - .ic V(node) and the integrator start values are held by voltage sources (.op ignores .ic);
    - an inductor with IC= is replaced by a current source of that value. The parallel RPAR_L stays, so where
      the circuit forces another current through the branch (B§Wage -> R9 -> Income) the difference flows
      through RPAR_L, as in LTspice (measured: V(n016) = (0.0166 - 0.085) * 1e5 = -6838 at t = 0)."""
    out = []
    for l in text.splitlines():
        m = _L_LINE.match(l)
        if l.startswith(".ic "):
            out += [f"V{k}hold {k} 0 {v}" for k, v in re.findall(r"v\((\w+)\)=(\S+)", l)]
        elif l.startswith(".tran"):
            out.append(".op")
        elif l.upper().startswith("K"):
            continue  # couplings act on di/dt only, nothing at the operating point
        elif m and m.group(5):
            out.append(f"I{m.group(1)}op {m.group(2)} {m.group(3)} {m.group(5)}")
        else:
            out.append(l)
    return "\n".join(out)


def start_from_op(text: str, op: dict[str, np.ndarray]) -> str:
    """Transient text that starts from the operating point `op` (uic): every node voltage as .ic and every inductor
    current as IC=. The inductor current is the sensed branch current minus what flows through RPAR_L."""
    v = {k: float(np.ravel(x)[0]) for k, x in op.items()}
    out = []
    for l in text.splitlines():
        m = _L_LINE.match(l)
        if m and not l.startswith(".") and not l.upper().startswith("K"):
            name, n1, n2 = m.group(1), m.group(2).lower(), m.group(3).lower()
            if m.group(5):
                i_l = float(m.group(5))
            elif name.lower().startswith("lxdt"):
                i_l = v.get(f"v{name[1:].lower()}s#branch", 0.0)
            else:
                mid = n2[:-1] if n2.endswith("_sr") else n2  # translate() names it <ref>_s(r)
                ref = mid[:-2]
                i_l = v.get(f"vs_{ref}#branch", 0.0) - (v.get(n1, 0.0) - v.get(mid, 0.0)) / RPAR_L
            out.append(f"{name} {m.group(2)} {m.group(3)} {m.group(4)} IC={i_l:.12g}")
        elif l.startswith(".ic "):
            nodes = {k: x for k, x in v.items() if "#" not in k and k not in ("time", "0")}
            out.append(".ic " + " ".join(f"v({k})={x:.12g}" for k, x in sorted(nodes.items())))
        elif l.startswith(".tran"):
            out.append(l + " uic")
        else:
            out.append(l)
    return "\n".join(out)


def run_lines(lines: list[str], ic_signals: dict[str, float] | None = None,
              ic_override: dict[str, float] | None = None, states: bool = False) -> dict[str, np.ndarray]:
    """Run the netlist in ngspice; traces under LTspice's names, time from the .tran start.
    states=True: also traces["states"] = {element: state of its idt() over time} (for linearising at a later time).

    Two stages, because ngspice applies an inductor's IC= only with uic (which skips the operating point):
    the operating point with LTspice's start conditions (op_text), then the transient from there (start_from_op)."""
    info: dict = {}
    text, names, tstart = translate(lines, ic_signals, ic_override, info)
    op, log = _run_text(op_text(text))
    if not op:
        raise RuntimeError("ngspice found no operating point: " + " | ".join(log))
    text = start_from_op(text, op)
    tstop = float(next(r for r in text.splitlines() if r.startswith(".tran")).split()[2])
    vec, log = _run_text(text)
    if "time" not in vec or vec["time"].size == 0 or vec["time"][-1] < tstop - 1e-6:
        reached = f" (reached t = {vec['time'][-1]:.6g} of {tstop:g})" if vec.get("time") is not None and vec["time"].size else ""
        raise RuntimeError("ngspice did not finish the run" + reached + ": " + " | ".join(log))
    t = vec["time"]
    traces = {"time": t - tstart}
    traces.update(_traces(vec, names, t.size))
    if states:
        traces["states"] = {i["owner"]: vec[i["node"]] for i in info["integrators"]}
    return traces
