#!/bin/bash
# Terminus Phase 1 Backend Startup Script

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/backend" && pwd)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🚀 Starting Terminus Phase 1 Backend"
echo "Backend directory: $BACKEND_DIR"

# Check Python version
if ! command -v python3 >/dev/null 2>&1; then
    echo "❌ Python 3 not found"
    exit 1
fi

PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Python version: $PY_VER"

# Install dependencies if needed
if [ ! -d "$BACKEND_DIR/venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv "$BACKEND_DIR/venv"
fi

echo "📦 Activating virtual environment..."
source "$BACKEND_DIR/venv/bin/activate"

echo "📦 Installing requirements..."
pip install -q -r "$BACKEND_DIR/requirements.txt"

echo "✅ Setup complete"
echo ""
echo "Starting FastAPI server on http://localhost:8000"
echo "Press Ctrl+C to stop"
echo ""

# Load environment from repo root
cd "$REPO_ROOT"
export $(grep -v '^#' .env | xargs)

# Start the app
cd "$BACKEND_DIR"
python3 main.py
