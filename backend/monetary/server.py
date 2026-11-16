"""API and static front end for the monetary policy app."""
from __future__ import annotations
import mimetypes
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import ngspice as ng
from .scenario import DEFAULTS, SERIES, T_STOP, UNITS_PER_YEAR, Scenario, run

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "monetary_frontend" / "dist"
# Python reads MIME types from the Windows registry, where .js is often text/plain; browsers then refuse the module
# script (blank page). Set the types the front end needs explicitly.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
SLOTS = threading.BoundedSemaphore(2)  # ngspice runs one at a time anyway (shared library lock)


def create_app() -> FastAPI:
    app = FastAPI(title="Monetary policy lab")
    app.add_middleware(GZipMiddleware, minimum_size=2000)

    @app.get("/api/catalogue")
    def catalogue():
        return {"defaults": Scenario().model_dump(), "netlist": DEFAULTS, "schema": Scenario.model_json_schema(),
                "series": [{"key": k, "label": l, "unit": u} for k, l, u, _ in SERIES],
                "time": {"units_per_year": UNITS_PER_YEAR, "t_stop": T_STOP}, "solver": "ngspice" if ng.available() else None}

    @app.post("/api/runs")
    def create_run(scenario: Scenario):  # FastAPI runs this in its thread pool
        with SLOTS:
            try:
                return run(scenario)
            except (RuntimeError, ValueError, OSError) as error:
                raise HTTPException(422, f"Simulation failed: {error}") from error

    if (DIST / "assets").exists():
        app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        if not (DIST / "index.html").exists():
            raise HTTPException(503, "Front end not built. Run npm run build in monetary_frontend/.")
        return FileResponse(DIST / "index.html")

    return app
