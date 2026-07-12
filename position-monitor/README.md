# Position Monitor

Read-only DeFi position monitor for composite strategies (delta neutre, carry trade, looping) across Hyperliquid, Apex Omni, Morpho, Pendle, and Aave V3. Alerts to Telegram + dashboard on localhost.

See full spec / plan / decisions in the Obsidian vault: `vault/05_PROJECTS/defi-tools/01-position-monitor/`.

## Quick start (dev)

```powershell
# Create venv
python -m venv .venv
.venv\Scripts\Activate.ps1

# Install deps
pip install -e ".[dev]"

# Copy .env template
copy .env.example .env
# Edit .env with your Telegram token, chat_id, and RPC keys

# Copy strategies template
copy strategies.example.yaml strategies.yaml
# Edit strategies.yaml with your wallets and strategy declarations

# Run one cycle manually
python -m src.main

# Run API server (for dashboard)
uvicorn src.api.server:app --reload
```

## Architecture

```
[Windows Task Scheduler — every 15 min]
        |
        v
[src.main] --calls--> [Adapters] --return--> [Positions]
                          |                       |
                          v                       v
                    [Storage SQLite] <---> [Strategy Engine]
                                                 |
                                                 v
                                          [Threshold Checker]
                                                 |
                                                 v
                                  [Telegram Bot] + [FastAPI]
                                                       |
                                                       v
                                              [Next.js Dashboard]
```

## Security

- **Read-only**. Aucune clé privée. Aucune API key avec permission trading.
- `strategies.yaml` et `.env` ne sont JAMAIS committés (cf `.gitignore`).
- Logs masquent tokens et signatures.

## License

Personal use only. Not for redistribution.
