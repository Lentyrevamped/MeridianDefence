# Meridian Intel: plan and architecture

A Bloomberg-style intelligence workstation for Meridian OS (meridian2). One window: live world map, aircraft, ships,
conflict and politics, prices of anything with history, an AI analyst that watches topics, and an OSINT investigation
module with an audit log. Pure mono Meridian look (ink / graphite / slate / fog / bone, Kumbh Sans wordmark, Inter UI).

Status 19 Nov 2026: phase 1 prototype built (`intel/`), tested in the cloud on demo data only (the cloud network blocks the
live feeds). Live feeds get their first real test on meridian2's VM (`docs/VM-TEST.md`).

## 0. Design language (19 Nov, Gotham-style revision)

Square, dense, operator console. Four workspaces, each a 3-column grid (tree | canvas | inspector):
**COP** (1) map with TRK-A air, TRK-M maritime, EVT-G events + 60-min timeline · **MKT** (2) instruments with history ·
**ANL** (3) analyst console + standing watches · **INV** (4) cases, subjects, hash-chained audit. SYS holds keys/feeds.
Corporate revision (19 Nov 14:10): navy-slate surfaces, 40px title-case panel headers, labels above fields, plain words instead of codes, `?` opens the guide. Purple band with centred SECURED chip and clock;
tokens (`web/tokens.css`) are shared with the Meridian OS Gotham theme; colour (blue/green/amber/red) only encodes data.

## 1. Architecture

```
┌──────────────────────── meridian2 (user session) ────────────────────────┐
│  Window: Brave --app (phase 1) → Flatpak org.meridian.Intel, GTK4+WebKit  │
│        │  http://127.0.0.1:<port>  + per-launch token (cookie/header)     │
│  ┌─────▼──────────────────────────────────────────────────────────────┐  │
│  │ meridian-intel daemon (Python 3.13, FastAPI, asyncio, httpx)        │  │
│  │  feeds/   aircraft · ships · events · news · markets   (poll/ws)    │  │
│  │  assistant/ Claude API tool loop + watch scheduler                   │  │
│  │  osint/   cases · guardrails · public · usernames · breach · audit   │  │
│  │  store    SQLite (WAL): cache, price history, watches, cases, audit  │  │
│  │  secrets  GNOME Keyring via libsecret (keyring lib) → env fallback   │  │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

Why this stack
- **Python backend**: the OSINT ecosystem is Python (Maigret, Sherlock, holehe), async httpx handles dozens of feeds,
  SQLite is enough for one user. No compiled toolchain needed on an atomic OS.
- **Web UI, no build step**: plain ES modules + MapLibre GL (vendored, no CDN at runtime) + TradingView
  lightweight-charts (Apache-2.0, vendored). Map rendering is WebGL; 10k+ aircraft are fine as a GeoJSON symbol layer,
  deck.gl comes in only if a layer outgrows that.
- **Local-only server**: binds 127.0.0.1, random token per launch, Host header pinned (blocks DNS rebinding), no CORS.
  Nothing listens on the network. Fits secureblue; no new permissions, no layering, no podman (userns is blocked anyway).
- **Keys** live in the GNOME keyring (`meridian-intel keys set <name>`), never in files or the repo.
- **Packaging**: phase 1 = venv in `~/.local/share/meridian-intel` + `.desktop` + user systemd unit. Phase 3 = Flatpak
  (network + nothing else; no home access) and an entry in the Meridian OS flatpak list.

## 2. Data sources

Legend: **free** = no key, **free key** = free signup, **paid** = subscription. ✓ = in phase 1.

### Map imagery
| Source | Gives | Tier | Notes |
|---|---|---|---|
| ✓ CARTO Dark Matter | dark vector-look basemap | free (attribution, fair use) | default view |
| ✓ Esri World Imagery | high-res satellite (sub-metre in cities) | free for non-commercial w/ attribution | "Satellite" view |
| ✓ EOX Sentinel-2 cloudless 2024 | 10 m cloud-free mosaic | free (CC BY-NC-SA) | "Sentinel-2" view |
| ✓ NASA GIBS VIIRS true colour | **yesterday's** whole-earth imagery | free | "Today" view, date picker in phase 2 |
| ✓ AWS Terrain Tiles (terrarium) | elevation → hillshade + 3D terrain | free | "Terrain" view |
| ✓ Natural Earth 110m | offline country outlines | free, bundled | works with no network |
| MapTiler / Stadia | vector styles, labels, 3D buildings | free key (limits) | phase 2 polish |
| Sentinel Hub / Planet / Maxar | tasked or near-real-time high-res | paid (Planet/Maxar are $$$$) | phase 4, only if needed |

### Aircraft (ADS-B)
| Source | Tier | Notes |
|---|---|---|
| ✓ adsb.lol | free, no key, ODbL | unfiltered (shows military), radius query ≤ 250 nm, default |
| ✓ OpenSky Network | free (anon 400 credits/day), free account = 4000 | global snapshot, fallback |
| airplanes.live | free, non-commercial | alternative unfiltered feed |
| ADS-B Exchange (RapidAPI) | paid (~$10/mo) | full global firehose |
| Own receiver (RTL-SDR + readsb on a Pi) | hardware ~$40 | phase 4, feeds adsb.lol back too |

### Ships (AIS)
| Source | Tier | Notes |
|---|---|---|
| ✓ aisstream.io | **free key** | global terrestrial AIS over websocket, bbox subscription |
| AISHub | free if you share a receiver | |
| Spire / MarineTraffic / Kpler | paid ($$$) | satellite AIS (open ocean) |

### Conflict, politics, news
| Source | Tier | Notes |
|---|---|---|
| ✓ GDELT 2.0 Events (15-min export) | free | geocoded events, CAMEO codes: protest 14, coerce 17, assault 18, fight 19, mass violence 20 |
| ✓ GDELT DOC 2.0 API | free | news search in 65 languages, tone, used by watches and OSINT |
| ACLED | free key (registration, non-commercial terms) | curated conflict events, weekly; best quality |
| UCDP GED / Candidate | free | monthly fatalities dataset, academic grade |
| ReliefWeb, GDACS, USGS quakes, NASA FIRMS fires | free (FIRMS: free key) | disasters + fire hotspots (strikes show up in FIRMS) |
| Polymarket / Kalshi | free read API | political prediction prices, nice "politics" panel |

### Markets ("price of anything", with history)
| Source | Tier | Notes |
|---|---|---|
| ✓ Yahoo Finance chart API | free, unofficial | stocks, ETFs, indices, futures (GC=F gold, CL=F oil), FX (EURUSD=X), crypto (BTC-USD); intraday + 50y daily |
| ✓ Stooq CSV | free | daily history fallback |
| ✓ CoinGecko | free (demo key optional) | crypto fallback, 10k coins |
| ✓ Frankfurter (ECB) | free | FX reference rates since 1999 |
| FRED | free key | macro: rates, CPI, yields, 800k series |
| Twelve Data / Finnhub / Alpha Vantage | free key, low limits | official, real-time-ish |
| Polygon (Massive), Databento, Bloomberg B-PIPE | paid | real-time exchange data; Bloomberg itself is ~$30k/yr |

### AI analyst
| Source | Tier | Notes |
|---|---|---|
| ✓ Claude API, `claude-opus-5-5` | **paid key** (pay per token) | tool use over all feeds above, watches run at low effort to keep cost down |

### OSINT
| Source | Tier | Notes |
|---|---|---|
| ✓ Wikipedia + Wikidata | free | public-figure profile, official social handles, relatives/positions (Wikidata) |
| ✓ GDELT DOC | free | news mentions |
| ✓ Username sweep (built-in, ~40 sites) | free | Sherlock/Maigret style; Maigret (3000 sites) used if installed |
| ✓ SEC EDGAR full-text | free (UA header) | companies, insiders, filings |
| ✓ Have I Been Pwned | **paid key** (~$4.50/mo) | breach exposure for an email |
| OpenSanctions | free key (non-commercial) | sanctions, PEPs |
| OpenCorporates | free key (limited) | company officers worldwide |
| CourtListener | free key | US court records |
| FEC | free key | US political donations (public by law) |
| TLOxp, IRBsearch, LexisNexis Accurint | licensed PI only | links only; they verify licence + permissible purpose (GLBA/DPPA) |

## 3. OSINT scope (the limits, once)

Public figures (anyone with a Wikidata/Wikipedia entry: celebrities, politicians, executives) and companies get full
aggregation: profile, official accounts, news, filings, sanctions, court records, donations.

Private individuals get: username/account discovery across platforms, breach exposure for an email you already have,
news mentions, and links to licensed PI databases. The tool does **not** scrape or compile home addresses or personal phone
numbers of private people; that is what the licensed providers are for, because they check licence and permissible purpose
and carry the legal liability. "Public" is decided mechanically: the subject must match a Wikidata entity you confirm.

Every lookup needs an open case with a subject and a stated purpose, and is written to an append-only, hash-chained audit
log (`meridian-intel audit verify` / `audit export <case>`), which is also what a PI wants for a case file.

## 4. Phases

| Phase | Scope | Exit check |
|---|---|---|
| **1 (built)** | Shell + command bar, map with 6 views, live aircraft, AIS ships (key), GDELT conflict layer, markets with history + watchlist, Claude analyst (chat + watches), OSINT cases/public/usernames/breach + audit log, demo mode | VM test on meridian2 passes |
| 2 | ACLED/UCDP/FIRMS/quakes layers, track history trails, click-through details (aircraft type, ship photo), alerts (price/geofence/aircraft squawk 7700) to GNOME notifications, MapTiler labels, time slider for GIBS | Dongwon daily-drives it for a week |
| 3 | Flatpak + baked into Meridian OS image, autostart daemon, watch digests as morning brief, Polymarket politics panel, FRED macro board | image build green, VM test |
| 4 | Own ADS-B receiver, satellite AIS / paid market data if wanted, multi-monitor layouts | as needed |

## 5. Keys Dongwon will need (only when he wants that feature)

| Key | Unlocks | Cost |
|---|---|---|
| `aisstream` | ships | free signup at aisstream.io |
| `anthropic` | AI analyst and watches | pay-per-use (Claude Console) |
| `hibp` | email breach checks | ~$4.50/mo |
| `opensky_user` / `opensky_pass` | more aircraft credits | free account |
| later: `acled`, `firms`, `fred`, `opensanctions`, `courtlistener` | phase 2 layers | free signups |

Set with `meridian-intel keys set aisstream` (prompted, stored in GNOME Keyring). Never paste keys in chat or project files.

## 6. Risks and honest limits
- Free feeds are rate-limited and unofficial in places (Yahoo). The app caches and backs off; paid feeds are drop-in later.
- "Live high-res" imagery doesn't exist for free: Esri/EOX are months-to-years old mosaics, GIBS is daily but 250 m.
  Real-time sub-metre imagery is Planet/Maxar money.
- AIS over open ocean needs satellite AIS (paid); free AIS is coastal/terrestrial.
- GDELT events are machine-coded from news and noisy; ACLED (phase 2) is the curated layer.
