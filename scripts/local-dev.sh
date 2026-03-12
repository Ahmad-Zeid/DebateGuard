#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3.11}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN="python3"
fi
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

if [ ! -d "backend/.venv" ]; then
  "$PYTHON_BIN" -m venv backend/.venv
fi

if [ -f "backend/.venv/bin/activate" ]; then
  # Linux/macOS
  # shellcheck source=/dev/null
  source backend/.venv/bin/activate
else
  # Git Bash on Windows
  # shellcheck source=/dev/null
  source backend/.venv/Scripts/activate
fi

pip install -r backend/requirements.txt

(
  cd backend
  uvicorn app:app --reload --host 0.0.0.0 --port 8000
) &
BACKEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd frontend
if [ ! -d "node_modules" ]; then
  npm install
fi
npm run dev -- --host 0.0.0.0 --port 5173

