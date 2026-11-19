"""Shared HTTP client: one pooled httpx.AsyncClient, polite UA, per-host backoff after errors."""
from __future__ import annotations

import time
from urllib.parse import urlparse

import httpx

from .config import settings

_client: httpx.AsyncClient | None = None
_backoff: dict[str, float] = {}   # host -> retry-not-before (epoch)


class FeedError(RuntimeError):
    pass


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, connect=8.0),
            headers={"User-Agent": settings.user_agent, "Accept": "application/json, text/plain, */*"},
            follow_redirects=True,
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def get(url: str, *, params: dict | None = None, headers: dict | None = None,
              auth: tuple[str, str] | None = None) -> httpx.Response:
    host = urlparse(url).hostname or ""
    if _backoff.get(host, 0) > time.time():
        raise FeedError(f"{host}: backing off after errors")
    try:
        r = await client().get(url, params=params, headers=headers, auth=auth)
    except httpx.HTTPError as e:
        _backoff[host] = time.time() + 30
        raise FeedError(f"{host}: {type(e).__name__}") from e
    if r.status_code == 429 or r.status_code >= 500:
        wait = float(r.headers.get("retry-after", "60") or 60) if r.headers.get("retry-after", "").isdigit() else 60.0
        _backoff[host] = time.time() + wait
        raise FeedError(f"{host}: HTTP {r.status_code}")
    if r.status_code >= 400:
        raise FeedError(f"{host}: HTTP {r.status_code}")
    return r


async def get_json(url: str, **kw):
    r = await get(url, **kw)
    try:
        return r.json()
    except ValueError as e:
        raise FeedError(f"{urlparse(url).hostname}: bad JSON") from e
