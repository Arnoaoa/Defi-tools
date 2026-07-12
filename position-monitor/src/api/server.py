"""FastAPI app — exposes monitor state to the Next.js dashboard.

Run with: `uvicorn src.api.server:app --reload --port 8000`

All endpoints are READ-ONLY. The dashboard never triggers actions on the monitor.
CORS is locked to a single origin (default http://localhost:3000), configurable
via DASHBOARD_ORIGIN env var.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from src.api import routes  # noqa: E402
from src.api import routes_manual  # noqa: E402
from src.api import routes_positions  # noqa: E402
from src.api import routes_strategies_crud  # noqa: E402

app = FastAPI(
    title="Position Monitor API",
    version="0.1.0",
    description="Read-only view of DeFi position monitor state",
)

origin = os.getenv("DASHBOARD_ORIGIN", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["*"],
)

app.include_router(routes.router, prefix="/api")
app.include_router(routes_manual.router, prefix="/api")
app.include_router(routes_positions.router)
app.include_router(routes_strategies_crud.router, prefix="/api")
