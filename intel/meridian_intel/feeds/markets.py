"""Prices of anything with history.

Primary: Yahoo Finance chart API (unofficial, free): equities, ETFs, indices (^GSPC), futures (GC=F),
FX (EURUSD=X), crypto (BTC-USD). Fallbacks: CoinGecko (crypto), Frankfurter/ECB (FX), Stooq (equities, daily).
"""
from __future__ import annotations

import csv
import io
from datetime import date, timedelta

from ..net import FeedError, get, get_json

RANGES = {  # range -> (yahoo range, interval)
    "1D": ("1d", "5m"), "5D": ("5d", "15m"), "1M": ("1mo", "60m"), "6M": ("6mo", "1d"),
    "1Y": ("1y", "1d"), "5Y": ("5y", "1wk"), "MAX": ("max", "1mo"),
}
YH = "https://query1.finance.yahoo.com"
CG_IDS = {"BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "XRP": "ripple", "DOGE": "dogecoin",
          "ADA": "cardano", "BNB": "binancecoin", "LTC": "litecoin", "DOT": "polkadot", "AVAX": "avalanche-2"}


def _clean(sym: str) -> str:
    sym = sym.strip().upper()
    if not sym or len(sym) > 24 or any(c in sym for c in " /\\?#&"):
        raise FeedError("bad symbol")
    return sym


async def _yahoo(sym: str, rng: str) -> dict:
    yr, iv = RANGES[rng]
    data = await get_json(f"{YH}/v8/finance/chart/{sym}", params={"range": yr, "interval": iv,
                                                                  "includePrePost": "false"})
    res = ((data or {}).get("chart") or {}).get("result")
    if not res:
        raise FeedError(f"yahoo: no data for {sym}")
    r = res[0]
    meta = r.get("meta", {})
    q = (r.get("indicators", {}).get("quote") or [{}])[0]
    pts = []
    for i, t in enumerate(r.get("timestamp") or []):
        c = (q.get("close") or [None])[i] if i < len(q.get("close") or []) else None
        if c is None:
            continue
        pts.append({"t": t, "o": q["open"][i], "h": q["high"][i], "l": q["low"][i], "c": c,
                    "v": (q.get("volume") or [0])[i] or 0})
    price = meta.get("regularMarketPrice") or (pts[-1]["c"] if pts else None)
    prev = meta.get("chartPreviousClose") or meta.get("previousClose")
    if rng != "1D" and len(pts) > 1:
        prev = meta.get("previousClose") or prev
    return {"symbol": sym, "name": meta.get("longName") or meta.get("shortName") or sym,
            "currency": meta.get("currency", ""), "exchange": meta.get("fullExchangeName") or meta.get("exchangeName", ""),
            "price": price, "prev": prev, "points": pts, "src": "yahoo"}


async def _coingecko(sym: str, rng: str) -> dict:
    base = sym.split("-")[0]
    cid = CG_IDS.get(base)
    if not cid:
        raise FeedError("coingecko: unknown coin")
    days = {"1D": 1, "5D": 5, "1M": 30, "6M": 180, "1Y": 365, "5Y": 1825, "MAX": "max"}[rng]
    data = await get_json(f"https://api.coingecko.com/api/v3/coins/{cid}/market_chart",
                          params={"vs_currency": "usd", "days": str(days)})
    pts = [{"t": int(t / 1000), "o": p, "h": p, "l": p, "c": p, "v": 0} for t, p in data.get("prices", [])]
    if not pts:
        raise FeedError("coingecko: empty")
    return {"symbol": sym, "name": cid.title(), "currency": "USD", "exchange": "CoinGecko",
            "price": pts[-1]["c"], "prev": pts[0]["c"], "points": pts, "src": "coingecko"}


async def _frankfurter(sym: str, rng: str) -> dict:
    pair = sym.replace("=X", "")
    if len(pair) != 6:
        raise FeedError("frankfurter: not a pair")
    days = {"1D": 7, "5D": 10, "1M": 31, "6M": 183, "1Y": 366, "5Y": 1830, "MAX": 9999}[rng]
    start = max(date(1999, 1, 4), date.today() - timedelta(days=days))
    data = await get_json(f"https://api.frankfurter.app/{start.isoformat()}..",
                          params={"from": pair[:3], "to": pair[3:]})
    import calendar  # noqa: PLC0415
    pts = []
    for d, v in sorted((data.get("rates") or {}).items()):
        p = v.get(pair[3:])
        y, m, dd = map(int, d.split("-"))
        pts.append({"t": calendar.timegm((y, m, dd, 0, 0, 0)), "o": p, "h": p, "l": p, "c": p, "v": 0})
    if not pts:
        raise FeedError("frankfurter: empty")
    return {"symbol": sym, "name": f"{pair[:3]}/{pair[3:]} (ECB)", "currency": pair[3:], "exchange": "ECB",
            "price": pts[-1]["c"], "prev": pts[-2]["c"] if len(pts) > 1 else None, "points": pts, "src": "ecb"}


async def _stooq(sym: str, rng: str) -> dict:
    s = sym.lower() if "." in sym else f"{sym.lower()}.us"
    r = await get("https://stooq.com/q/d/l/", params={"s": s, "i": "d"})
    rows = list(csv.DictReader(io.StringIO(r.text)))
    if not rows or "Close" not in rows[0]:
        raise FeedError("stooq: no data")
    import calendar  # noqa: PLC0415
    days = {"1D": 5, "5D": 7, "1M": 31, "6M": 183, "1Y": 366, "5Y": 1830, "MAX": 10**6}[rng]
    pts = []
    for row in rows[-days:]:
        y, m, d = map(int, row["Date"].split("-"))
        pts.append({"t": calendar.timegm((y, m, d, 0, 0, 0)), "o": float(row["Open"]), "h": float(row["High"]),
                    "l": float(row["Low"]), "c": float(row["Close"]), "v": float(row.get("Volume") or 0)})
    return {"symbol": sym, "name": sym, "currency": "", "exchange": "Stooq", "price": pts[-1]["c"],
            "prev": pts[-2]["c"] if len(pts) > 1 else None, "points": pts, "src": "stooq"}


async def history(sym: str, rng: str = "1Y") -> dict:
    sym = _clean(sym)
    if rng not in RANGES:
        raise FeedError("bad range")
    chain = [_yahoo]
    if sym.endswith("-USD"):
        chain.append(_coingecko)
    elif sym.endswith("=X"):
        chain.append(_frankfurter)
    elif sym.isalpha() or "." in sym:
        chain.append(_stooq)
    last: Exception | None = None
    for fn in chain:
        try:
            return await fn(sym, rng)
        except (FeedError, KeyError, IndexError, TypeError, ValueError) as e:
            last = e
    raise FeedError(str(last) if last else "no source")


async def quote(sym: str) -> dict:
    h = await history(sym, "5D")
    pts = h.pop("points")
    h["spark"] = [p["c"] for p in pts[-60:]]
    return h


async def search(q: str) -> list[dict]:
    data = await get_json("https://query2.finance.yahoo.com/v1/finance/search",
                          params={"q": q[:60], "quotesCount": "10", "newsCount": "0"})
    return [{"symbol": x.get("symbol"), "name": x.get("shortname") or x.get("longname") or "",
             "type": x.get("quoteType", ""), "exchange": x.get("exchDisp") or x.get("exchange", "")}
            for x in data.get("quotes", []) if x.get("symbol")]
