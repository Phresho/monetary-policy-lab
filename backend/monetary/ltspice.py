"""Runs a netlist with LTspice in batch mode (the reference solver), each run in its own folder."""
from __future__ import annotations
import os
import subprocess
from pathlib import Path
import numpy as np
from .raw import read_raw

_CANDIDATES = [
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "ADI" / "LTspice" / "LTspice.exe",
    Path("C:/Program Files/ADI/LTspice/LTspice.exe"),
    Path("/Applications/LTspice.app/Contents/MacOS/LTspice"),
]
BINARY = os.environ.get("LTSPICE_BINARY") or next((str(p) for p in _CANDIDATES if p.exists()), str(_CANDIDATES[0]))
TIMEOUT = 900.0


def run(netlist: Path, timeout: float | None = None) -> dict[str, np.ndarray]:
    netlist = Path(netlist).resolve()
    done = subprocess.run([BINARY, "-b", netlist.name], cwd=netlist.parent, timeout=timeout or TIMEOUT,
                          capture_output=True)
    raw = netlist.with_suffix(".raw")
    if done.returncode != 0 or not raw.exists():
        raise RuntimeError(f"LTspice failed (code {done.returncode}) for {netlist}")
    return read_raw(raw)
