"""Dead-man's switch runner — meant to be triggered by Task Scheduler every 15 min.

Runs ONE check then exits. A separate scheduler entry from the main monitor
ensures that a main-monitor crash does not prevent this script from running.

Usage:
    python scripts/dead_man_runner.py [--max-silence 30] [--db PATH] [--env .env]
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from loguru import logger

# Ensure repo root is on sys.path when invoked directly
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from src.alerts.dead_man import DeadManSwitch
from src.config import load_env
from src.notifications.telegram import TelegramNotifier
from src.storage.db import Database


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Dead-man's switch watchdog")
    parser.add_argument(
        "--max-silence",
        type=int,
        default=30,
        metavar="MINUTES",
        help="Alert if no heartbeat for this many minutes (default: 30)",
    )
    parser.add_argument(
        "--db",
        type=str,
        default=None,
        metavar="PATH",
        help="Override monitor_db_path from .env",
    )
    parser.add_argument(
        "--env",
        type=str,
        default=".env",
        metavar="FILE",
        help="Path to .env file (default: .env)",
    )
    return parser.parse_args()


async def main() -> int:
    args = _parse_args()

    env = load_env(args.env)

    # Configure loguru — minimal output for a cron-style runner
    logger.remove()
    logger.add(
        sys.stderr,
        level=env.monitor_log_level,
        format="{time:HH:mm:ss} | {level:<8} | {message}",
    )

    db_path = args.db or env.monitor_db_path
    db = Database(db_path)

    tg = TelegramNotifier(
        token=env.telegram_bot_token,
        chat_id=env.telegram_chat_id,
    )

    dms = DeadManSwitch(db, tg, max_silence_minutes=args.max_silence)

    try:
        result = await dms.check()
        logger.info(f"Dead-man check result: {result}")
    finally:
        db.close()

    # Exit code 1 if unhealthy — useful for Task Scheduler "on failure" triggers
    return 0 if result["status"] == "healthy" else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
