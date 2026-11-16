"""Reader for LTspice binary .raw transient files (double time, float32 signals)."""
from __future__ import annotations
import re
from pathlib import Path
import numpy as np

MARKER = "Binary:\n".encode("utf-16-le")


def read_raw(path: str | Path) -> dict[str, np.ndarray]:
    """Return {signal name: samples} with a monotonic 'time' entry."""
    data = Path(path).read_bytes()
    split = data.find(MARKER)
    if split < 0:
        raise ValueError(f"{path}: not a binary LTspice raw file")
    header = data[:split].decode("utf-16-le")
    count = int(re.search(r"No\. Variables: (\d+)", header)[1])
    points = int(re.search(r"No\. Points: +(\d+)", header)[1])
    names = [line.split("\t")[2] for line in header.split("Variables:\n")[1].splitlines() if line.strip()]
    if len(names) != count:
        raise ValueError(f"{path}: header lists {len(names)} of {count} variables")
    record = np.dtype([("time", "<f8"), ("values", "<f4", (count - 1,))])
    table = np.frombuffer(data, record, points, split + len(MARKER))
    out = {"time": np.abs(table["time"])}
    for index, name in enumerate(names[1:]):
        out[name] = table["values"][:, index].astype(float)
    return out
