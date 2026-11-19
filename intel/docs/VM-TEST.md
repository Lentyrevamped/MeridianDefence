# Meridian Intel: VM test on meridian2

Phase 1 was tested in the cloud on **demo data only** (the cloud network blocks every live feed). This is the first test
with real feeds. Run it in the ARTEX VM (or any Fedora/secureblue VM) on meridian2, not on the host.

Nothing here needs root, layering, or podman. It installs into `~/.local/share/meridian-intel` for one user, listens on
127.0.0.1 only, and `install.sh --remove` takes it all out.

## 1. Install (in the VM)
```
git clone https://github.com/Lentyrevamped/MeridianDefence && cd MeridianDefence/intel
./packaging/install.sh
meridian-intel launch            # opens a Brave/Chrome app window, or the default browser
```
Expect: window titled Meridian Intel, no DEMO DATA badge, AIR/EVT dots go solid within ~30 s.

## 2. Checks without any key
| # | Do | Expect |
|---|---|---|
| 1 | Map → Dark, Satellite, Sentinel-2, Today, Terrain, Offline | each loads imagery; Offline works with networking off |
| 2 | Zoom to London | hundreds of aircraft (adsb.lol), click one → callsign, type, alt, links |
| 3 | Zoom out to the whole world | aircraft switch to OpenSky (source shown in the aircraft panel) or a 250 nm adsb.lol circle |
| 4 | Military only | only military-flagged aircraft (adsb.lol /mil) |
| 5 | Conflict feed | events from the last hour, click one → source article opens |
| 6 | Markets → `AAPL`, `BTC-USD`, `GC=F`, `EURUSD=X`, `^TNX`, each range 1D … MAX | charts load, source = yahoo (or a fallback) |
| 7 | Search "Rheinmetall" in Markets, add to watchlist | appears with sparkline, in the ticker |
| 8 | Command bar: `goto Taiwan Strait`, `fly <a callsign you see>`, `sat`, `terrain` | map moves / switches |
| 9 | OSINT: new case, add public subject (e.g. a politician), pick the Wikidata match, Profile | Wikipedia summary, facts, official accounts |
| 10 | Same case: add a private subject, Usernames with a handle you own | found/absent/manual list; check 3 "found" by hand |
| 11 | Private subject → News with a phone number as query | refused, and the refusal is in the audit log |
| 12 | Audit log shows "chain intact"; `meridian-intel audit verify` says OK; Export CSV downloads | |
| 13 | `ss -ltnp | grep 8787` | only 127.0.0.1:8787 |
| 14 | Open http://127.0.0.1:8787/api/status in a normal browser tab | 401 (token required) |

## 3. Checks with keys (each optional)
- `meridian-intel keys set aisstream` → restart (`systemctl --user restart meridian-intel` or close and relaunch): SEA dot solid, ships in the English Channel within a minute.
- `meridian-intel keys set anthropic` → Analyst: "What is happening around Hormuz right now?" → answer cites tools, map flies there. Add a watch, Run now → digest appears.
- `meridian-intel keys set hibp` → OSINT Breach check on your own email.

## 4. Report back
Which numbers failed, plus `journalctl --user -u meridian-intel -n 100` (or the terminal output of `meridian-intel run`).
Then, with Dongwon's OK, install the same way on meridian2 itself (user-level, removable).
