"""Start the monetary policy app: python backend/run_monetary.py [--port 8010]"""
import argparse
import sys
from pathlib import Path
import uvicorn
sys.path.insert(0, str(Path(__file__).resolve().parent))
from monetary.server import create_app

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8010)
args = parser.parse_args()
uvicorn.run(create_app(), host="127.0.0.1", port=args.port)
