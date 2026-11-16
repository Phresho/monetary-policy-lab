@echo off
rem Starts the Monetary Policy Lab at http://127.0.0.1:8010
rem First time only: py -3.12 -m venv .venv ^&^& .venv\Scripts\python -m pip install -r backend\requirements.txt
rem After front-end edits: cd monetary_frontend ^&^& npm install ^&^& npm run build
cd /d "%~dp0"
start "" http://127.0.0.1:8010/
.venv\Scripts\python.exe backend\run_monetary.py --port 8010
