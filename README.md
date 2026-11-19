# Monetary Policy Lab

Monetary policy as a control loop: the central bank's interest-rate rule against a stock-flow model of the economy
with a central bank, banks, households, firms, government and a foreign sector. The model is an LTspice circuit
(`model/Model_Bank_20261111_bank_cleaned up.net`, drawn in `Model_Bank_20261111_bank_cleaned up.asc`) and runs on
ngspice. The web app shows it as a circuit map, with simulation, frequency analysis and sector flows.

Live (once hosted): `https://economicsystemsandcontrol.com/monetary/`. Hosting on the VM: `README_MONETARY_DEPLOY.md`.

## Run (Windows)
First time:
```
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements.txt
cd monetary_frontend && npm install && npm run build
```
The ngspice DLL is taken from `tools/ngspice/Spice64_dll/` (git-ignored) unless `NGSPICE_LIBRARY_PATH` is set. To get it
(PowerShell, repository root):
```
curl.exe -fsSL -o ngspice.7z https://sourceforge.net/projects/ngspice/files/ng-spice-rework/old-releases/45.2/ngspice-45.2_dll_64.7z/download
(Get-FileHash -Algorithm SHA256 ngspice.7z).Hash   # FF110EBB04367EB37FF3C88C75AB3BEA1B2191C11EFCE78F264C2CA73034762B
7z x ngspice.7z -otools\ngspice                    # gives tools\ngspice\Spice64_dll\...
```
Then `start_monetary.cmd` opens http://127.0.0.1:8010 (`backend/run_monetary.py --port 8010`).
`MONETARY_NGSPICE_TIMEOUT` (default 120 s) stops a hanging run.

After front-end edits: `cd monetary_frontend && npm run build`. After Python edits: restart.

## Check
`.venv\Scripts\python -m pytest -q tests/test_monetary.py` (must pass, not skip: skips mean the DLL was not found) and
`cd monetary_frontend && npx tsc --noEmit`. The same tests run in GitHub Actions (`.github/workflows/windows-ngspice.yml`,
Windows with the official ngspice 45.2 DLL).

## How it works
- `backend/monetary/netlist.py`: run netlists from the unchanged model file; every option replaces exact, asserted lines (open loop: the rate source `B§R`; closed loop: the policy rule `B_PI`).
- `ngspice.py`: LTspice syntax to ngspice, runs through the shared DLL in a background thread with a timeout; AC analysis and integrator states for the frequency analysis. `ltspice.py` is the reference solver.
- Policy rule gains: the app starts from Kp 0.06, **Ki 0.04**, Kd 1.5 (filtered derivative). The netlist's Ki = 0.44 makes the closed loop oscillate (unstable, inflation std 3.6 points in ngspice and in LTspice); this is not the derivative term: without it (Kd = 0) the oscillation is larger (std 6.2). With Ki 0.04 the loop is stable, phase margin about 50 deg, Ms 1.55. The netlist values stay as the slider hints. `model/Model_Bank_20261111_bank_cleaned up_steady_closed.asc` is the steady-start closed-loop drawing with Ki 0.04 (`python -m monetary.asc --closed --ki 0.04` from `backend/`), `..._cleaned up_steady.asc` the open-loop one.
- `steady.py`: steady-state start. The forcing `.ic` lines are removed, the operating point settles the fast part and a root finder sets the free integrators so their inputs are zero; stocks (capital, debt, wage index) keep their start values. Without it the netlist's own start makes inflation spike in the first months.
- `scenario.py`: scenario inputs (open-loop rate path, rule gains Kp/Ki/Kd, derivative filter, R*, target, start time), output series and metrics. 120 model time units = 1 year (from the /120 in the interest flows).
- `frequency.py`: plant rate -> inflation from ngspice's AC analysis, linearised at the steady state or a chosen year; loop, margins, Ms, Nyquist, S/T, plant poles by vector fitting, closed-loop poles and linear step response.
- `schematic.py`: parses the `.asc`, rebuilds the nets from the drawing, checks them against the netlist (53 nodes) and gives each element its sector and the links between sectors.
- `flows.py`: flows between sectors. At every node shared by two or more sectors, the current each sector's elements push in (I(x) enters the element's second node) is summed per sector; these sums add up to zero (Kirchhoff, tested). Goods, labour and money nodes are mixed, so the page shows them per node.
- `frequency.sweep`: robustness map over Ki × Kd at the current Kp (Ms, phase margin, linear verdict per cell) from the cached plant and fit, without extra simulations. In closed loop at a later year the plant itself depends on Ki and Kd; the map then keeps the current plant (flagged `approx`).
- `wireflow.py`: the current along every drawn wire (a tree per node from the drawing; exact at the element pins, balanced per node), for the dots on the circuit map.
- `transfer.py`: transfer function between two elements (ctrl-click two flows on the circuit map). An extra flow d is pushed into the first (a behavioural source gets `+ d` in its expression, another element a parallel current source), ngspice's AC analysis gives every element's response; closed loop T = G(in→out) + G(R→out)·S·K·G(in→π) with the rule K = C·H. Bode, a vector-fitted model (poles, zeros, error) and its step response. The controller's internal parts are refused in closed loop (the AC model has no signal path there; pick u).
- `robust.py`: H∞ and μ for the PID rule. Uncertainty: the plant linearised at years 0, 2, …, 12 of the scenario's rate path (it mostly loses gain as the economy grows, 30–66 %), at least an extra error δ, as a multiplicative weight W_T. Performance W_P = (s/M + ω_B)/(s + ω_B·ε), effort limit |K·S| ≤ KS_max. With one scalar uncertainty μ is exact: NP = max|W_P S|, RS = max|W_T T|, RP = max(|W_P S| + |W_T T|). Tuning is fixed-structure (Nelder–Mead on the gains, closed loop of the fitted plant required stable): H∞ minimises ‖[W_P S; W_T T; W_U KS]‖∞, μ minimises μ_RP. By default only Ki and Kd move: Kp also sets the steady state the plant is linearised at, and above Kp ≈ 0.3 the economy has no steady state near its starting inflation.
- `steady.steady_start`: the start inflation is a fixed point, found with secant steps (the plain iteration ran out of rounds for Kp ≥ 0.15).
- `server.py`: FastAPI (`/api/catalogue`, `/api/runs`, `/api/analysis`, `/api/sweep`, `/api/flows`, `/api/wireflow`, `/api/transfer`, `/api/robust`, `/api/robust/tune`, `/api/model/map`, `/api/trace`), serves `monetary_frontend/dist`.
- `monetary_frontend/`: React + Plotly with five tabs. Circuit map (the start page, `ModelMap.tsx`): layers that unfold in place: the policy loop (central bank → interest rates → economy → CPI values → back, shock), the economy opened into its sectors with the flows and signals between them, and any block opened to its own circuit from the `.asc` drawing (click an element for its equation and trace). Layers 0 and 1 are laid out by hand (`TOP`, `INNER`); layer 2 is the drawing. Wheel/pinch zoom (native non-passive listener), drag, zoom buttons, Fit, breadcrumbs, 'Whole circuit'. A time bar sets the moment shown: dots on the plant's wires sit where the charge that has passed puts them (as in Falstad's circuit simulator), so they move forward and back with the slider; imported variables open their chart inside their tile. The opened Controller is drawn as a classic PID (e = π_f − π* into P, I and D, Σ with r*, the lower bound r̲ = −0.5 %, the smoothing R15·C8, r); a link switches to the LTspice drawing. Then Simulation (KPI tiles with sparkline and delta, inflation gap with ±1 pt band, rates along the chain, transmission small multiples with a "compare sizes" index mode, balance sheets, run library with compare), Frequency analysis (robustness map, Bode, Nyquist, S/T, poles, step), Robust control (weights, NP/RS/RP tiles, μ over frequency, the plant set, H∞ and μ tuning with Apply), Sector flows (Sankey per year, node table, node over time) and Model map. Circuit map (FrisoMonetary3): the loop blocks are named Mandate, Central bank, Eurozone-Economy and Inflation measurement; the grey region box is gone; the loop signals sit in dots on their lines; the switches in the loop (and the open/closed badge) open and close the loop and start a run. At every box edge the flow over a wire is a dot with its name (f, the element carrying the flow between the two agents) and the effort e sits on a line between that wire and its return wire, each clickable; in the whole-circuit view too. The central bank opens in place on the loop's axis, so e enters and r leaves at its edges; the PID shows the gains filled in and each part's value at the moment on the time bar, and a click on a part shows its share of the control effort over the run (`POST /api/controller/parts`). For that the run netlist writes B_PI as r* + I(PI_P) + I(PI_I) + I(PI_Dterm), each part its own source (`netlist.split_rule`, used by `scenario.build`; `netlist.build` and the LTspice export stay the netlist). The settings panel on the left folds in to a narrow rail (« / », remembered per browser); the circuit map then uses the full width. Changeable model variables (`ModelVars.tsx`, on the Circuit map and Simulation tabs): every source with a fixed number in the netlist (Simple ROI, R_for, APP, the fixed import and export flows; found by `scenario.CONSTANTS`, the inflation target keeps its own slider) gets a slider and a number field; a scenario carries the changed ones in `constants` and `scenario.build` writes them into the run netlist, so runs, the frequency analysis, robust control and transfer functions all use them.

## Charts
Colours live in `monetary_frontend/src/viz.ts` and follow the quantity, not the chart: inflation blue, rates orange, real economy aqua; the four rates are one orange ramp from the policy rate outwards; reference lines (target, Φ) are ink; compared runs grey dashed; red/green only for the stability verdict, always with ✓/✕. The sets were checked with the dataviz skill's `validate_palette.js` (categorical: all pairs, light and dark; ramps: `--ordinal`); re-run it when a colour changes. Light and dark themes follow the OS or the Theme selector. Every chart has Table and CSV; time charts share a crosshair.

