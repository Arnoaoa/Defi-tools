"""CRUD for manual positions (typed in via the dashboard)."""
from __future__ import annotations

import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from src.storage import Database

router = APIRouter(prefix="/manual_positions")

_VALID_SIDES = {"long", "short", "collateral", "debt", "spot"}


def _get_db() -> Database:
    import os
    from dotenv import load_dotenv
    load_dotenv()
    path = os.getenv("MONITOR_DB_PATH", "./data/monitor.db")
    return Database(path)


class ManualPositionPayload(BaseModel):
    id: str = Field(..., min_length=2, max_length=64)
    wallet_id: str | None = None
    chain: str
    protocol: str
    asset: str
    side: str
    size_native: str
    entry_price: str | None = None
    entry_ts: int | None = None
    notes: str | None = None

    @field_validator("id")
    @classmethod
    def _slug(cls, v: str) -> str:
        if not re.match(r"^[a-z0-9_]+$", v):
            raise ValueError("id must be lowercase alphanumeric + underscore")
        return v

    @field_validator("side")
    @classmethod
    def _side(cls, v: str) -> str:
        if v not in _VALID_SIDES:
            raise ValueError(f"side must be one of {sorted(_VALID_SIDES)}")
        return v


class ManualPositionPatch(BaseModel):
    wallet_id: str | None = None
    chain: str | None = None
    protocol: str | None = None
    asset: str | None = None
    side: str | None = None
    size_native: str | None = None
    entry_price: str | None = None
    entry_ts: int | None = None
    notes: str | None = None

    @field_validator("side")
    @classmethod
    def _side(cls, v: str | None) -> str | None:
        if v is not None and v not in _VALID_SIDES:
            raise ValueError(f"side must be one of {sorted(_VALID_SIDES)}")
        return v


@router.get("")
def list_positions(wallet_id: str | None = None) -> list[dict[str, Any]]:
    db = _get_db()
    try:
        return db.list_manual_positions(wallet_id=wallet_id)
    finally:
        db.close()


@router.post("", status_code=201)
def create_position(payload: ManualPositionPayload) -> dict[str, Any]:
    db = _get_db()
    try:
        existing = db.get_manual_position(payload.id)
        if existing:
            raise HTTPException(status_code=409, detail=f"Position '{payload.id}' already exists")
        db.upsert_manual_position(
            id=payload.id,
            wallet_id=payload.wallet_id,
            chain=payload.chain,
            protocol=payload.protocol,
            asset=payload.asset,
            side=payload.side,
            size_native=payload.size_native,
            entry_price=payload.entry_price,
            entry_ts=payload.entry_ts,
            notes=payload.notes,
        )
        return db.get_manual_position(payload.id)  # type: ignore[return-value]
    finally:
        db.close()


@router.get("/{position_id}")
def get_position(position_id: str) -> dict[str, Any]:
    db = _get_db()
    try:
        row = db.get_manual_position(position_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Not found")
        return row
    finally:
        db.close()


@router.patch("/{position_id}")
def patch_position(position_id: str, patch: ManualPositionPatch) -> dict[str, Any]:
    db = _get_db()
    try:
        existing = db.get_manual_position(position_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Not found")

        updates = patch.model_dump(exclude_unset=True)
        merged = {**existing, **updates}

        db.upsert_manual_position(
            id=position_id,
            wallet_id=merged.get("wallet_id"),
            chain=merged["chain"],
            protocol=merged["protocol"],
            asset=merged["asset"],
            side=merged["side"],
            size_native=merged["size_native"],
            entry_price=merged.get("entry_price"),
            entry_ts=merged.get("entry_ts"),
            notes=merged.get("notes"),
        )
        return db.get_manual_position(position_id)  # type: ignore[return-value]
    finally:
        db.close()


@router.delete("/{position_id}", status_code=204)
def delete_position(position_id: str) -> None:
    db = _get_db()
    try:
        if db.get_manual_position(position_id) is None:
            raise HTTPException(status_code=404, detail="Not found")
        db.delete_manual_position(position_id)
    finally:
        db.close()
