"""SQLite store (one file, WAL). Small, synchronous; calls are short so they run inline."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv_cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS watchlist (symbol TEXT PRIMARY KEY, label TEXT, ord INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY, topic TEXT NOT NULL, instructions TEXT DEFAULT '',
  symbols TEXT DEFAULT '[]', query TEXT DEFAULT '', created REAL NOT NULL,
  last_run REAL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY, watch_id INTEGER NOT NULL, ts REAL NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, client TEXT DEFAULT '', purpose TEXT NOT NULL,
  basis TEXT NOT NULL, created REAL NOT NULL, closed REAL);
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('public','private','company')),
  wikidata TEXT, notes TEXT DEFAULT '', created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY, ts REAL NOT NULL, case_id TEXT NOT NULL, subject_id INTEGER,
  subject TEXT NOT NULL, kind TEXT NOT NULL, purpose TEXT NOT NULL, module TEXT NOT NULL,
  query TEXT NOT NULL, outcome TEXT NOT NULL, results INTEGER DEFAULT 0,
  prev TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
"""

DEFAULT_WATCHLIST = [
    ("^GSPC", "S&P 500"), ("^IXIC", "Nasdaq"), ("BTC-USD", "Bitcoin"), ("ETH-USD", "Ether"),
    ("GC=F", "Gold"), ("CL=F", "WTI crude"), ("EURUSD=X", "EUR/USD"), ("^TNX", "US 10Y"),
]


class DB:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        if not self.q("SELECT 1 FROM watchlist LIMIT 1"):
            for i, (s, label) in enumerate(DEFAULT_WATCHLIST):
                self.x("INSERT INTO watchlist(symbol,label,ord) VALUES(?,?,?)", (s, label, i))
        try:
            path.chmod(0o600)
        except OSError:
            pass

    def q(self, sql: str, args: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def x(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            cur = self.conn.execute(sql, args)
            return cur.lastrowid or 0

    # tiny JSON cache for feeds
    def cache_get(self, k: str, ttl: float):
        rows = self.q("SELECT v, ts FROM kv_cache WHERE k=?", (k,))
        if rows and time.time() - rows[0]["ts"] < ttl:
            return json.loads(rows[0]["v"])
        return None

    def cache_put(self, k: str, v) -> None:
        self.x("INSERT OR REPLACE INTO kv_cache(k,v,ts) VALUES(?,?,?)", (k, json.dumps(v), time.time()))
