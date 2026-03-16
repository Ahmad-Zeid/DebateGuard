#!/bin/bash

# Debate Guard — Start both backend and frontend

trap 'kill 0; exit' SIGINT SIGTERM

echo "🛡️  Starting Debate Guard..."
echo ""

# Backend
echo "🔧 Starting backend (uvicorn on :8000)..."
cd backend && uv run python main.py &

# Frontend
echo "⚛️  Starting frontend (vite on :5173)..."
cd frontend && npm run dev &

echo ""
echo "✅ Backend:  http://localhost:8000"
echo "✅ Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both."

wait
