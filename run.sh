#!/bin/bash

# Debate Guard — Start both backend and frontend

trap 'kill 0; exit' SIGINT SIGTERM

SETUP_MODE=false
if [ "$1" == "-setup" ]; then
    SETUP_MODE=true
fi

echo "🛡️  Starting Debate Guard..."
echo ""

# Check dependencies if not in setup mode
if [ "$SETUP_MODE" = false ]; then
    echo "🔍 Checking dependencies..."
    MISSING_DEPS=false
    
    if [ ! -d "backend/.venv" ]; then
        echo "❌ Backend virtual environment not found."
        MISSING_DEPS=true
    fi
    
    if [ ! -d "frontend/node_modules" ]; then
        echo "❌ Frontend node_modules not found."
        MISSING_DEPS=true
    fi
    
    if [ "$MISSING_DEPS" = true ]; then
        echo "⚠️  Missing dependencies detected!"
        echo "Please run './run.sh -setup' to install all required dependencies before starting."
        exit 1
    fi
    echo "✅ Dependencies verified."
    echo ""
else
    echo "📦 Setup mode active. Installing dependencies..."
    
    echo "Setting up backend dependencies..."
    cd backend
    uv sync
    cd ..
    
    echo "Setting up frontend dependencies..."
    cd frontend
    npm install
    cd ..
    
    echo "✅ Setup complete!"
    echo ""
fi

# Backend
echo "🔧 Starting backend (uvicorn on :8000)..."
cd backend && uv run python main.py &
BACKEND_PID=$!

# Frontend
echo "⚛️  Starting frontend (vite on :5173)..."
cd frontend && npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ Backend:  http://localhost:8000"
echo "✅ Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both."

wait
