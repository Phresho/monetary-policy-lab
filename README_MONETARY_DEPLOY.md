# Monetary Policy Lab: hosting it on the VM under `/monetary/`

For Jesse and Friso. The Monetary Policy Lab is its own repository (`Phresho/monetary-policy-lab`) and its own
service on the Azure VM, next to the other apps behind the one Caddy server (`DTOSim-Caddy`, config
`C:\DTOSim\deploy\Caddyfile`). Nothing here touches the Housing repo, the Housing service or its files.

| Port | App | Path |
|---|---|---|
| 8000 | DTOSim | `/` on the Azure address |
| 8001 | DynamicBI | `/dynabi/` |
| 8002 | Housing Policy Lab | `/housing/` |
| **8003** | **Monetary Policy Lab** | **`/monetary/`** |

## 1. Install (PowerShell)

```powershell
cd C:\
git clone https://github.com/Phresho/monetary-policy-lab.git
cd C:\monetary-policy-lab
python -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements.txt

$env:NGSPICE_LIBRARY_PATH = "C:\ngspice\Spice64_dll\dll-vs\ngspice.dll"   # the DLL the Housing service already uses
$env:SPICE_LIB_DIR        = "C:\ngspice\Spice64_dll\share\ngspice"
.venv\Scripts\python -m pytest -q tests\test_monetary.py                   # must pass, not skip

cd monetary_frontend; npm ci; npm run build; cd ..
```

Check the DLL paths on the VM first. The Housing service and this one each load the DLL in their own process, so
they do not share ngspice's lock.

There is no `--base` flag for the build. The front end uses only relative paths (`base: './'` in
`monetary_frontend/vite.config.ts`, API calls to `fetch('api' + path)`), so the same build works at `/` and at
`/monetary/`.

## 2. Service (NSSM, as for the other services)

```powershell
nssm install MonetaryLab "C:\monetary-policy-lab\.venv\Scripts\python.exe" "backend\run_monetary.py --port 8003"
nssm set MonetaryLab AppDirectory "C:\monetary-policy-lab"
nssm set MonetaryLab AppEnvironmentExtra NGSPICE_LIBRARY_PATH=C:\ngspice\Spice64_dll\dll-vs\ngspice.dll SPICE_LIB_DIR=C:\ngspice\Spice64_dll\share\ngspice
nssm start MonetaryLab
```

The server listens on 127.0.0.1 only. Optional: `MONETARY_NGSPICE_TIMEOUT` (seconds before a stuck run is stopped,
default 120).

Check on the VM: `http://127.0.0.1:8003/api/catalogue` returns JSON with `"solver": "ngspice"` (`null` means the DLL
was not found).

## 3. Caddy route (Jesse)

In the site block of the Caddyfile, next to the `/housing/` route:

```
# Monetary Policy Lab (Friso, own repository, service MonetaryLab on 127.0.0.1:8003)
redir /monetary /monetary/
handle_path /monetary/* {
    reverse_proxy 127.0.0.1:8003
}
```

Then validate and reload Caddy. `handle_path` strips the `/monetary` prefix: the app serves its page at `/`, its
files at `/assets/…` and its API at `/api/…`. The redirect to the trailing slash matters: without it the relative
URLs resolve on the site root and the page stays blank. Caddy sets no response timeout by default, so runs of
15–40 s get through. `/monetary/api/...` goes to this app, not to DynaBI's `/api/`, because the `/monetary/` prefix
is matched first.

Tested locally: a proxy that strips `/monetary` in front of `run_monetary.py`. `/monetary` redirected to
`/monetary/`, the circuit map loaded, a simulation ran and all charts drew, with no failed requests.

## 4. Landing page (Jesse)

A Monetary card on `economicsystemsandcontrol.com`, in the same style as Housing and Energy: sector name, the
problems in two short bullets, and an "Open the platform" button to `/monetary/`.

- **Sector:** Monetary policy
- **Problems:** (Friso sends these two lines)
- **Button:** Open the platform → `/monetary/`

## 5. Check after deploying

- `https://economicsystemsandcontrol.com/monetary` redirects to `/monetary/` and opens the **Circuit map**.
- **Simulation tab:** the first run starts by itself and takes 10–15 s; the charts and KPI tiles fill.
- **Frequency analysis:** the first analysis takes up to about 40 s, and the robustness map appears.
- `https://economicsystemsandcontrol.com/monetary/api/catalogue` shows `"solver": "ngspice"`.

## 6. Updating later

1. `git pull` in `C:\monetary-policy-lab`.
2. Backend changed: `.venv\Scripts\python -m pip install -r backend\requirements.txt` and the tests.
3. Front end changed: `cd monetary_frontend; npm ci; npm run build`.
4. `nssm restart MonetaryLab` (backend changes only; a new front-end build is picked up on refresh).

## Good to know

- **Load:** a run takes 10–15 s of one CPU core, and at most 2 simulations run at the same time (`SLOTS` in
  `backend/monetary/server.py`). Steady states and frequency linearisations are cached in memory per scenario.
- **Logs:** the server prints nothing for normal requests. A failed run shows its message in the page and returns
  HTTP 422.
- **Blank page:** check that the URL ends in `/monetary/`. A 503 with "Front end not built" means `npm run build`
  was not run.
- **Model:** the app runs `model/Model_Bank_20261111_bank_cleaned up.net`. The file name has a space, so quote it in
  shell commands. LTspice output (`model/*.raw`, `.db`, `.log`) is git-ignored and must not be committed (one `.raw`
  was 334 MB, over GitHub's 100 MB limit).
- **More detail:** `README.md` describes the code, tests and design.

Questions: Friso (`Phresho` on GitHub).
