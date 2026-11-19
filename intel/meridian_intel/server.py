"""Local HTTP API + UI. Binds 127.0.0.1 only; every request needs the per-launch token and a pinned Host header."""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import secrets as pysecrets
import time
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, demo, net, secrets
from .assistant import Analyst
from .config import settings
from .db import DB
from .feeds import aircraft as ac_feed, events as ev_feed, markets, news as news_feed
from .feeds.ships import tracker
from .net import FeedError
from .osint import audit, breach, guard, providers, public, usernames

log = logging.getLogger("meridian-intel")
WEB = Path(__file__).resolve().parent.parent / "web"
COOKIE = "mi_token"


class State:
    token: str = ""
    db: DB
    analyst: Analyst
    events: list[dict] = []
    events_ts: float = 0
    events_err: str = ""
    feed_status: dict[str, str] = {}


S = State()


async def get_events() -> list[dict]:
    if settings.demo:
        return demo.events()
    if time.time() - S.events_ts > settings.events_ttl or not S.events:
        try:
            S.events = await ev_feed.fetch(4)
            S.events_ts, S.events_err = time.time(), ""
        except FeedError as e:
            S.events_err = str(e)
            S.events_ts = time.time() - settings.events_ttl + 120  # retry in 2 min
    return S.events


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    settings.ensure()
    S.db = DB(settings.db_path)
    S.analyst = Analyst(S.db, get_events)
    tasks = [asyncio.create_task(S.analyst.scheduler())]
    if not settings.demo:
        tracker.start()
        tasks.append(asyncio.create_task(get_events()))
    yield
    for t in tasks:
        t.cancel()
    await tracker.stop()
    await net.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def guard_requests(request: Request, call_next):
    host = request.headers.get("host", "")
    if host not in (f"127.0.0.1:{settings.port}", f"localhost:{settings.port}"):
        return PlainTextResponse("bad host", status_code=421)
    path = request.url.path
    supplied = request.cookies.get(COOKIE) or request.headers.get("x-meridian-token") or ""
    if path == "/" and request.query_params.get("t"):
        if hmac.compare_digest(request.query_params["t"], S.token):
            resp = RedirectResponse("/", status_code=303)
            resp.set_cookie(COOKIE, S.token, httponly=True, samesite="strict", path="/")
            return resp
        return PlainTextResponse("bad token", status_code=403)
    if not hmac.compare_digest(supplied, S.token):
        return PlainTextResponse("Open Meridian Intel from its launcher.", status_code=401)
    if request.method not in ("GET", "HEAD") and request.headers.get("x-requested-with") != "meridian":
        return PlainTextResponse("missing header", status_code=403)   # blocks cross-site form posts
    resp: Response = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' https:; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; font-src 'self'; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    return resp


def _bad(e: Exception, code: int = 502):
    raise HTTPException(code, str(e))


def _bbox(s: float, w: float, n: float, e: float):
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise HTTPException(400, "bad bbox")
    return s, w, n, e


# ---------- pages ----------
@app.get("/")
async def index():
    return FileResponse(WEB / "index.html")


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.get("/api/status")
async def status():
    return {"version": __version__, "demo": settings.demo, "keys": secrets.status(), "model": settings.model,
            "ships": "demo" if settings.demo else tracker.status, "ship_msgs": tracker.msgs,
            "events_age": None if settings.demo or not S.events_ts else round(time.time() - S.events_ts),
            "events_err": S.events_err, "feeds": S.feed_status, "analyst": S.analyst.available()}


# ---------- map feeds ----------
@app.get("/api/aircraft")
async def aircraft(s: float, w: float, n: float, e: float, mil: bool = False):
    s, w, n, e = _bbox(s, w, n, e)
    if settings.demo:
        return {"ac": demo.aircraft(s, w, n, e), "src": "demo"}
    key = f"ac:{round(s, 1)}:{round(w, 1)}:{round(n, 1)}:{round(e, 1)}:{mil}"
    cached = S.db.cache_get(key, settings.aircraft_ttl)
    if cached is not None:
        return cached
    try:
        acs = await (ac_feed.military() if mil else ac_feed.fetch(s, w, n, e))
        S.feed_status["aircraft"] = "live"
    except FeedError as ex:
        S.feed_status["aircraft"] = str(ex)
        _bad(ex)
    out = {"ac": acs, "src": acs[0]["src"] if acs else ""}
    S.db.cache_put(key, out)
    return out


@app.get("/api/ships")
async def ships(s: float, w: float, n: float, e: float):
    s, w, n, e = _bbox(s, w, n, e)
    if settings.demo:
        return {"ships": demo.ships(s, w, n, e), "status": "demo"}
    tracker.set_view(s, w, n, e)
    return {"ships": tracker.snapshot(s, w, n, e), "status": tracker.status}


@app.get("/api/events")
async def events():
    evs = await get_events()
    return {"events": evs, "age": None if settings.demo else round(time.time() - S.events_ts), "err": S.events_err}


@app.get("/api/news")
async def news(q: str, span: str = "24h"):
    if settings.demo:
        return {"articles": demo.news(q)}
    key = f"news:{q}:{span}"
    cached = S.db.cache_get(key, 300)
    if cached is not None:
        return cached
    try:
        out = {"articles": await news_feed.search(q[:200], span, 50)}
    except FeedError as ex:
        _bad(ex)
    S.db.cache_put(key, out)
    return out


GAZ = {"taiwan strait": (24.5, 119.5), "kyiv": (50.45, 30.52), "hormuz": (26.5, 56.3), "red sea": (20.0, 38.5),
       "london": (51.5, -0.12), "gaza": (31.45, 34.4), "khartoum": (15.5, 32.56), "seoul": (37.57, 126.98)}


@app.get("/api/geocode")
async def geocode(q: str):
    q = q.strip()[:120]
    if settings.demo:
        hit = GAZ.get(q.lower())
        return {"results": [{"name": q, "lat": hit[0], "lon": hit[1], "bbox": None}] if hit else []}
    key = f"geo:{q.lower()}"
    cached = S.db.cache_get(key, 30 * 86400)
    if cached is not None:
        return cached
    try:   # OpenStreetMap Nominatim: 1 request/s policy; results cached for 30 days
        data = await net.get_json("https://nominatim.openstreetmap.org/search",
                                  params={"q": q, "format": "jsonv2", "limit": "5"})
    except FeedError as ex:
        _bad(ex)
    out = {"results": [{"name": r.get("display_name", ""), "lat": float(r["lat"]), "lon": float(r["lon"]),
                        "bbox": [float(x) for x in r.get("boundingbox", [])] or None} for r in data]}
    S.db.cache_put(key, out)
    return out


# ---------- markets ----------
@app.get("/api/quote")
async def quote(s: str):
    if settings.demo:
        return demo.quote(s)
    key = f"q:{s.upper()}"
    cached = S.db.cache_get(key, settings.quote_ttl)
    if cached is not None:
        return cached
    try:
        q = await markets.quote(s)
    except FeedError as ex:
        _bad(ex)
    S.db.cache_put(key, q)
    return q


@app.get("/api/history")
async def history(s: str, r: str = "1Y"):
    if settings.demo:
        return demo.history(s, r)
    key = f"h:{s.upper()}:{r}"
    cached = S.db.cache_get(key, 60 if r in ("1D", "5D") else settings.history_ttl)
    if cached is not None:
        return cached
    try:
        h = await markets.history(s, r)
    except FeedError as ex:
        _bad(ex)
    S.db.cache_put(key, h)
    return h


@app.get("/api/search")
async def search(q: str):
    if settings.demo:
        return {"results": [{"symbol": q.upper()[:8], "name": f"{q} (demo)", "type": "EQUITY", "exchange": "DEMO"}]}
    try:
        return {"results": await markets.search(q)}
    except FeedError as ex:
        _bad(ex)


@app.get("/api/watchlist")
async def watchlist():
    rows = S.db.q("SELECT symbol, label FROM watchlist ORDER BY ord, symbol")

    async def one(r):
        try:
            q = await quote(r["symbol"])
            return {**r, **{k: q.get(k) for k in ("price", "prev", "currency", "spark", "name", "src")}}
        except HTTPException as ex:
            return {**r, "error": ex.detail}
    return {"items": await asyncio.gather(*(one(r) for r in rows))}


@app.post("/api/watchlist")
async def watchlist_add(body: dict = Body(...)):
    sym = str(body.get("symbol", "")).strip().upper()[:24]
    if not sym:
        raise HTTPException(400, "symbol")
    n = S.db.q("SELECT COALESCE(MAX(ord),0)+1 AS n FROM watchlist")[0]["n"]
    S.db.x("INSERT OR REPLACE INTO watchlist(symbol,label,ord) VALUES(?,?,?)", (sym, str(body.get("label", sym))[:60], n))
    return {"ok": True}


@app.delete("/api/watchlist/{sym}")
async def watchlist_del(sym: str):
    S.db.x("DELETE FROM watchlist WHERE symbol=?", (sym.upper(),))
    return {"ok": True}


# ---------- analyst ----------
@app.post("/api/ask")
async def ask(body: dict = Body(...)):
    q = str(body.get("q", "")).strip()
    if not q:
        raise HTTPException(400, "empty")
    return await S.analyst.ask(q)


@app.get("/api/watches")
async def watches():
    ws = S.db.q("SELECT * FROM watches WHERE active=1 ORDER BY created DESC")
    for w in ws:
        w["symbols"] = json.loads(w["symbols"] or "[]")
        w["digests"] = S.db.q("SELECT ts, body FROM digests WHERE watch_id=? ORDER BY ts DESC LIMIT 5", (w["id"],))
    return {"watches": ws, "analyst": S.analyst.available()}


@app.post("/api/watches")
async def watch_add(body: dict = Body(...)):
    topic = str(body.get("topic", "")).strip()[:120]
    if not topic:
        raise HTTPException(400, "topic")
    syms = [s.strip().upper() for s in str(body.get("symbols", "")).split(",") if s.strip()]
    wid = S.db.x("INSERT INTO watches(topic,instructions,symbols,query,created) VALUES(?,?,?,?,?)",
                 (topic, str(body.get("instructions", ""))[:2000], json.dumps(syms),
                  str(body.get("query", "")).strip()[:300] or topic, time.time()))
    return {"id": wid}


@app.delete("/api/watches/{wid}")
async def watch_del(wid: int):
    S.db.x("UPDATE watches SET active=0 WHERE id=?", (wid,))
    return {"ok": True}


@app.post("/api/watches/{wid}/run")
async def watch_run(wid: int):
    rows = S.db.q("SELECT * FROM watches WHERE id=?", (wid,))
    if not rows:
        raise HTTPException(404, "no watch")
    if not S.analyst.available():
        raise HTTPException(409, "Analyst needs a Claude API key: meridian-intel keys set anthropic")
    return {"body": await S.analyst.run_watch(rows[0])}


# ---------- OSINT ----------
def _refused(e: Exception):
    raise HTTPException(403, str(e))


@app.get("/api/osint/meta")
async def osint_meta():
    return {"bases": guard.BASES, "modules": {k: sorted(v) for k, v in guard.MODULES.items()},
            "providers": providers.PROVIDERS, "hibp": bool(secrets.get("hibp"))}


@app.get("/api/osint/cases")
async def cases():
    rows = S.db.q("SELECT * FROM cases ORDER BY created DESC")
    for c in rows:
        c["subjects"] = S.db.q("SELECT * FROM subjects WHERE case_id=? ORDER BY id", (c["id"],))
    return {"cases": rows}


@app.post("/api/osint/cases")
async def case_new(body: dict = Body(...)):
    try:
        return guard.new_case(S.db, str(body.get("title", "")), str(body.get("purpose", "")),
                              str(body.get("basis", "")), str(body.get("client", "")))
    except guard.Refused as e:
        _refused(e)


@app.post("/api/osint/cases/{cid}/close")
async def case_close(cid: str):
    S.db.x("UPDATE cases SET closed=? WHERE id=? AND closed IS NULL", (time.time(), cid))
    return {"ok": True}


@app.post("/api/osint/cases/{cid}/link-search")
async def link_search(cid: str, body: dict = Body(...)):
    """Find the Wikidata entry for a would-be public subject. Logged like any lookup."""
    name = str(body.get("name", "")).strip()[:100]
    try:
        c = guard.get_case(S.db, cid)
    except guard.Refused as e:
        _refused(e)
    if settings.demo:
        res = [{"id": "Q0", "label": f"{name} (demo)", "description": "demo entity"}]
    else:
        try:
            res = await public.search(name)
        except FeedError as ex:
            _bad(ex)
    audit.record(S.db, case_id=cid, subject_id=None, subject=name, kind="candidate", purpose=c["purpose"],
                 module="link-search", query=name, outcome="ok", results=len(res))
    return {"results": res}


@app.post("/api/osint/cases/{cid}/subjects")
async def subject_add(cid: str, body: dict = Body(...)):
    try:
        wd = body.get("wikidata")
        if settings.demo and wd == "Q0":
            wd = "Q1"
        return guard.add_subject(S.db, cid, str(body.get("name", "")), str(body.get("kind", "")), wd,
                                 str(body.get("notes", ""))[:1000])
    except guard.Refused as e:
        _refused(e)


@app.post("/api/osint/lookup")
async def lookup(body: dict = Body(...)):
    cid, module = str(body.get("case", "")), str(body.get("module", ""))
    query = str(body.get("query", "")).strip()[:300]
    try:
        sid = int(body.get("subject", 0))
        c, subj = guard.authorize(S.db, cid, sid, module, query or subj_name(cid, sid))
    except (guard.Refused, ValueError) as e:
        _refused(e)
    q = query or subj["name"]
    try:
        if module == "profile":
            data = demo_profile(subj) if settings.demo else await public.profile(subj["wikidata"])
            n = len(data.get("accounts", [])) + len(data.get("facts", {}))
        elif module == "news":
            data = {"articles": demo.news(q) if settings.demo else await news_feed.search(f'"{q}"', "3m", 75)}
            n = len(data["articles"])
        elif module == "usernames":
            if not usernames.valid(q):
                raise guard.Refused("usernames are 2-40 characters: letters, digits, . _ -")
            data = {"results": demo_sweep(q) if settings.demo else await usernames.sweep(q)}
            n = sum(1 for r in data["results"] if r["status"] == "found")
        elif module == "filings":
            data = {"filings": [] if settings.demo else await public.edgar(q)}
            n = len(data["filings"])
        elif module == "breach":
            if not breach.EMAIL.match(q):
                raise guard.Refused("enter the email address to check")
            data = {"status": "demo", "breaches": []} if settings.demo else await breach.check(q)
            n = len(data["breaches"])
        elif module == "providers":
            data, n = {"providers": providers.PROVIDERS}, 0
        else:
            raise guard.Refused("unknown module")
    except guard.Refused as e:
        guard.log_err(S.db, c, subj, module, q, str(e))
        _refused(e)
    except (FeedError, ValueError) as e:
        guard.log_err(S.db, c, subj, module, q, str(e))
        _bad(e)
    guard.log_ok(S.db, c, subj, module, q, n)
    return {"module": module, "subject": subj, "data": data}


def subj_name(cid: str, sid: int) -> str:
    rows = S.db.q("SELECT name FROM subjects WHERE id=? AND case_id=?", (sid, cid))
    return rows[0]["name"] if rows else ""


def demo_profile(subj: dict) -> dict:
    return {"id": subj.get("wikidata") or "Q1", "label": subj["name"], "description": "Demo public figure",
            "summary": "Demo mode: this profile is synthetic. On meridian2 this shows the Wikipedia summary.",
            "facts": {"occupation": "demo", "born": "1970-01-01"}, "accounts": [
                {"platform": "X / Twitter", "handle": "demo", "url": "https://x.com/demo", "source": "demo"}],
            "links": {"wikidata": "https://www.wikidata.org/"}, "is_human": True}


def demo_sweep(u: str) -> list[dict]:
    out = []
    for i, s in enumerate(usernames.SITES):
        st = "manual" if s["check"] == "manual" else ("found" if i % 4 == 0 else "absent")
        out.append({"site": s["name"], "url": s["url"].format(u), "status": st})
    return sorted(out, key=lambda r: ({"found": 0, "manual": 1}.get(r["status"], 5), r["site"]))


@app.get("/api/osint/audit")
async def audit_list(case: str | None = None):
    return {"entries": audit.entries(S.db, case, 300), "verify": audit.verify(S.db)}


@app.get("/api/osint/audit/export")
async def audit_export(case: str | None = None):
    name = f"meridian-audit-{case or 'all'}.csv"
    return Response(audit.export_csv(S.db, case), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


def new_token() -> str:
    S.token = pysecrets.token_urlsafe(32)
    return S.token
