"""Username / account discovery across platforms (Sherlock-style, built in, no third-party code).

Each site is checked with the cheapest reliable signal (API status, JSON, page marker). Sites behind login walls are
returned as "manual" links: no automated guess, Dongwon checks them by hand. Results are leads, not identity proof:
the same handle on two sites can be two people.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx

from ..net import client

SITES = json.loads((Path(__file__).with_name("sites.json")).read_text())
VALID = re.compile(r"^[A-Za-z0-9._-]{2,40}$")


def valid(username: str) -> bool:
    return bool(VALID.match(username))


async def _check(site: dict, user: str, sem: asyncio.Semaphore) -> dict:
    url = site["url"].format(user)
    res = {"site": site["name"], "url": url, "status": "unknown"}
    if site["check"] == "manual":
        res["status"] = "manual"
        return res
    probe = site.get("probe", site["url"]).format(user)
    async with sem:
        try:
            r = await client().get(probe, timeout=12.0, follow_redirects=site["check"] != "status")
        except httpx.HTTPError as e:
            res["status"] = "error"
            res["detail"] = type(e).__name__
            return res
    c, body = site["check"], r.text[:200000] if r.status_code < 500 else ""
    if r.status_code in (403, 429) or r.status_code >= 500:
        res["status"], res["detail"] = "blocked", f"HTTP {r.status_code}"
    elif c == "status":
        res["status"] = "found" if r.status_code == 200 else "absent" if r.status_code in (404, 410, 301, 302) else "unknown"
    elif c == "json_nonempty":
        res["status"] = "found" if r.status_code == 200 and body.strip() not in ("", "[]", "{}") else "absent"
    elif c == "json_nonnull":
        res["status"] = "found" if r.status_code == 200 and body.strip() not in ("", "null") else "absent"
    elif c == "text_absent":
        res["status"] = "absent" if site["marker"] in body or r.status_code == 404 else "found" if r.status_code == 200 else "unknown"
    elif c == "text_present":
        res["status"] = "found" if site["marker"] in body else "absent"
    return res


async def sweep(username: str) -> list[dict]:
    if not valid(username):
        raise ValueError("usernames are 2-40 characters: letters, digits, . _ -")
    sem = asyncio.Semaphore(10)
    results = await asyncio.gather(*(_check(s, username, sem) for s in SITES))
    order = {"found": 0, "manual": 1, "unknown": 2, "blocked": 3, "error": 4, "absent": 5}
    return sorted(results, key=lambda r: (order.get(r["status"], 9), r["site"]))
