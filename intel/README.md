# Meridian Intel

Bloomberg-style intelligence workstation for Meridian OS: live world map (dark, satellite, Sentinel-2, daily NASA
imagery, terrain, offline), live aircraft and ships, conflict and unrest events, prices of anything with history, an AI
analyst that watches topics, and an OSINT investigation module with a tamper-evident audit log.

- Plan, sources, free vs paid, phases: [docs/PLAN.md](docs/PLAN.md)
- First real test: [docs/VM-TEST.md](docs/VM-TEST.md)

## Run
```
./packaging/install.sh          # user-level install, no root
meridian-intel launch           # or "Meridian Intel" in the app grid
meridian-intel run --demo       # synthetic data, no network feeds
meridian-intel keys set aisstream|anthropic|hibp   # stored in GNOME Keyring
meridian-intel audit verify | export [CASE]
```
Keys: [`aisstream`](https://aisstream.io) (free) for ships, `anthropic` for the analyst, `hibp` for breach checks.
Everything else works with no key.

## Layout
| Path | What |
|---|---|
| `meridian_intel/server.py` | local API (127.0.0.1, per-launch token, Host pinning, CSRF header, CSP) |
| `meridian_intel/feeds/` | aircraft (adsb.lol, OpenSky), ships (aisstream), events (GDELT 2.0), news (GDELT DOC), markets (Yahoo, CoinGecko, ECB, Stooq) |
| `meridian_intel/assistant.py` | Claude analyst (`claude-opus-5-5`, tool use over the feeds, web search) and hourly watches |
| `meridian_intel/osint/` | cases + guardrails (`guard.py`), hash-chained audit log, Wikidata/Wikipedia profiles, username sweep, HIBP, EDGAR, licensed providers |
| `web/` | UI: plain ES modules, MapLibre GL and lightweight-charts vendored (no CDN at runtime) |
| `tests/` | `python -m pytest tests` (guardrails, audit tamper detection, API auth, parsers) |

## OSINT scope
Public figures and companies (linked to Wikidata): full public aggregation. Private individuals: username discovery,
breach exposure for an email, news mentions, licensed PI providers. No compiling home addresses or personal phone numbers of
private people. Every lookup needs a case + purpose and is written to the audit log.
