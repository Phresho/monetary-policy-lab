"""API and static front end for the monetary policy app."""
from __future__ import annotations
import mimetypes
import threading
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import ngspice as ng
from .scenario import CONSTANTS, DEFAULTS, PHI_TARGET, SERIES, T_STOP, UNITS_PER_YEAR, Scenario, run

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "monetary_frontend" / "dist"
# Python reads MIME types from the Windows registry, where .js is often text/plain; browsers then refuse the module
# script (blank page). Set the types the front end needs explicitly.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
SLOTS = threading.BoundedSemaphore(2)  # ngspice runs one at a time anyway (shared library lock)


class AnalysisRequest(BaseModel):
    scenario: Scenario
    t_op_years: float = Field(0.0, ge=0, le=13)


class SweepRequest(BaseModel):
    scenario: Scenario
    t_op_years: float = Field(0.0, ge=0, le=13)
    ki_max: float = Field(2.0, gt=0, le=5)
    kd_max: float = Field(10.0, gt=0, le=20)
    n: int = Field(21, ge=5, le=41)


class TransferRequest(BaseModel):
    scenario: Scenario
    input: str = Field(max_length=80)
    output: str = Field(max_length=80)
    closed: bool = False
    t_op_years: float = Field(0.0, ge=0, le=13)


class RobustRequest(BaseModel):
    scenario: Scenario
    t_op_years: float = Field(0.0, ge=0, le=13)
    M: float = Field(2.0, ge=1.05, le=10)          # peak of |S| allowed
    wB: float = Field(2.0, gt=0, le=200)           # performance bandwidth, rad/yr
    delta: float = Field(0.1, ge=0, le=2)          # extra model error on top of the plant family
    ks_max: float = Field(2.0, gt=0, le=100)       # largest |K S|
    method: Literal["hinf", "mu"] = "hinf"
    free: Literal["ki_kd", "all"] = "ki_kd"


class TraceRequest(BaseModel):
    scenario: Scenario
    element: str = Field(max_length=80)


def create_app() -> FastAPI:
    app = FastAPI(title="Monetary policy lab")
    app.add_middleware(GZipMiddleware, minimum_size=2000)

    @app.get("/api/catalogue")
    def catalogue():
        return {"defaults": Scenario().model_dump(), "netlist": DEFAULTS, "schema": Scenario.model_json_schema(),
                "series": [{"key": k, "label": l, "unit": u} for k, l, u, _ in SERIES],
                "time": {"units_per_year": UNITS_PER_YEAR, "t_stop": T_STOP}, "phi_target": PHI_TARGET,
                "constants": list(CONSTANTS.values()), "solver": "ngspice" if ng.available() else None}

    @app.post("/api/runs")
    def create_run(scenario: Scenario):  # FastAPI runs this in its thread pool
        with SLOTS:
            try:
                return run(scenario)
            except (RuntimeError, ValueError, OSError) as error:
                raise HTTPException(422, f"Simulation failed: {error}") from error

    @app.get("/api/model/map")
    def model_map():
        from . import schematic
        return schematic.model_map()

    @app.get("/api/dashboard")
    def dashboard_list():
        from . import schematic
        return schematic.dashboard()

    @app.post("/api/dashboard/values")
    def dashboard_vals(scenario: Scenario):
        from .scenario import dashboard_values
        with SLOTS:
            try:
                return dashboard_values(scenario)
            except (RuntimeError, ValueError, OSError) as error:
                raise HTTPException(422, f"Simulation failed: {error}") from error

    @app.post("/api/controller/parts")
    def controller_parts(scenario: Scenario):
        """Each part of the policy rule (r*, P, I, D, the lower bound) over the run: its share of the control effort."""
        from .scenario import controller_parts as parts
        with SLOTS:
            try:
                return parts(scenario)
            except (RuntimeError, ValueError, OSError, KeyError) as error:
                raise HTTPException(422, f"Simulation failed: {error}") from error

    @app.post("/api/trace")
    def trace(request: TraceRequest):
        from .scenario import element_trace
        with SLOTS:
            try:
                return element_trace(request.scenario, request.element)
            except KeyError as error:
                raise HTTPException(404, str(error)) from error
            except (RuntimeError, ValueError, OSError) as error:
                raise HTTPException(422, f"Simulation failed: {error}") from error

    @app.post("/api/analysis")
    def analysis(request: AnalysisRequest):
        from . import frequency
        with SLOTS:
            try:
                return frequency.analyze(request.scenario, request.t_op_years)
            except (RuntimeError, ValueError, OSError, np.linalg.LinAlgError) as error:
                raise HTTPException(422, f"Analysis failed: {error}") from error

    @app.post("/api/flows")
    def flows(scenario: Scenario):
        from . import flows as fl
        with SLOTS:
            try:
                return fl.sector_flows(scenario)
            except (RuntimeError, ValueError, OSError) as error:
                raise HTTPException(422, f"Simulation failed: {error}") from error

    @app.post("/api/wireflow")
    def wireflow(scenario: Scenario):
        """Current along every drawn (non-ground) wire over time, for the moving dots on the circuit map."""
        from . import wireflow as wf
        with SLOTS:
            try:
                return wf.wire_currents(scenario)
            except (RuntimeError, ValueError, OSError) as error:
                raise HTTPException(422, f"Simulation failed: {error}") from error

    @app.post("/api/transfer")
    def transfer(request: TransferRequest):
        """Transfer function between two elements (an extra flow into the first, the current of the second)."""
        from . import transfer as tf
        with SLOTS:
            try:
                return tf.transfer(request.scenario, request.input, request.output, request.closed, request.t_op_years)
            except KeyError as error:
                raise HTTPException(404, str(error).strip("'")) from error
            except (RuntimeError, ValueError, OSError, np.linalg.LinAlgError) as error:
                raise HTTPException(422, f"Transfer function failed: {error}") from error

    def _weights(r: "RobustRequest"):
        from . import robust as rb
        return rb.Weights(r.M, r.wB, r.delta, r.ks_max)

    @app.post("/api/robust")
    def robust(request: RobustRequest):
        """H-infinity and mu measures of the current rule against the plant family."""
        from . import robust as rb
        with SLOTS:
            try:
                return rb.evaluate(request.scenario, request.t_op_years, _weights(request))
            except (RuntimeError, ValueError, OSError, np.linalg.LinAlgError) as error:
                raise HTTPException(422, f"Robustness analysis failed: {error}") from error

    @app.post("/api/robust/tune")
    def robust_tune(request: RobustRequest):
        """PID gains from a fixed-structure H-infinity or mu design."""
        from . import robust as rb
        with SLOTS:
            try:
                return rb.tune(request.scenario, request.t_op_years, _weights(request), request.method, request.free)
            except (RuntimeError, ValueError, OSError, np.linalg.LinAlgError) as error:
                raise HTTPException(422, f"Tuning failed: {error}") from error

    @app.post("/api/sweep")
    def sweep(request: SweepRequest):
        from . import frequency
        with SLOTS:
            try:
                return frequency.sweep(request.scenario, request.t_op_years, request.ki_max, request.kd_max, request.n)
            except (RuntimeError, ValueError, OSError, np.linalg.LinAlgError) as error:
                raise HTTPException(422, f"Sweep failed: {error}") from error

    if (DIST / "assets").exists():
        app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        if not (DIST / "index.html").exists():
            raise HTTPException(503, "Front end not built. Run npm run build in monetary_frontend/.")
        return FileResponse(DIST / "index.html")

    return app
