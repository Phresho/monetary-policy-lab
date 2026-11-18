# Monetary Policy Lab: merging and hosting it next to the Housing Lab

For Jesse. This explains how to merge Friso's branch `FrisoMonetary2` and run the Monetary Policy Lab on the Azure VM
as a third site under `/monetary/`, with its own tile on the landing page, next to DynaBI and the Housing Lab.

**What the branch changes.** It adds a separate app: `backend/monetary/`, `backend/run_monetary.py`,
`monetary_frontend/`, `start_monetary.cmd`, the model `model/Model_Bank_20261111_bank_cleaned up.net/.asc`, and
`tests/test_monetary.py`. It also extends `README.md` and `.gitignore`. Nothing else changes: `frontend/`,
`backend/housing/`, `backend/run.py`, `ci/` and `.github/` are the same as on `main`, so the Housing Lab and its
service keep running as they are. The two apps share `backend/requirements.txt`, which gets no new packages.

## 1. Merge

- `FrisoMonetary2` starts at `main` (`d2599e5`), so the merge is a fast-forward without conflicts.
- Open the pull request from Friso's fork: https://github.com/Phresho/housing_policy_design/pull/new/FrisoMonetary2
  (base: `jessedeklerk2000-creator/housing_policy_design` `main`).
- The `windows-ngspice` workflow runs on the PR. Its `pytest` step also runs `tests/test_monetary.py` (21 tests,
  about 2 minutes). These tests need only ngspice, not LTspice, and skip themselves when the ngspice DLL is missing.

## 2. Install on the VM (PowerShell, repository root)

The steps below use the Python and ngspice DLL that the Housing service already uses.

```powershell
git pull                                              # main, after the merge
python -m pip install -r backend/requirements.txt     # no new packages; safe to run

# the same ngspice 45.2 DLL as the Housing service (README, "Windows")
$env:NGSPICE_LIBRARY_PATH = "C:\ngspice\Spice64_dll\dll-vs\ngspice.dll"
$env:SPICE_LIB_DIR        = "C:\ngspice\Spice64_dll\share\ngspice"
python -m pytest -q tests/test_monetary.py            # must pass, not skip (skips mean the DLL was not found)

cd monetary_frontend
npm ci
npm run build                                         # writes monetary_frontend/dist (git-ignored, so build it on the VM)
cd ..
```

There is no `--base` flag for this build. The front end uses only relative paths: `base: './'` in
`monetary_frontend/vite.config.ts`, and API calls go to `fetch('api' + path)`. So the same build works at `/`, at
`/monetary/`, or at any other path.

## 3. Run it as a Windows service

The server:

```powershell
python backend/run_monetary.py --port 8003            # listens on 127.0.0.1 only
```

| Port | Site |
|---|---|
| 8001 | DynaBI |
| 8002 | Housing Lab (`/housing/`) |
| **8003** | **Monetary Policy Lab (`/monetary/`)**: a suggestion, any free port works |

Environment variables for the service:

| Variable | Value | Needed |
|---|---|---|
| `NGSPICE_LIBRARY_PATH` | `C:\ngspice\Spice64_dll\dll-vs\ngspice.dll` | yes |
| `SPICE_LIB_DIR` | `C:\ngspice\Spice64_dll\share\ngspice` | yes |
| `MONETARY_NGSPICE_TIMEOUT` | seconds before a stuck run is stopped (default `120`) | no |

Set up the service with the same tool you used for the Housing service. If that is NSSM, for example:

```powershell
nssm install MonetaryLab "C:\path\to\python.exe" "backend\run_monetary.py --port 8003"
nssm set MonetaryLab AppDirectory "C:\path\to\housing_policy_design"
nssm set MonetaryLab AppEnvironmentExtra NGSPICE_LIBRARY_PATH=C:\ngspice\Spice64_dll\dll-vs\ngspice.dll SPICE_LIB_DIR=C:\ngspice\Spice64_dll\share\ngspice
nssm start MonetaryLab
```

Check it on the VM: `http://127.0.0.1:8003/api/catalogue` returns JSON with `"solver": "ngspice"`.
`"solver": null` means the DLL was not found.

## 4. Route `/monetary/` to it

Add a route next to the existing `/housing/` one, in whatever the VM uses for that (IIS, Caddy, nginx). It needs:

1. **`/monetary/…` → `http://127.0.0.1:8003/…`, with the `/monetary` prefix stripped.** The app serves its page at
   `/`, its files at `/assets/…` and its API at `/api/…`.
2. **A redirect from `/monetary` to `/monetary/`, with the trailing slash.** Without the slash, the relative URLs
   resolve to `/assets/…` and `/api/…` on the site root, so the page stays blank.
3. **A long proxy timeout.** The first run of a scenario takes 10–15 s, and a frequency analysis at a new Kp takes
   15–40 s. Allow about 120 s.

Examples (pick the one that matches the VM):

```xml
<!-- IIS (URL Rewrite + ARR), web.config of the site root -->
<rule name="monetary-slash" stopProcessing="true">
  <match url="^monetary$" />
  <action type="Redirect" url="monetary/" redirectType="Permanent" />
</rule>
<rule name="monetary" stopProcessing="true">
  <match url="^monetary/(.*)" />
  <action type="Rewrite" url="http://127.0.0.1:8003/{R:1}" />
</rule>
```

```
# Caddy
redir /monetary /monetary/
handle_path /monetary/* {
    reverse_proxy 127.0.0.1:8003
}
```

```nginx
# nginx
location = /monetary { return 301 /monetary/; }
location /monetary/ {
    proxy_pass http://127.0.0.1:8003/;
    proxy_read_timeout 120s;
}
```

Friso tested exactly this set-up locally: a proxy that strips `/monetary` in front of `run_monetary.py`. Opening
`/monetary` redirected to `/monetary/`, the circuit map loaded, a simulation ran and all 14 charts drew, with no
failed requests.

## 5. The tile on the landing page

Add a tile next to the DynaBI and Housing tiles:

- **Title:** Monetary Policy Lab
- **Link:** `/monetary/`
- **Text:** Monetary policy as a control loop: the ECB's rule against a stock-flow model of the euro-area economy (an LTspice circuit), with the circuit map, simulation, frequency analysis and sector flows.

## 6. Check after deploying

- `https://<site>/monetary` redirects to `/monetary/` and opens the **Circuit map**, the start page.
- **Simulation tab:** the first run starts by itself and takes 10–15 s. The charts and KPI tiles fill.
- **Frequency analysis:** the first analysis takes up to about 40 s, and the robustness map appears.
- `https://<site>/monetary/api/catalogue` shows `"solver": "ngspice"`.

## 7. Updating later

Same routine as the Housing Lab:

1. `git pull`.
2. If `backend/` or `backend/requirements.txt` changed: `pip install -r backend/requirements.txt` and
   `pytest -q tests/test_monetary.py`.
3. If `monetary_frontend/` changed: `cd monetary_frontend && npm ci && npm run build`.
4. Restart the `MonetaryLab` service. Only backend changes need a restart; the page picks up a new build when it
   is refreshed.

## Good to know

- **Load:** a run takes 10–15 s of one CPU core, and at most 2 simulations run at the same time (`SLOTS` in
  `backend/monetary/server.py`). The steady states and the frequency linearisations are cached in memory per
  scenario, so repeated runs are faster.
- **Logs:** the server prints nothing for normal requests. A failed run shows its message in the page and returns
  HTTP 422.
- **Blank page:** check that the URL ends in `/monetary/`. A 503 with "Front end not built" means step 2's
  `npm run build` was not run.
- **Model:** the app runs `model/Model_Bank_20261111_bank_cleaned up.net`. That file name has a space, so quote it
  in shell commands. LTspice output (`model/*.raw`, `.db`, `.log`) is git-ignored and must not be committed: one
  `.raw` was 334 MB, over GitHub's 100 MB limit.
- **More detail:** the "Monetary Policy Lab" section of `README.md` describes the code, tests and design.

Questions: Friso (`Phresho` on GitHub).
