"""Tests for scraper/score_backlog.py. Run: python3 scraper/test_score_backlog.py (no network, no database)."""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import score_backlog as sb  # noqa: E402
from deal_sources import quality  # noqa: E402

TODAY = date(2026, 11, 2)
NOW = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)


def row(slug, **over):
    base = {
        "id": f"id-{slug}", "slug": slug, "batch_id": "b1", "created_at": "2026-10-26T12:00:00+00:00", "title": "£3 cask pints", "kind": "deal",
        "venue_name": f"Bar {slug}", "eligibility": "anyone", "recurrence": {"type": "weekly", "days": [2]}, "source_name": "S",
        "source_url": "https://example.com/x", "extraction_status": "validated", "validation_errors": [], "approved": False,
        "verified_at": "2026-10-26T12:00:00+00:00",
    }
    base.update(over)
    return base


class SelectionTests(unittest.TestCase):
    def test_latest_row_per_slug_minus_live_slugs_and_every_kind(self):
        staged = [row("a", batch_id="old", created_at="2026-10-01T00:00:00+00:00", title="old"), row("a", title="new"),
                  row("live-one"), row("ev", kind="event"), row("n", approved=None)]
        waiting, notes = sb.select_waiting(staged, {"live-one"})
        self.assertEqual(sorted(r["slug"] for r in waiting), ["a", "ev", "n"])
        self.assertEqual(next(r for r in waiting if r["slug"] == "a")["title"], "new")
        self.assertEqual((notes["staged_raw"], notes["after_dedupe"], notes["excluded_already_live"], notes["approved_null"]), (5, 4, 1, 1))


class ScoringTests(unittest.TestCase):
    def test_a_strong_backlog_row_routes_publish_as_a_candidate_and_says_so(self):
        strong = row("strong")
        item = sb.route_row(strong, None, today=TODAY, now=NOW)
        self.assertGreaterEqual(item.result.score, quality.PUBLISH_AT)
        self.assertEqual(item.route, "publish")
        self.assertIn("fresh source-page check", item.result.reasons[-1])
        self.assertNotIn("_evidence", strong)  # the stored row itself is not altered

    def test_a_blocking_validation_error_or_a_weekly_pattern_keeps_it_from_publish(self):
        self.assertEqual(sb.route_row(row("a", validation_errors=["quote_missing"]), None, today=TODAY, now=NOW).route, "digest")
        self.assertEqual(sb.route_row(row("b", time_note="second and last Monday of each month"), None, today=TODAY, now=NOW).route, "digest")
        self.assertEqual(sb.route_row(row("c", recurrence={"type": "annual", "month": 7, "day": 19}), None, today=TODAY, now=NOW).route, "digest")

    def test_a_backlog_row_gets_no_score_bonus_from_the_placeholder_evidence(self):
        plain = row("p", extraction_status="pending", verified_at=None)
        scored = quality.score_deal(dict(plain))
        self.assertEqual(sb.route_row(plain, None, today=TODAY, now=NOW).result.score, scored.score)

    def test_commercial_review_rows_get_the_assumed_evidence_and_say_so(self):
        weak = {"title": "20% off food", "recurrence": {"type": "always"}, "extraction_status": "pending", "verified_at": None}
        base = row("c", validation_errors=["commercial_source_review"], **weak)
        plain = row("p", validation_errors=["quote_missing"], **weak)
        a, b = sb.route_row(base, None, today=TODAY, now=NOW), sb.route_row(plain, None, today=TODAY, now=NOW)
        self.assertEqual(a.result.score - b.result.score, quality.EVIDENCE_BONUS)
        self.assertTrue(any("evidence assumed" in r for r in a.result.reasons))
        self.assertNotIn("_evidence", base)  # the stored row itself is not altered

    def test_expired_and_outside_edinburgh_rows_drop_with_reasons(self):
        out = sb.score_rows([row("old", recurrence={"type": "dates", "dates": ["2026-09-25"]}), row("far", venue_name="Lido Musselburgh")],
                            {}, today=TODAY, now=NOW)
        self.assertEqual([r.route for r in out], ["drop", "drop"])
        self.assertTrue(any(x.startswith("expired") for x in out[0].result.reasons))
        self.assertTrue(any(x.startswith("outside Edinburgh") for x in out[1].result.reasons))

    def test_rating_caps_the_score(self):
        item = sb.route_row(row("x"), 1, today=TODAY, now=NOW)
        self.assertLessEqual(item.result.score, 25)
        self.assertEqual(item.route, "drop")


class WriteTests(unittest.TestCase):
    def test_apply_writes_the_three_quality_columns_and_nothing_else(self):
        routed = sb.score_rows([row("a"), row("b", venue_name="Lido Musselburgh")], {}, today=TODAY, now=NOW)
        sent: list[tuple[str, dict]] = []
        n = sb.apply_rows(routed, lambda row_id, body: sent.append((row_id, body)))
        self.assertEqual(n, 2)
        for _id, body in sent:
            self.assertEqual(set(body), {"quality_score", "quality_reasons", "quality_route"})
            self.assertNotIn("approved", body)
            self.assertNotIn("extraction_status", body)
        self.assertEqual([i for i, _ in sent], ["id-a", "id-b"])

    def test_the_real_patch_is_limited_to_waiting_rows(self):
        calls = []

        def fake_patch(url, headers=None, params=None, json=None, timeout=None):
            calls.append((params, json))
            r = mock.Mock()
            r.status_code = 204
            return r

        with mock.patch("requests.patch", fake_patch):
            sb.make_patch("http://x", "k")("id1", {"quality_score": 1, "quality_reasons": [], "quality_route": "drop"})
        params, body = calls[0]
        self.assertEqual(params["happening_id"], "is.null")
        self.assertEqual(params["extraction_status"], "neq.promoted")
        self.assertNotIn("approved", body)

    def test_missing_columns_stop_with_the_sql_hint(self):
        def fake_patch(*a, **k):
            r = mock.Mock()
            r.status_code = 400
            r.text = '{"code":"PGRST204","message":"Could not find the \'quality_score\' column"}'
            return r

        with mock.patch("requests.patch", fake_patch), self.assertRaises(sb.ColumnsMissing):
            sb.make_patch("http://x", "k")("id1", {"quality_score": 1})

    def test_dry_run_is_the_default_and_never_builds_a_writer(self):
        waiting = [row("a"), row("b")]
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(sb, "load_waiting", return_value=(waiting, {"staged_raw": 2, "after_dedupe": 2, "excluded_already_live": 0, "approved_null": 0}, ("http://x", "k"))), \
                mock.patch.object(sb, "make_patch") as make_patch, \
                mock.patch.object(sys, "argv", ["score_backlog.py", "--no-ai", "--offline", "--out-dir", tmp]), \
                redirect_stdout(io.StringIO()) as out:
            sb.main()
            make_patch.assert_not_called()
            self.assertTrue((Path(tmp) / "report.md").is_file())
        self.assertIn("DRY RUN", out.getvalue())

    def test_apply_flag_writes_through_the_writer(self):
        waiting = [row("a")]
        patch = mock.Mock()
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(sb, "load_waiting", return_value=(waiting, {"staged_raw": 1, "after_dedupe": 1, "excluded_already_live": 0, "approved_null": 0}, ("http://x", "k"))), \
                mock.patch.object(sb, "make_patch", return_value=patch), \
                mock.patch.object(sys, "argv", ["score_backlog.py", "--no-ai", "--offline", "--apply", "--out-dir", tmp]), \
                redirect_stdout(io.StringIO()):
            sb.main()
        patch.assert_called_once()
        self.assertEqual(patch.call_args[0][0], "id-a")


class RatingCacheTests(unittest.TestCase):
    def test_cached_ratings_are_used_and_only_missing_rows_are_rated(self):
        rows = [row("a"), row("b")]
        asked: list[str] = []

        def call(prompt):
            asked.append(prompt)
            return quality.RatingResult([{"slug": "b", "rating": 2}], input_tokens=100, output_tokens=10)

        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "ai-ratings.json"
            cache.write_text('{"ratings": {"a": 5}}')
            with mock.patch.object(sb, "BACKTEST_CACHE", Path(tmp) / "none.json"):
                ratings, info = sb.get_ratings(rows, "cache", cache, lambda: call)
            self.assertEqual(ratings, {"a": 5, "b": 2})
            self.assertEqual(len(asked), 1)
            self.assertNotIn("slug: a |", asked[0])
            self.assertIn('"b": 2', cache.read_text())

    def test_no_ai_makes_no_call(self):
        def boom():
            raise AssertionError("must not be called")

        ratings, info = sb.get_ratings([row("a")], "none", Path("/nonexistent/x.json"), boom)
        self.assertEqual(ratings, {})
        self.assertIn("skipped", info.status)


if __name__ == "__main__":
    unittest.main()
