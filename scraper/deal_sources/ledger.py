"""Page-change ledger (`source_pages` table, supabase/add_deal_source_columns.sql).

A page whose normalised text hash matches the last successful extraction is not
sent to the LLM again. Reads and writes go through Supabase REST with the
service-role key (same env loading as the other scraper modules).

Modes:
  off   -- no database access at all; every page counts as changed.
  read  -- reads the ledger, never writes (dry runs, shadow sources, previews).
  rw    -- reads and records hashes (only for LIVE sources in a --stage run).

With defer=True, `record()` only queues the row and `commit()` writes the queue.
The weekly run commits after its staging upsert succeeds, so a failed upsert
cannot leave pages marked as handled whose rows never reached staging.

If the table does not exist yet (HTTP 404 / PGRST205 / 42P01) or the credentials
are missing, that is logged once and every page is treated as changed.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

from deal_sources.textutil import content_hash

SCRAPER_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SCRAPER_DIR.parent
load_dotenv(SCRAPER_DIR / ".env")
load_dotenv(REPO_ROOT / ".env.local", override=False)

TABLE = "source_pages"
_MISSING_TABLE_CODES = ("PGRST205", "42P01", "PGRST200")


def supabase_connection() -> tuple[str, str] | None:
    url = (os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    return (url, key) if url and key else None


def table_missing(status: int, body: Any) -> bool:
    """True when a PostgREST error means source_pages is not there yet."""
    if status == 404:
        return True
    code = body.get("code") if isinstance(body, dict) else None
    return isinstance(code, str) and code in _MISSING_TABLE_CODES


class Ledger:
    def __init__(self, mode: str = "off", connection: tuple[str, str] | None = None, log=print, defer: bool = False) -> None:
        if mode not in ("off", "read", "rw"):
            raise ValueError(f"ledger mode must be off|read|rw, got {mode!r}")
        self.mode = mode
        self.connection = connection if connection is not None else (supabase_connection() if mode != "off" else None)
        self.available = mode != "off" and self.connection is not None
        self._log = log
        self._warned = False
        self._known: dict[str, dict[str, Any]] = {}
        self.writes = 0
        self.defer = defer
        self._queue: list[tuple[str, dict[str, Any], dict[str, Any] | None]] = []
        if mode != "off" and self.connection is None:
            self._warn("Supabase credentials unavailable; treating every page as changed")

    def _warn(self, why: str) -> None:
        self.available = False
        if not self._warned:
            self._warned = True
            self._log(f"[deal-sources] ledger unavailable ({why}); every page will be treated as changed")

    def _headers(self) -> dict[str, str]:
        assert self.connection
        key = self.connection[1]
        return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def load(self, source_id: str) -> None:
        """Fetch every known page row for one source (a single request)."""
        if not self.available or self.mode == "off":
            return
        assert self.connection
        base = self.connection[0]
        try:
            resp = requests.get(
                f"{base}/rest/v1/{TABLE}",
                headers={**self._headers(), "Range": "0-4999"},
                params={"source_id": f"eq.{source_id}", "select": "url,content_hash,last_changed_at"},
                timeout=30,
            )
        except requests.RequestException as exc:
            self._warn(f"request failed: {exc.__class__.__name__}")
            return
        if resp.status_code >= 300:
            try:
                body = resp.json()
            except ValueError:
                body = None
            if table_missing(resp.status_code, body):
                self._warn("table source_pages not found; run supabase/add_deal_source_columns.sql")
            else:
                self._warn(f"HTTP {resp.status_code}")
            return
        for row in resp.json():
            self._known[row["url"]] = row

    @staticmethod
    def hash_text(text: str) -> str:
        return content_hash(text)

    def is_unchanged(self, url: str, text: str) -> bool:
        if not self.available:
            return False
        row = self._known.get(url)
        return bool(row) and row.get("content_hash") == self.hash_text(text)

    def record(self, url: str, source_id: str, text: str, status: int | None = 200) -> bool:
        """Remember this page's hash. No-op unless mode is 'rw' and the table is usable."""
        if self.mode != "rw" or not self.available:
            return False
        assert self.connection
        new_hash = self.hash_text(text)
        previous = self._known.get(url)
        now = datetime.now(timezone.utc).isoformat()
        row: dict[str, Any] = {
            "url": url, "source_id": source_id, "content_hash": new_hash,
            "last_fetched_at": now, "last_status": status,
        }
        if previous is None or previous.get("content_hash") != new_hash:
            row["last_changed_at"] = now
        if self.defer:
            self._queue.append((url, row, previous))
            return True
        return self._write(url, row, previous)

    def commit(self) -> int:
        """Write every deferred row. Returns how many were written."""
        queue, self._queue = self._queue, []
        return sum(1 for url, row, previous in queue if self.available and self._write(url, row, previous))

    def _write(self, url: str, row: dict[str, Any], previous: dict[str, Any] | None) -> bool:
        assert self.connection
        try:
            resp = requests.post(
                f"{self.connection[0]}/rest/v1/{TABLE}",
                headers={**self._headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
                params={"on_conflict": "url"},
                json=row,
                timeout=30,
            )
        except requests.RequestException as exc:
            self._warn(f"write failed: {exc.__class__.__name__}")
            return False
        if resp.status_code >= 300:
            print(f"[deal-sources] ledger write failed for {url}: HTTP {resp.status_code}", file=sys.stderr)
            return False
        self._known[url] = {**(previous or {}), **row}
        self.writes += 1
        return True
