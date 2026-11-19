"""AI analyst: Claude with tools over Meridian's own feeds, plus topic watches that produce digests.

Messages API + the SDK tool runner (the loop runs locally because the tools read local feeds and the local DB).
Model claude-opus-5-5, adaptive thinking; chat runs at medium effort, watches at low effort to keep cost down.
Server-side refusal fallback is enabled ("default" routing).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

from . import demo, secrets
from .config import settings
from .db import DB
from .feeds import aircraft as ac_feed, markets, news as news_feed
from .feeds.ships import tracker
from .net import FeedError

log = logging.getLogger(__name__)
BETAS = ["server-side-fallback-2026-07-01"]
WEB_SEARCH = {"type": "web_search_20260209", "name": "web_search", "max_uses": 5}

SYSTEM = """You are the analyst inside Meridian Intel, a private intelligence workstation on Dongwon's laptop.
You have live tools for markets, aircraft, ships, conflict events, news and web search. Use them instead of memory for
anything current, and say which source a number came from. Be brief and concrete: lead with the answer, then the
evidence. When a place matters, call map_fly_to so the map moves there. Distinguish confirmed facts from single-source
reports (GDELT events are machine-coded from news and noisy). You do not run person lookups; for people, tell Dongwon to
open a case in the OSINT tab."""


class Analyst:
    def __init__(self, db: DB, events_getter):
        self.db = db
        self.events_getter = events_getter
        self.history: list[dict] = []
        self.actions: list[dict] = []
        self._lock = asyncio.Lock()

    def available(self) -> bool:
        return bool(secrets.get("anthropic"))

    def _client(self):
        import anthropic  # noqa: PLC0415
        return anthropic.AsyncAnthropic(api_key=secrets.get("anthropic"))

    def _tools(self):
        from anthropic import beta_async_tool  # noqa: PLC0415
        db, events_getter, actions = self.db, self.events_getter, self.actions

        @beta_async_tool
        async def get_quote(symbol: str) -> str:
            """Latest price and day change for any instrument.

            Args:
                symbol: Yahoo-style symbol: AAPL, ^GSPC, BTC-USD, GC=F (gold), CL=F (oil), EURUSD=X.
            """
            try:
                q = demo.quote(symbol) if settings.demo else await markets.quote(symbol)
            except FeedError as e:
                return f"error: {e}"
            q.pop("spark", None)
            return json.dumps(q)

        @beta_async_tool
        async def get_price_history(symbol: str, range: str = "1Y") -> str:
            """Price history summary (first, last, high, low, % change, 12 sampled closes).

            Args:
                symbol: Yahoo-style symbol.
                range: One of 1D, 5D, 1M, 6M, 1Y, 5Y, MAX.
            """
            try:
                h = demo.history(symbol, range) if settings.demo else await markets.history(symbol, range)
            except FeedError as e:
                return f"error: {e}"
            pts = h["points"]
            if not pts:
                return "no data"
            closes = [p["c"] for p in pts]
            step = max(1, len(pts) // 12)
            return json.dumps({"symbol": h["symbol"], "name": h["name"], "src": h["src"], "first": closes[0],
                               "last": closes[-1], "high": max(closes), "low": min(closes),
                               "pct": round((closes[-1] / closes[0] - 1) * 100, 2),
                               "sampled": [[time.strftime("%Y-%m-%d", time.gmtime(p["t"])), round(p["c"], 4)]
                                           for p in pts[::step]]})

        @beta_async_tool
        async def search_symbols(query: str) -> str:
            """Find the trading symbol for a company, index, commodity or coin.

            Args:
                query: Name to search, e.g. "Rheinmetall" or "natural gas".
            """
            if settings.demo:
                return json.dumps([{"symbol": query.upper()[:6], "name": f"{query} (demo)"}])
            try:
                return json.dumps(await markets.search(query))
            except FeedError as e:
                return f"error: {e}"

        @beta_async_tool
        async def conflict_events(min_lat: float, min_lon: float, max_lat: float, max_lon: float,
                                  category: str = "") -> str:
            """Geocoded conflict/unrest events from the last hour (GDELT) inside a box.

            Args:
                min_lat: South edge.
                min_lon: West edge.
                max_lat: North edge.
                max_lon: East edge.
                category: Optional filter: protest, coercion, assault, fighting, mass violence.
            """
            evs = [e for e in await events_getter() if min_lat <= e["lat"] <= max_lat and min_lon <= e["lon"] <= max_lon
                   and (not category or e["cat"] == category)]
            evs.sort(key=lambda e: -e["mentions"])
            return json.dumps({"count": len(evs), "top": [{k: e[k] for k in ("cat", "place", "a1", "a2", "mentions",
                                                                                 "tone", "url")} for e in evs[:25]]})

        @beta_async_tool
        async def aircraft_in_area(min_lat: float, min_lon: float, max_lat: float, max_lon: float,
                                   military_only: bool = False) -> str:
            """Live aircraft inside a box (ADS-B).

            Args:
                min_lat: South edge.
                min_lon: West edge.
                max_lat: North edge.
                max_lon: East edge.
                military_only: Only aircraft flagged military.
            """
            try:
                acs = demo.aircraft(min_lat, min_lon, max_lat, max_lon) if settings.demo else \
                    await ac_feed.fetch(min_lat, min_lon, max_lat, max_lon)
            except FeedError as e:
                return f"error: {e}"
            if military_only:
                acs = [a for a in acs if a["mil"]]
            emerg = [a for a in acs if a.get("sq") in ("7500", "7600", "7700")]
            return json.dumps({"count": len(acs), "emergency_squawks": emerg[:10],
                               "sample": [{k: a.get(k) for k in ("cs", "type", "alt", "gs", "lat", "lon", "mil")}
                                          for a in acs[:30]]})

        @beta_async_tool
        async def ships_in_area(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> str:
            """Live ships inside a box (AIS). Needs the aisstream key unless in demo mode.

            Args:
                min_lat: South edge.
                min_lon: West edge.
                max_lat: North edge.
                max_lon: East edge.
            """
            ships = demo.ships(min_lat, min_lon, max_lat, max_lon) if settings.demo else \
                tracker.snapshot(min_lat, min_lon, max_lat, max_lon)
            by: dict[str, int] = {}
            for s in ships:
                by[s["cls"]] = by.get(s["cls"], 0) + 1
            return json.dumps({"count": len(ships), "by_class": by, "feed": "demo" if settings.demo else tracker.status,
                               "sample": [{k: s.get(k) for k in ("name", "cls", "sog", "dest", "lat", "lon")}
                                          for s in ships[:25]]})

        @beta_async_tool
        async def search_news(query: str, timespan: str = "24h") -> str:
            """Search world news (GDELT, 65 languages). Supports quotes and OR.

            Args:
                query: Search terms, e.g. "Red Sea" shipping.
                timespan: e.g. 1h, 24h, 7d, 1m (max ~3 months).
            """
            try:
                arts = demo.news(query) if settings.demo else await news_feed.search(query, timespan, 25)
            except FeedError as e:
                return f"error: {e}"
            return json.dumps(arts)

        @beta_async_tool
        async def map_fly_to(lat: float, lon: float, zoom: float = 6, label: str = "") -> str:
            """Move Dongwon's map to a place.

            Args:
                lat: Latitude.
                lon: Longitude.
                zoom: 2 (world) to 14 (street).
                label: Short caption.
            """
            actions.append({"type": "fly", "lat": lat, "lon": lon, "zoom": zoom, "label": label})
            return "map moved"

        @beta_async_tool
        async def add_watch(topic: str, instructions: str = "", symbols: str = "", news_query: str = "") -> str:
            """Create a standing watch the analyst re-checks every hour and digests.

            Args:
                topic: Short name, e.g. "Red Sea shipping".
                instructions: What to track or alert on.
                symbols: Comma-separated symbols to include, e.g. "CL=F,ZIM".
                news_query: GDELT query to pull headlines with.
            """
            syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
            wid = db.x("INSERT INTO watches(topic,instructions,symbols,query,created) VALUES(?,?,?,?,?)",
                       (topic[:120], instructions[:2000], json.dumps(syms), news_query[:300] or topic[:120], time.time()))
            actions.append({"type": "watches"})
            return f"watch {wid} created"

        return [get_quote, get_price_history, search_symbols, conflict_events, aircraft_in_area, ships_in_area,
                search_news, map_fly_to, add_watch, WEB_SEARCH]

    async def _run(self, messages: list[dict], effort: str, max_tokens: int = 16000) -> str:
        runner = self._client().beta.messages.tool_runner(
            model=settings.model, max_tokens=max_tokens, system=SYSTEM, messages=messages,
            tools=self._tools(), thinking={"type": "adaptive"}, output_config={"effort": effort},
            betas=BETAS, fallbacks="default", max_iterations=12,
        )
        final = await runner.until_done()
        if final.stop_reason == "refusal":
            return "The model declined this request."
        return "\n".join(b.text for b in final.content if getattr(b, "type", "") == "text").strip() or "(no answer)"

    async def ask(self, question: str) -> dict:
        if not self.available():
            return {"answer": "The analyst needs a Claude API key: run `meridian-intel keys set anthropic`.",
                    "actions": [], "needs_key": True}
        async with self._lock:
            self.actions.clear()
            msgs = self.history[-12:] + [{"role": "user", "content": question[:8000]}]
            try:
                answer = await self._run(msgs, "medium")
            except Exception as e:  # noqa: BLE001
                log.exception("analyst")
                return {"answer": f"Analyst error: {type(e).__name__}: {e}", "actions": []}
            self.history += [{"role": "user", "content": question[:8000]}, {"role": "assistant", "content": answer}]
            return {"answer": answer, "actions": list(self.actions)}

    async def run_watch(self, w: dict) -> str:
        prev = self.db.q("SELECT body, ts FROM digests WHERE watch_id=? ORDER BY ts DESC LIMIT 1", (w["id"],))
        prompt = (f"Standing watch: {w['topic']}\nInstructions: {w['instructions'] or 'Track notable developments.'}\n"
                  f"Symbols: {', '.join(json.loads(w['symbols'] or '[]')) or 'none'}\nNews query: {w['query']}\n\n"
                  + (f"Your previous digest ({time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(prev[0]['ts']))}):\n"
                     f"{prev[0]['body']}\n\n" if prev else "")
                  + "Check the feeds now. Write a digest of at most 120 words: what changed since the previous digest, "
                    "numbers with sources, and a final line 'Alert: yes/no — reason'.")
        async with self._lock:
            self.actions.clear()
            body = await self._run([{"role": "user", "content": prompt}], "low", 8000)
        self.db.x("INSERT INTO digests(watch_id,ts,body) VALUES(?,?,?)", (w["id"], time.time(), body))
        self.db.x("UPDATE watches SET last_run=? WHERE id=?", (time.time(), w["id"]))
        return body

    async def scheduler(self):
        while True:
            await asyncio.sleep(60)
            if not self.available():
                continue
            due = self.db.q("SELECT * FROM watches WHERE active=1 AND (last_run IS NULL OR last_run < ?)",
                            (time.time() - settings.watch_interval,))
            for w in due:
                try:
                    await self.run_watch(w)
                except Exception:  # noqa: BLE001
                    log.exception("watch %s", w["id"])
                    self.db.x("UPDATE watches SET last_run=? WHERE id=?", (time.time(), w["id"]))
