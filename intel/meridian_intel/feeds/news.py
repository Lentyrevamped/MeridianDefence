"""News search via the GDELT DOC 2.0 API (free, 65 languages, last ~3 months)."""
from __future__ import annotations

from ..net import get_json


async def search(query: str, timespan: str = "24h", maxrecords: int = 50) -> list[dict]:
    data = await get_json("https://api.gdeltproject.org/api/v2/doc/doc", params={
        "query": query, "mode": "artlist", "format": "json", "maxrecords": str(min(250, maxrecords)),
        "timespan": timespan, "sort": "datedesc",
    })
    return [{
        "title": a.get("title", ""), "url": a.get("url", ""), "domain": a.get("domain", ""),
        "ts": a.get("seendate", ""), "lang": a.get("language", ""), "country": a.get("sourcecountry", ""),
    } for a in (data or {}).get("articles", [])]
