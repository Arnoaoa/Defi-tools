"""CRUD for strategies stored in DB (override strategies.yaml when ID matches)."""
from __future__ import annotations
import re
import time
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from src.config import load_env
from src.storage import Database

router = APIRouter(prefix="/strategies_crud")

_VALID_TYPES = {"delta_neutral", "passive", "leveraged_yield", "spot", "composite"}
_VALID_ROLES = {"spot", "short_perp", "long_perp", "collateral", "debt"}


class LegPayload(BaseModel):
    protocol: str
    role: str
    asset: str | None = None
    chain: str | None = None
    symbol: str | None = None
    wallet_id: str | None = None

    @field_validator("role")
    @classmethod
    def _check_role(cls, v: str) -> str:
        if v not in _VALID_ROLES:
            raise ValueError(f"role must be one of {_VALID_ROLES}")
        return v


class StrategyPayload(BaseModel):
    id: str = Field(..., min_length=2, max_length=64)
    name: str
    type: str
    delta_target_pct: str = "0"
    notes: str | None = None
    legs: list[LegPayload]

    @field_validator("id")
    @classmethod
    def _slug(cls, v: str) -> str:
        if not re.match(r"^[a-z0-9_]+$", v):
            raise ValueError("id must be lowercase alphanumeric + underscore")
        return v

    @field_validator("type")
    @classmethod
    def _check_type(cls, v: str) -> str:
        if v not in _VALID_TYPES:
            raise ValueError(f"type must be one of {_VALID_TYPES}")
        return v


def _get_db() -> Database:
    env = load_env()
    return Database(env.monitor_db_path)


@router.get("")
def list_strategies() -> list[dict]:
    db = _get_db()
    try:
        return db.list_strategies()
    finally:
        db.close()


@router.get("/{id}")
def get_strategy(id: str) -> dict:
    db = _get_db()
    try:
        row = db.get_strategy(id)
        if row is None:
            raise HTTPException(status_code=404, detail="Strategy not found")
        return row
    finally:
        db.close()


@router.post("", status_code=201)
def create_strategy(payload: StrategyPayload) -> dict:
    db = _get_db()
    try:
        existing = db.get_strategy(payload.id)
        if existing is not None:
            raise HTTPException(status_code=409, detail="Strategy ID already exists")
        db.upsert_strategy(
            id=payload.id,
            name=payload.name,
            type_=payload.type,
            delta_target_pct=payload.delta_target_pct,
            notes=payload.notes,
            legs=[leg.model_dump() for leg in payload.legs],
        )
        return db.get_strategy(payload.id)
    finally:
        db.close()


@router.patch("/{id}")
def update_strategy(id: str, payload: StrategyPayload) -> dict:
    db = _get_db()
    try:
        if db.get_strategy(id) is None:
            raise HTTPException(status_code=404, detail="Strategy not found")
        db.upsert_strategy(
            id=id,
            name=payload.name,
            type_=payload.type,
            delta_target_pct=payload.delta_target_pct,
            notes=payload.notes,
            legs=[leg.model_dump() for leg in payload.legs],
        )
        return db.get_strategy(id)
    finally:
        db.close()


@router.delete("/{id}", status_code=204)
def delete_strategy(id: str) -> None:
    db = _get_db()
    try:
        if db.get_strategy(id) is None:
            raise HTTPException(status_code=404, detail="Strategy not found")
        db.delete_strategy(id)
    finally:
        db.close()
