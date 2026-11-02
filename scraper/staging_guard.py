"""Keep the daily run from re-staging what is already waiting, was rejected, or was reviewed today.

Each daily run has its own batch_id, and staging upserts on (batch_id, slug). Without a guard:
  * a deal still waiting for review is staged again every day, and duplicates reach the digest;
  * a deal a person rejected comes straight back the next day under a new batch;
  * a same-day re-run's merge-duplicates upsert resets `extraction_status` and `approved` on a row a
    person has already approved or rejected, wiping the review.

apply_guard() runs on a run's final records BEFORE they are routed or staged and removes:
  1. same batch, already reviewed: a row of THIS batch with reviewed_at set, approved = true, or
     extraction_status promoted / rejected is left alone (the re-run never touches it);
  2. already waiting: a row of ANOTHER batch that is still waiting (not approved, not promoted, not
     reviewed) with the same slug or, by scraper/identity.py, a confident title/venue/date match;
  3. rejected: such a match whose reviewed_action is 'reject' (or whose extraction_status is
     'rejected'), unless the record's saving label or dates changed;
  4. expired unreviewed: such a match whose reviewed_action is 'expired', for 30 days from reviewed_at.

A record skipped for 2 to 4 is only counted (no refresh of the existing row). Identity matching is
the confident "match" verdict only; a merely "possible" match is staged as before.

`reviewed_at` / `reviewed_action` come from supabase/add_deal_review.sql. If they are missing the
guard logs that once and carries on without honouring reviews; if the whole read fails it carries on
and stages everything, as before.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from identity import compare, entry_from_happening

EXPIRED_RETURN_DAYS = 30
BASE_COLUMNS = ("id,slug,batch_id,title,kind,venue_name,place_id,saving_label,starts_at,ends_at,recurrence,source_url,"
                "approved,extraction_status,happening_id,created_at")
REVIEW_COLUMNS = ",reviewed_at,reviewed_action"
_REVIEW_COLUMN_NAMES = ("reviewed_at", "reviewed_action")


@dataclass
class GuardStats:
    reviewed_in_batch: list[str] = field(default_factory=list)        # titles left alone
    already_waiting: list[tuple[str, str]] = field(default_factory=list)   # (title, prior batch)
    rejected: list[tuple[str, str]] = field(default_factory=list)
    expired: list[tuple[str, str]] = field(default_factory=list)
    changed_after_reject: list[str] = field(default_factory=list)     # staged again because the offer changed
    notes: list[str] = field(default_factory=list)

    skipped: list[str] = field(default_factory=list)  # slugs removed from the run

    @property
    def skipped_slugs(self) -> set[str]:
        return set(self.skipped)

    @property
    def total(self) -> int:
        return len(self.reviewed_in_batch) + len(self.already_waiting) + len(self.rejected) + len(self.expired)


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _norm(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def offer_changed(record: dict[str, Any], prior: dict[str, Any]) -> bool:
    """Whether the offer differs from the version a person rejected: its saving label or its dates."""
    if _norm(record.get("saving_label")) != _norm(prior.get("saving_label")):
        return True
    for key in ("starts_at", "ends_at"):
        a, b = _parse(record.get(key)), _parse(prior.get(key))
        if (a is None) != (b is None) or (a is not None and b is not None and a != b):
            return True
    rec_a, rec_b = record.get("recurrence"), prior.get("recurrence")
    return json.dumps(rec_a, sort_keys=True, default=str) != json.dumps(rec_b, sort_keys=True, default=str)


def _is_rejected(row: dict[str, Any]) -> bool:
    """A person rejected the offer. add_deal_review.sql also sets extraction_status = 'rejected' on rows that
    merely expired or were superseded by a newer copy, so that status alone only counts when no other
    reviewed_action explains it."""
    action = row.get("reviewed_action")
    return action == "reject" or (row.get("extraction_status") == "rejected" and action not in ("expired", "superseded"))


def _is_expired_review(row: dict[str, Any]) -> bool:
    return row.get("reviewed_action") == "expired"


def _is_waiting(row: dict[str, Any]) -> bool:
    return (row.get("approved") is not True and row.get("extraction_status") not in ("promoted", "rejected") and not row.get("happening_id")
            and not row.get("reviewed_at") and not row.get("reviewed_action"))


def _matches(record: dict[str, Any], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prior rows that are the same thing as `record`: the same slug, or a confident identity match."""
    candidate = entry_from_happening(record)
    out = []
    for row in rows:
        if row.get("slug") == record.get("slug"):
            out.append(row)
            continue
        found = compare(candidate, entry_from_happening(row))
        if found is not None and found.verdict == "match":
            out.append(row)
    return out


def apply_guard(
    records: list[dict[str, Any]],
    other_batches: list[dict[str, Any]],
    this_batch: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> tuple[list[dict[str, Any]], GuardStats]:
    """Return (records to stage, stats). `other_batches` are staging rows of other batches that are
    waiting, rejected or expired-reviewed; `this_batch` are every staging row of the current batch."""
    now = now or datetime.now(timezone.utc)
    stats = GuardStats()
    protected = {
        r["slug"] for r in this_batch
        if r.get("reviewed_at") or r.get("approved") is True or r.get("extraction_status") in ("promoted", "rejected")
        or r.get("reviewed_action")
    }
    kept: list[dict[str, Any]] = []
    for record in records:
        title = str(record.get("title") or record.get("slug"))
        if record.get("slug") in protected:
            stats.reviewed_in_batch.append(title)
            stats.skipped.append(record["slug"])
            continue
        prior = _matches(record, other_batches)
        rejected = [p for p in prior if _is_rejected(p)]
        if rejected:
            if all(offer_changed(record, p) for p in rejected):
                stats.changed_after_reject.append(title)  # a changed offer is a new offer: falls through to the other checks
            else:
                stats.rejected.append((title, str(rejected[0].get("batch_id"))))
                stats.skipped.append(record["slug"])
                continue
        recent_expired = [
            p for p in prior if _is_expired_review(p)
            and now - (_parse(p.get("reviewed_at")) or _parse(p.get("created_at")) or now) < timedelta(days=EXPIRED_RETURN_DAYS)
        ]
        if recent_expired:
            stats.expired.append((title, str(recent_expired[0].get("batch_id"))))
            stats.skipped.append(record["slug"])
            continue
        waiting = [p for p in prior if _is_waiting(p)]
        if waiting:
            stats.already_waiting.append((title, str(waiting[0].get("batch_id"))))
            stats.skipped.append(record["slug"])
            continue
        kept.append(record)
    return kept, stats


# --- reading the two row sets ----------------------------------------------------------------------


def _is_missing_review_column(message: str) -> bool:
    lowered = message.lower()
    return any(c in message for c in _REVIEW_COLUMN_NAMES) and (
        "PGRST204" in message or "42703" in message or "does not exist" in lowered or "could not find" in lowered)


def make_get_all(url: str, key: str) -> Callable[[str, dict[str, str]], list[dict[str, Any]]]:
    """A paging PostgREST reader whose errors carry the response body (so a missing column is recognisable)."""
    import requests  # lazy: the tests inject a fake reader

    def get_all(table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        while True:
            resp = requests.get(f"{url}/rest/v1/{table}", params=params, timeout=30,
                                headers={"apikey": key, "Authorization": f"Bearer {key}", "Range": f"{len(rows)}-{len(rows) + 999}"})
            if resp.status_code >= 300:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
            batch = resp.json()
            rows.extend(batch)
            if len(batch) < 1000:
                return rows

    return get_all


def load_rows(batch_id: str, get_all: Callable[[str, dict[str, str]], list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """(rows of other batches worth matching, rows of this batch, notes). `get_all(table, params)` pages a
    PostgREST query and raises on an HTTP error with the response text in the message. Never raises."""
    notes: list[str] = []

    def fetch(params: dict[str, str]) -> list[dict[str, Any]]:
        try:
            return get_all("happenings_staging", {**params, "select": BASE_COLUMNS + REVIEW_COLUMNS})
        except Exception as exc:  # noqa: BLE001
            if _is_missing_review_column(str(exc)):
                if not any("reviewed_at" in n for n in notes):
                    notes.append("staging guard: reviewed_at / reviewed_action columns not found (run supabase/add_deal_review.sql); "
                                 "reviews are not honoured until then")
                return get_all("happenings_staging", {**params, "select": BASE_COLUMNS})
            raise

    try:
        # Waiting, rejected or expired-reviewed rows of every batch. Promoted rows are live, so identity handles them.
        others = fetch({"happening_id": "is.null", "extraction_status": "neq.promoted", "batch_id": f"neq.{batch_id}",
                        "or": "(approved.eq.false,approved.is.null)"})
        mine = fetch({"batch_id": f"eq.{batch_id}"})
        return others, mine, notes
    except Exception as exc:  # noqa: BLE001
        notes.append(f"staging guard skipped: {exc.__class__.__name__}: {str(exc)[:200]}")
        return [], [], notes


# --- report --------------------------------------------------------------------------------------


def markdown_section(stats: GuardStats) -> list[str]:
    lines = ["## Staging guard", "",
             f"Skipped before staging: {stats.total} (already waiting {len(stats.already_waiting)}, rejected earlier {len(stats.rejected)}, "
             f"expired unreviewed within {EXPIRED_RETURN_DAYS} days {len(stats.expired)}, reviewed in this batch and left alone {len(stats.reviewed_in_batch)}). "
             f"Rejected earlier but changed, so staged again: {len(stats.changed_after_reject)}.", ""]
    for note in stats.notes:
        lines.append(f"- note: {note}")
    for label, items in (("Already waiting", stats.already_waiting), ("Rejected earlier", stats.rejected), ("Expired unreviewed", stats.expired)):
        if items:
            lines += ["", f"{label}:"] + [f"- {title} (batch {batch})" for title, batch in items[:20]]
            if len(items) > 20:
                lines.append(f"- ... and {len(items) - 20} more")
    if stats.reviewed_in_batch:
        lines += ["", "Reviewed in this batch, left alone:"] + [f"- {t}" for t in stats.reviewed_in_batch[:20]]
    lines.append("")
    return lines


def summary_json(stats: GuardStats) -> dict[str, Any]:
    return {"already_waiting": len(stats.already_waiting), "rejected": len(stats.rejected), "expired": len(stats.expired),
            "reviewed_in_batch": len(stats.reviewed_in_batch), "changed_after_reject": len(stats.changed_after_reject), "notes": stats.notes}
