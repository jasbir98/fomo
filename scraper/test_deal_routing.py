"""Tests for scraper/deal_routing.py, the --auto-publish / --topic-slice flags and the quality columns.

Run: python3 scraper/test_deal_routing.py   (stdlib unittest; no network, no database, no API key)

Every outside call is a fake: the rating call, the page re-check, the approve PATCH and the promote
script. Nothing here can write to a database or call DeepSeek.
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import deal_routing as dr  # noqa: E402
import page_check  # noqa: E402
import staging_guard as sg  # noqa: E402
import upsert_happenings  # noqa: E402
import weekly_edinburgh as weekly  # noqa: E402
from deal_sources import quality  # noqa: E402
from deal_sources.runner import DealRunResult  # noqa: E402

TODAY = date(2026, 11, 2)
NOW = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)


def rec(slug="a-deal", **over):
    base = {
        "slug": slug, "batch_id": "b1", "title": "£3 cask pints", "kind": "deal", "venue_name": f"Local Bar {slug}",
        "saving_label": None, "eligibility": "anyone", "recurrence": {"type": "weekly", "days": [2]},
        "source_name": "Some Source", "source_url": "https://example.com/offers",
        "verified_at": "2026-11-02T11:00:00+00:00", "validation_errors": [], "extraction_status": "validated",
        "_evidence": {"deal_quote": "£3 cask pints on Wednesdays"},
    }
    base.update(over)
    return base


def passes(_record):
    return []


class FakeResp:
    """What deal_sources.fetch.Response carries, for the page check."""

    def __init__(self, ok=True, status=200, text="<html><body><p>£3 cask pints every Wednesday at the bar</p></body></html>", reason=None):
        self.ok, self.status, self.text, self.reason = ok, status, text, reason


def ok_page(_url):
    return FakeResp()


def no_rating():
    raise RuntimeError("no rating in this test")


def run(records, verify=passes, rating=no_rating, **kw):
    return dr.run_routing(records, make_rating_call=rating, verify=verify, in_rate=0.28, out_rate=0.42,
                          rating_budget_usd=0.03, today=TODAY, now=NOW, log=lambda _m: None, **kw)


class RatingTests(unittest.TestCase):
    def test_a_rating_that_cannot_start_is_logged_and_means_no_cap(self):
        logged: list[str] = []

        def peak():
            raise RuntimeError("DeepSeek peak hours")

        ratings, info = dr.rate_records([rec()], peak, in_rate=0.28, out_rate=0.42, budget_usd=0.03, log=logged.append)
        self.assertEqual(ratings, {})
        self.assertIn("NOT RUN", info.status)
        self.assertTrue(logged)

        def exits():
            raise SystemExit(1)  # make_research_client exits when no key is set

        ratings, info = dr.rate_records([rec()], exits, in_rate=0.28, out_rate=0.42, budget_usd=0.03, log=logged.append)
        self.assertEqual(ratings, {})
        self.assertIn("NOT RUN", info.status)

    def test_a_failed_batch_gives_no_entry_and_the_cap_comes_from_ratings_only(self):
        records = [rec("good"), rec("bad")]
        call = lambda prompt: quality.RatingResult([{"slug": "bad", "rating": 1}], input_tokens=1000, output_tokens=100)
        ratings, info = dr.rate_records(records, lambda: call, in_rate=0.28, out_rate=0.42, budget_usd=0.03)
        self.assertEqual(ratings, {"bad": 1})
        self.assertEqual((info.asked, info.rated), (2, 1))
        self.assertGreater(info.cost_usd, 0)
        failing = lambda prompt: quality.RatingResult([], error="boom")
        ratings, info = dr.rate_records(records, lambda: failing, in_rate=0.28, out_rate=0.42, budget_usd=0.03, log=lambda _m: None)
        self.assertEqual(ratings, {})
        self.assertEqual(info.errors, ["boom"])
        out = run(records, rating=lambda: call)
        by_slug = {r.record["slug"]: r for r in out.final}
        self.assertLessEqual(by_slug["bad"].result.score, 25)
        self.assertEqual(by_slug["bad"].route, "drop")
        self.assertEqual(by_slug["good"].route, "publish")

    def test_the_rating_stops_at_its_budget(self):
        calls: list[str] = []

        def call(prompt):
            calls.append(prompt)
            return quality.RatingResult([], input_tokens=1_000_000, output_tokens=0)  # $0.28 a call

        records = [rec(f"r{i}") for i in range(60)]  # 3 batches of 25
        dr.rate_records(records, lambda: call, in_rate=0.28, out_rate=0.42, budget_usd=0.03, log=lambda _m: None)
        self.assertEqual(len(calls), 1)


class RoutingTests(unittest.TestCase):
    def test_every_record_gets_the_three_columns_dropped_ones_with_reasons(self):
        weak = rec("weak", title="Free spinal screening", venue_name="Chiropractic Life", recurrence={"type": "always"},
                   _evidence=None, extraction_status="pending", validation_errors=["quote_missing"])
        expired = rec("old", recurrence={"type": "dates", "dates": ["2026-09-25"]})
        out = run([rec("strong"), weak, expired])
        by = {r["slug"]: r for r in (x.record for x in out.final)}
        self.assertEqual(by["strong"]["quality_route"], "publish")
        self.assertEqual(by["weak"]["quality_route"], "digest")
        self.assertEqual(by["old"]["quality_route"], "drop")
        self.assertIn("expired: every stated date has passed", by["old"]["quality_reasons"])
        for r in by.values():
            self.assertIsInstance(r["quality_score"], int)
            self.assertIsInstance(r["quality_reasons"], list)

    def test_other_kinds_take_the_same_route_and_the_fresh_check(self):
        event = rec("free-event", kind="event", title="Free jazz night", is_free=True, saving_label=None,
                    recurrence={"type": "once"}, starts_at="2026-11-20T19:00:00+00:00", _evidence=None)
        seen: list[str] = []

        def verify(record):
            seen.append(record["slug"])
            return []

        # A non-deal reaches publish only with a stated free or low price AND an AI rating of 4 or 5.
        rated = lambda: (lambda prompt: quality.RatingResult([{"slug": "free-event", "rating": 5}], input_tokens=10, output_tokens=5))
        out = run([event], verify=verify, rating=rated)
        self.assertEqual(out.final[0].route, "publish")  # free + local + validated is 20+30+15+10
        self.assertEqual(seen, ["free-event"])
        self.assertEqual([r.record["slug"] for r in out.publishable], ["free-event"])
        # With no rating the same event is capped below publish and goes to the digest, unchecked by the fresh check.
        seen.clear()
        out = run([event], verify=verify)
        self.assertEqual(out.final[0].route, "digest")
        self.assertEqual(out.final[0].result.score, quality.NON_DEAL_CAP)
        self.assertEqual(seen, [])

    def test_social_and_newsletter_rows_never_publish(self):
        insta = rec("insta", source_url="https://www.instagram.com/p/abc/")
        news = rec("news", source_name="Edinburgh newsletter")
        out = run([insta, news, rec("web")])
        routes = {r.record["slug"]: r.route for r in out.final}
        self.assertEqual(routes, {"insta": "digest", "news": "digest", "web": "publish"})

    def test_evidence_is_counted_per_source(self):
        records = [rec("a", source_name="itison Edinburgh deals"), rec("b", source_name="itison Edinburgh deals", _evidence=None),
                   rec("c", source_name="Topic", _evidence=None)]
        self.assertEqual(dr.evidence_by_source(records), {"itison Edinburgh deals": (2, 1), "Topic": (1, 0)})
        out = run(records)
        self.assertEqual(out.evidence["itison Edinburgh deals"], (2, 1))


class FreshCheckTests(unittest.TestCase):
    def test_a_failed_fresh_check_moves_the_row_to_digest_with_the_reason(self):
        out = run([rec("stale"), rec("fine")], verify=lambda r: ["saving_label is not stated verbatim on source page"] if r["slug"] == "stale" else [])
        by = {r.record["slug"]: r for r in out.final}
        self.assertEqual(by["stale"].route, "digest")
        self.assertIn("fresh check failed: saving_label is not stated verbatim on source page", by["stale"].result.reasons[-1])
        self.assertEqual(by["stale"].record["quality_route"], "digest")
        self.assertEqual(by["fine"].route, "publish")
        self.assertEqual(out.fresh.failed, 1)
        self.assertEqual([r.record["slug"] for r in out.publishable], ["fine"])

    def test_a_re_check_that_raises_is_a_failure(self):
        def boom(_r):
            raise ValueError("kaput")

        out = run([rec("x")], verify=boom)
        self.assertEqual(out.final[0].route, "digest")
        self.assertIn("kaput", out.final[0].result.reasons[-1])

    def test_only_publish_rows_are_checked_and_the_freed_slot_goes_to_the_next_best(self):
        # Two rows at one venue: the better one fails its check, so the other takes the venue's slot.
        best = rec("best", venue_name="Same Bar", title="£3 cask pints", saving_label="50% off")
        second = rec("second", venue_name="Same Bar", title="£4 pints")
        digest_only = rec("meh", title="Cheese", venue_name="Other", recurrence={"type": "always"}, _evidence=None,
                          extraction_status="pending", validation_errors=["x"])
        checked: list[str] = []

        def verify(r):
            checked.append(r["slug"])
            return ["gone"] if r["slug"] == "best" else []

        out = run([best, second, digest_only], verify=verify)
        routes = {r.record["slug"]: r.route for r in out.final}
        self.assertEqual(routes, {"best": "digest", "second": "publish", "meh": "digest"})
        self.assertNotIn("meh", checked)
        self.assertEqual(sorted(checked), ["best", "second"])

    def test_the_per_run_limit_on_page_checks(self):
        records = [rec(f"r{i}", venue_name=f"Venue {i}", source_name=f"S{i}") for i in range(8)]
        calls: list[str] = []
        final, fresh_ok, stats = dr.finalize(dr.route_records(records, {}, today=TODAY, now=NOW),
                                             lambda r: calls.append(r["slug"]) or [], max_checks=3)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(fresh_ok), 3)
        self.assertEqual(sum(1 for r in final if r.route == "publish"), 3)
        self.assertEqual(stats.skipped_over_limit, 5)


class AutoPublishTests(unittest.TestCase):
    def setUp(self):
        self.approved: list[tuple[str, list[str]]] = []
        self.promoted: list[tuple[str, list[str]]] = []

    def approve(self, batch, slugs):
        self.approved.append((batch, list(slugs)))
        return list(slugs), None

    def promote(self, batch, slugs):
        self.promoted.append((batch, list(slugs)))
        return None

    def test_off_nothing_is_approved_or_promoted(self):
        out = run([rec("a"), rec("b")])
        self.assertEqual(len(out.publishable), 2)
        result = dr.auto_publish(out, "b1", enabled=False, approve=self.approve, promote=self.promote, log=lambda _m: None)
        self.assertEqual((self.approved, self.promoted), ([], []))
        self.assertEqual((result.approved, result.promoted), ([], False))

    def test_on_only_the_publishable_rows_are_approved_and_promoted(self):
        rows = [rec("good"), rec("stale"), rec("social", source_url="https://instagram.com/p/x/"),
                rec("weak", title="Cheese", venue_name="Other", recurrence={"type": "always"}, _evidence=None,
                    extraction_status="pending", validation_errors=["x"])]
        out = run(rows, verify=lambda r: ["gone"] if r["slug"] == "stale" else [])
        result = dr.auto_publish(out, "b1", enabled=True, approve=self.approve, promote=self.promote, log=lambda _m: None)
        self.assertEqual(self.approved, [("b1", ["good"])])
        self.assertEqual(self.promoted, [("b1", ["good"])])
        self.assertTrue(result.promoted)

    def test_a_social_row_cannot_publish_even_when_forced_to_a_publish_route(self):
        out = run([rec("web")])
        forced = quality.RoutedDeal(rec("insta", source_url="https://www.instagram.com/p/x/"), quality.QualityResult(99, []), "publish")
        news = quality.RoutedDeal(rec("news", source_name="Some newsletter"), quality.QualityResult(99, []), "publish")
        out.final.extend([forced, news])
        out.fresh_ok.update({"insta", "news"})
        dr.auto_publish(out, "b1", enabled=True, approve=self.approve, promote=self.promote, log=lambda _m: None)
        self.assertEqual(self.approved, [("b1", ["web"])])
        self.assertEqual(self.promoted, [("b1", ["web"])])

    def test_a_row_that_was_not_freshly_verified_is_never_published(self):
        out = run([rec("a")])
        out.fresh_ok.clear()
        dr.auto_publish(out, "b1", enabled=True, approve=self.approve, promote=self.promote, log=lambda _m: None)
        self.assertEqual((self.approved, self.promoted), ([], []))

    def test_a_slug_the_promote_script_could_misread_is_never_passed(self):
        out = run([rec("good"), rec("a,b"), rec("Upper Case")])
        dr.auto_publish(out, "b1", enabled=True, approve=self.approve, promote=self.promote, log=lambda _m: None)
        self.assertEqual(self.promoted, [("b1", ["good"])])

    def test_only_slugs_that_were_really_approved_are_promoted(self):
        out = run([rec("a"), rec("b")])
        dr.auto_publish(out, "b1", enabled=True, approve=lambda b, s: (["a", "not-asked-for"], None), promote=self.promote, log=lambda _m: None)
        self.assertEqual(self.promoted, [("b1", ["a"])])

    def test_an_approve_error_stops_before_promotion(self):
        out = run([rec("a")])
        result = dr.auto_publish(out, "b1", enabled=True, approve=lambda b, s: ([], "HTTP 500"), promote=self.promote, log=lambda _m: None)
        self.assertEqual(self.promoted, [])
        self.assertIn("HTTP 500", result.notes[0])

    def test_a_promote_failure_is_reported_not_raised(self):
        out = run([rec("a")])
        result = dr.auto_publish(out, "b1", enabled=True, approve=self.approve, promote=lambda b, s: "node exploded", log=lambda _m: None)
        self.assertFalse(result.promoted)
        self.assertIn("node exploded", result.notes[0])

    def test_the_real_helpers_are_not_reached_with_the_flag_off(self):
        out = run([rec("a")])
        with mock.patch.object(dr, "approve_staged_rows") as ap, mock.patch.object(dr, "promote_staged_rows") as pr:
            dr.auto_publish(out, "b1", enabled=False, log=lambda _m: None)
            ap.assert_not_called()
            pr.assert_not_called()


class MainFlagTests(unittest.TestCase):
    """weekly_edinburgh.main end to end with every outside call faked."""

    def run_main(self, flags, existing=(), this_batch=(), history=(None, None)):
        records = [rec("good", _trust="official", source_name="Forever Edinburgh offers"),
                   rec("social", source_url="https://www.instagram.com/p/x/", _trust="official"),
                   rec("weak", title="Cheese", venue_name="Other", recurrence={"type": "always"}, _evidence=None, _trust="official")]
        if history == (None, None):
            history = (dr.PublishHistory(0, []), None)
        deal_result = DealRunResult(live_records=[json.loads(json.dumps(r)) for r in records])
        staged: list[list[dict]] = []
        approve = mock.Mock(side_effect=lambda b, s: (list(s), None))
        promote = mock.Mock(return_value=None)
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(weekly, "OUT_ROOT", Path(tmp)), \
                mock.patch.object(weekly, "load_catalogue", return_value=(None, None)), \
                mock.patch.object(weekly, "supabase_connection", return_value=("http://x", "k")), \
                mock.patch.object(sg, "make_get_all", return_value=object()), \
                mock.patch.object(sg, "load_rows", return_value=(list(existing), list(this_batch), [])), \
                mock.patch.object(dr, "load_publish_history", return_value=history), \
                mock.patch.object(weekly, "run_deal_sources", return_value=deal_result), \
                mock.patch.object(weekly, "link_batch_records", return_value=None), \
                mock.patch.object(weekly, "attach_publisher_images", return_value=None), \
                mock.patch.object(weekly, "verify_record", side_effect=lambda r, recheck=False: (r, [])), \
                mock.patch.object(weekly, "make_rating_call", side_effect=RuntimeError("no rating")), \
                mock.patch.object(page_check, "make_fetcher", return_value=ok_page), \
                mock.patch.object(weekly, "upsert_happenings", side_effect=lambda rows: staged.append([dict(r) for r in rows]) or len(rows)), \
                mock.patch.object(dr, "approve_staged_rows", approve), \
                mock.patch.object(dr, "promote_staged_rows", promote), \
                mock.patch.object(sys, "argv", ["weekly_edinburgh.py", "--only-deal-sources", "--stage", "--batch-id", "b1", *flags]), \
                redirect_stdout(io.StringIO()):
            weekly.main()
            report = (Path(tmp) / "b1" / "weekly-report.md").read_text()
            report_json = json.loads((Path(tmp) / "b1" / "weekly-report.json").read_text())
        return staged, approve, promote, report, report_json

    def test_flag_off_stages_with_quality_columns_and_approves_nothing(self):
        staged, approve, promote, report, report_json = self.run_main([])
        approve.assert_not_called()
        promote.assert_not_called()
        rows = {r["slug"]: r for r in staged[0]}
        self.assertEqual(rows["good"]["quality_route"], "publish")  # routed publish, but only reported
        self.assertEqual(rows["social"]["quality_route"], "digest")
        self.assertNotIn("approved", {k for r in staged[0] for k, v in r.items() if v is True})
        self.assertTrue(all(r.get("approved") in (None, False) for r in staged[0]))
        self.assertIn("Auto-publish is OFF", report)
        self.assertIn("would publish", report)
        self.assertEqual(report_json["routing"]["would_publish"], ["good"])
        self.assertEqual(report_json["routing"]["published"], [])

    def test_flag_on_approves_and_promotes_exactly_the_publishable_row(self):
        staged, approve, promote, report, report_json = self.run_main(["--auto-publish"])
        approve.assert_called_once_with("b1", ["good"])
        promote.assert_called_once_with("b1", ["good"])
        self.assertIn("Auto-publish is ON", report)
        self.assertEqual(report_json["routing"]["published"], ["good"])
        self.assertTrue(all(not r.get("approved") for r in staged[0]))  # approval is a separate PATCH, not part of the upsert

    def test_auto_publish_needs_stage_and_is_not_combinable_with_publish(self):
        for argv in (["--auto-publish"], ["--stage", "--auto-publish", "--publish"], ["--deal-sources-preview", "--auto-publish"]):
            with mock.patch.object(sys, "argv", ["weekly_edinburgh.py", *argv]), redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit) as ctx:
                weekly.main()
            self.assertEqual(ctx.exception.code, 2, argv)

    def test_auto_publish_is_off_by_default(self):
        with mock.patch.object(sys, "argv", ["weekly_edinburgh.py", "--dry-run"]):
            parser_args = None
            import argparse
            orig = argparse.ArgumentParser.parse_args

            def spy(self, *a, **k):
                nonlocal parser_args
                parser_args = orig(self, *a, **k)
                return parser_args

            with mock.patch.object(argparse.ArgumentParser, "parse_args", spy), redirect_stdout(io.StringIO()):
                weekly.main()
        self.assertFalse(parser_args.auto_publish)
        self.assertEqual(parser_args.topic_slice, "all")


class TopicSliceTests(unittest.TestCase):
    def test_each_topic_runs_once_a_week_and_deal_topics_twice(self):
        for topic in weekly.TOPICS:
            days = [d for d in range(7) if topic in weekly.topic_slice(weekly.TOPICS, d)]
            self.assertEqual(len(days), 2 if weekly.is_deal_topic(topic) else 1, topic.name)
            if weekly.is_deal_topic(topic):
                gap = (days[1] - days[0]) % 7
                self.assertIn(gap, (3, 4), topic.name)

    def test_deal_topics_are_the_offers_student_resident_and_concession_ones(self):
        by_name = {t.name: t for t in weekly.TOPICS}
        for name in ("Edinburgh resident rewards", "student deals in Edinburgh", "Edinburgh student nights by weekday",
                     "under-26 concessions", "over-60 concessions", "Edinburgh happy hours", "cheap cinema days"):
            self.assertTrue(weekly.is_deal_topic(by_name[name]), name)
        for name in ("Hogmanay ticket releases", "Cramond parkrun", "Heart of Midlothian home fixtures", "free walking tours"):
            self.assertFalse(weekly.is_deal_topic(by_name[name]), name)

    def test_the_slices_are_balanced_and_deterministic(self):
        sizes = [len(weekly.topic_slice(weekly.TOPICS, d)) for d in range(7)]
        self.assertEqual(sum(sizes), sum(2 if weekly.is_deal_topic(t) else 1 for t in weekly.TOPICS))
        self.assertLessEqual(max(sizes) - min(sizes), 2)
        self.assertEqual(weekly.topic_slice(weekly.TOPICS, 3), weekly.topic_slice(weekly.TOPICS, 3))

    def test_dated_holiday_topics_keep_their_two_days(self):
        topics = weekly.topics_for(date(2026, 12, 5))
        dated = [t for t in topics if t not in weekly.TOPICS]
        self.assertTrue(dated)
        for topic in dated:
            self.assertEqual(len(weekly.topic_days(topic)), 2)
            self.assertEqual(weekly.topic_days(topic), weekly.topic_days(topic))

    def test_london_weekday(self):
        self.assertEqual(weekly.london_weekday(datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)), 0)  # Monday
        self.assertEqual(weekly.london_weekday(datetime(2026, 11, 1, 23, 30, tzinfo=timezone.utc)), 6)  # Sunday, GMT
        self.assertEqual(weekly.london_weekday(datetime(2026, 7, 5, 23, 30, tzinfo=timezone.utc)), 0)  # 00:30 Monday BST

    def test_bad_values_are_refused(self):
        for value in ("7", "-1", "monday", ""):
            with mock.patch.object(sys, "argv", ["weekly_edinburgh.py", "--dry-run", "--topic-slice", value]), \
                    redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                weekly.main()


class QualityColumnTests(unittest.TestCase):
    def post_fn(self, fail_on_quality):
        sent: list[list[dict]] = []

        def fake_post(url, headers=None, params=None, json=None, timeout=None):
            sent.append(json)
            resp = mock.Mock()
            if fail_on_quality and any("quality_route" in row for row in json):
                resp.status_code = 400
                resp.text = '{"code":"PGRST204","message":"Could not find the \'quality_route\' column of \'happenings_staging\' in the schema cache"}'
            else:
                resp.status_code = 201
                resp.text = ""
            return resp

        return fake_post, sent

    def test_quality_columns_are_sent_and_dropped_once_when_missing(self):
        row = {"batch_id": "b", "slug": "s", "title": "T", "quality_score": 80, "quality_reasons": ["x"], "quality_route": "publish"}
        upsert_happenings._quality_columns_missing = False
        post, sent = self.post_fn(False)
        with mock.patch.object(upsert_happenings, "_get_credentials", return_value=("http://x", "k")), \
                mock.patch.object(upsert_happenings.requests, "post", post), redirect_stdout(io.StringIO()):
            upsert_happenings.upsert_happenings([row])
        self.assertEqual(sent[0][0]["quality_route"], "publish")
        self.assertFalse(upsert_happenings.quality_columns_missing())

        post, sent = self.post_fn(True)
        err = io.StringIO()
        with mock.patch.object(upsert_happenings, "_get_credentials", return_value=("http://x", "k")), \
                mock.patch.object(upsert_happenings.requests, "post", post), redirect_stdout(io.StringIO()), redirect_stderr(err):
            n = upsert_happenings.upsert_happenings([row])
            upsert_happenings.upsert_happenings([row])
        self.assertEqual(n, 1)
        self.assertEqual(len(sent), 4)  # each call: the failed attempt, then the retry without the columns
        self.assertNotIn("quality_route", sent[1][0])
        self.assertEqual(err.getvalue().count("quality_* columns not found"), 1)  # logged once
        self.assertTrue(upsert_happenings.quality_columns_missing())
        upsert_happenings._quality_columns_missing = False


class ReportTests(unittest.TestCase):
    def test_report_section_states_mode_evidence_and_cost(self):
        out = run([rec("a", source_name="itison Edinburgh deals"), rec("b", source_name="itison Edinburgh deals", _evidence=None,
                                                                   extraction_status="pending", validation_errors=["x"])])
        off = "\n".join(dr.markdown_section(out, auto_publish_on=False))
        self.assertIn("Auto-publish is OFF", off)
        self.assertIn("would publish", off)
        self.assertIn("1 of 2", off)  # rows with _evidence
        self.assertIn("cost $", off)
        on = "\n".join(dr.markdown_section(out, auto_publish_on=True, published=dr.PublishResult(["a"], True)))
        self.assertIn("Auto-publish is ON", on)
        missing = "\n".join(dr.markdown_section(out, auto_publish_on=False, columns_missing=True))
        self.assertIn("add_deal_quality.sql", missing)


def prior(slug, **over):
    base = {"id": f"p-{slug}", "slug": slug, "batch_id": "b0", "title": "£3 cask pints", "kind": "deal", "venue_name": f"Local Bar {slug}",
            "saving_label": None, "starts_at": None, "ends_at": None, "recurrence": {"type": "weekly", "days": [2]},
            "approved": False, "extraction_status": "validated", "happening_id": None, "created_at": "2026-10-30T10:00:00+00:00",
            "reviewed_at": None, "reviewed_action": None}
    base.update(over)
    return base


class StagingGuardTests(unittest.TestCase):
    NOW = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)

    def guard(self, records, others=(), mine=()):
        return sg.apply_guard(records, list(others), list(mine), now=self.NOW)

    def test_a_deal_still_waiting_from_an_earlier_batch_is_not_staged_again(self):
        other = rec("b", title="Half price cocktails", venue_name="The Voodoo Rooms", saving_label="half price")
        kept, stats = self.guard([rec("a"), other], others=[prior("a")])
        self.assertEqual([r["slug"] for r in kept], ["b"])
        self.assertEqual(stats.already_waiting, [("£3 cask pints", "b0")])
        self.assertEqual(stats.skipped_slugs, {"a"})

    def test_a_paraphrased_title_is_caught_by_identity_matching(self):
        waiting = prior("old-slug", title="Nobles of Bellfield £4 cask pints", venue_name="Nobles of Bellfield", saving_label="£4 cask pints")
        again = rec("new-slug", title="£4 cask pints at Nobles of Bellfield", venue_name="Nobles of Bellfield", saving_label="£4 cask pints")
        kept, stats = self.guard([again], others=[waiting])
        self.assertEqual(kept, [])
        self.assertEqual(len(stats.already_waiting), 1)
        # a different offer at the same venue is not the same thing
        other = rec("other", title="Nobles of Bellfield 50% off burgers", venue_name="Nobles of Bellfield", saving_label="50% off burgers")
        kept, _ = self.guard([other], others=[waiting])
        self.assertEqual(len(kept), 1)

    def test_a_rejected_deal_stays_out_unless_its_label_or_dates_changed(self):
        rejected = prior("a", reviewed_action="reject", reviewed_at="2026-10-30T10:00:00+00:00", saving_label="£3 pints")
        kept, stats = self.guard([rec("a", saving_label="£3 pints")], others=[rejected])
        self.assertEqual(kept, [])
        self.assertEqual(len(stats.rejected), 1)
        kept, stats = self.guard([rec("a", saving_label="£2 pints")], others=[rejected])  # label changed
        self.assertEqual(len(kept), 1)
        self.assertEqual(stats.changed_after_reject, ["£3 cask pints"])
        kept, _ = self.guard([rec("a", saving_label="£3 pints", ends_at="2026-12-01T00:00:00+00:00")], others=[rejected])  # dates changed
        self.assertEqual(len(kept), 1)
        kept, _ = self.guard([rec("a", saving_label="£3 pints", recurrence={"type": "weekly", "days": [4]})], others=[rejected])
        self.assertEqual(len(kept), 1)
        # an extraction_status of rejected counts too, even without reviewed_action
        legacy = prior("a", extraction_status="rejected", saving_label="£3 pints")
        self.assertEqual(self.guard([rec("a", saving_label="£3 pints")], others=[legacy])[0], [])

    def test_an_unreviewed_expiry_may_return_after_30_days(self):
        def expired(days):
            when = (self.NOW - timedelta(days=days)).isoformat()
            # add_deal_review.sql marks an expiry extraction_status = 'rejected' too: that must not read as a person's rejection
            return prior("a", reviewed_action="expired", reviewed_at=when, extraction_status="rejected")
        kept, stats = self.guard([rec("a")], others=[expired(10)])
        self.assertEqual((kept, len(stats.expired)), ([], 1))
        kept, stats = self.guard([rec("a")], others=[expired(29)])
        self.assertEqual(kept, [])
        kept, stats = self.guard([rec("a")], others=[expired(31)])
        self.assertEqual(len(kept), 1)
        self.assertEqual(len(stats.expired), 0)

    def test_a_same_batch_row_a_person_reviewed_is_left_alone(self):
        records = [rec("approved"), rec("rejected"), rec("reviewed"), rec("promoted"), rec("untouched")]
        mine = [prior("approved", batch_id="b1", approved=True, extraction_status="approved"),
                prior("rejected", batch_id="b1", extraction_status="rejected", reviewed_action="reject", reviewed_at="2026-11-02T09:00:00+00:00"),
                prior("reviewed", batch_id="b1", reviewed_at="2026-11-02T09:00:00+00:00"),
                prior("promoted", batch_id="b1", extraction_status="promoted"),
                prior("untouched", batch_id="b1")]
        kept, stats = self.guard(records, mine=mine)
        self.assertEqual([r["slug"] for r in kept], ["untouched"])  # a plain re-run still refreshes it
        self.assertEqual(len(stats.reviewed_in_batch), 4)

    def test_a_superseded_copy_is_neither_waiting_nor_a_rejection(self):
        kept, stats = self.guard([rec("a")], others=[prior("a", reviewed_action="superseded", extraction_status="rejected",
                                                           reviewed_at="2026-10-30T10:00:00+00:00")])
        self.assertEqual(len(kept), 1)
        self.assertEqual(stats.total, 0)

    def test_other_batches_reviewed_approvals_do_not_block(self):
        # an approved-and-promoted row is live: identity handles it, the guard does not
        kept, _ = self.guard([rec("a")], others=[prior("a", approved=True, extraction_status="promoted", happening_id="h1")])
        self.assertEqual(len(kept), 1)

    def test_loading_without_the_review_columns_logs_once_and_carries_on(self):
        calls: list[dict] = []

        def get_all(table, params):
            calls.append(params)
            if "reviewed_at" in params["select"]:
                raise RuntimeError('HTTP 400: {"code":"42703","message":"column happenings_staging.reviewed_at does not exist"}')
            return [prior("a")]

        others, mine, notes = sg.load_rows("b1", get_all)
        self.assertEqual(len(others), 1)
        self.assertEqual(len([n for n in notes if "add_deal_review.sql" in n]), 1)
        self.assertEqual(len(calls), 4)  # two queries, each tried with and without the columns

    def test_a_failed_read_stages_everything_and_says_so(self):
        def boom(table, params):
            raise RuntimeError("HTTP 500")

        others, mine, notes = sg.load_rows("b1", boom)
        self.assertEqual((others, mine), ([], []))
        self.assertIn("staging guard skipped", notes[0])
        kept, _ = self.guard([rec("a")], others, mine)
        self.assertEqual(len(kept), 1)

    def test_report_section_counts_each_case(self):
        _, stats = self.guard([rec("a"), rec("b", saving_label="x")], others=[prior("a"), prior("b", reviewed_action="reject", saving_label="x")])
        text = "\n".join(sg.markdown_section(stats))
        self.assertIn("already waiting 1", text)
        self.assertIn("rejected earlier 1", text)


class EvidenceQuoteTests(unittest.TestCase):
    def test_the_deal_quote_is_staged_and_a_topic_record_gets_none(self):
        withq = rec("a", _evidence={"deal_quote": "  £3 cask   pints\non Wednesdays "})
        field_only = rec("b", _evidence={"deal_quote": None, "fields": {"saving_label": {"value": "x", "quote": "£4 pints"}}})
        topic = rec("c", _evidence=None)
        out = run([withq, field_only, topic])
        by = {r.record["slug"]: r.record for r in out.final}
        self.assertEqual(by["a"]["evidence_quote"], "£3 cask pints on Wednesdays")
        self.assertEqual(by["b"]["evidence_quote"], "£4 pints")
        self.assertNotIn("evidence_quote", by["c"])
        self.assertEqual(len(dr.evidence_quote(rec("d", _evidence={"deal_quote": "x" * 2000}))), dr.EVIDENCE_QUOTE_MAX)

    def test_the_upsert_sends_evidence_quote_and_drops_it_with_the_quality_columns_when_missing(self):
        self.assertIn("evidence_quote", upsert_happenings.ALLOWED_COLUMNS)
        self.assertIn("evidence_quote", upsert_happenings.QUALITY_COLUMNS)
        row = {"batch_id": "b", "slug": "s", "title": "T", "evidence_quote": "q"}
        sent = []

        def post(url, headers=None, params=None, json=None, timeout=None):
            sent.append(json)
            r = mock.Mock()
            r.status_code, r.text = (400, '{"code":"PGRST204","message":"Could not find the \'evidence_quote\' column"}') if "evidence_quote" in json[0] else (201, "")
            return r

        upsert_happenings._quality_columns_missing = False
        with mock.patch.object(upsert_happenings, "_get_credentials", return_value=("http://x", "k")), \
                mock.patch.object(upsert_happenings.requests, "post", post), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            upsert_happenings.upsert_happenings([row])
        self.assertNotIn("evidence_quote", sent[-1][0])
        upsert_happenings._quality_columns_missing = False


class GuardInMainTests(unittest.TestCase):
    def test_main_leaves_waiting_and_reviewed_rows_out_of_the_upsert_and_the_publish(self):
        existing = [prior("social", batch_id="b0")]  # "social" is already waiting from yesterday
        this_batch = [prior("good", batch_id="b1", approved=True, extraction_status="approved")]  # approved today by a person
        staged, approve, promote, report, report_json = MainFlagTests.run_main(MainFlagTests(), ["--auto-publish"], existing, this_batch)
        slugs = {r["slug"] for r in staged[0]}
        self.assertEqual(slugs, {"weak"})  # "good" is protected, "social" is waiting
        approve.assert_not_called()  # the protected row is not published a second time
        promote.assert_not_called()
        self.assertEqual(report_json["staging_guard"]["already_waiting"], 1)
        self.assertEqual(report_json["staging_guard"]["reviewed_in_batch"], 1)
        self.assertIn("## Staging guard", report)


class CrossRunLimitTests(unittest.TestCase):
    def rows(self, n, **over):
        return [rec(f"r{i}", venue_name=f"Venue {i} Tavern", title=f"£3 pints at venue {i}", source_name=f"S{i}", **over) for i in range(n)]

    def published(self, n):
        return dr.PublishHistory(n, [{"slug": f"old{i}", "title": f"Old {i}", "venue_name": f"Elsewhere {i}", "created_at": "2026-11-02T08:00:00+00:00"} for i in range(n)])

    def test_history_counts_today_by_london_date_and_keeps_the_week(self):
        seen = {}

        def get_all(table, params):
            seen.update(params, table=table)
            return [{"slug": "a", "created_at": "2026-07-01T22:30:00+00:00", "title": "A", "venue_name": "V"},   # 23:30 BST on 1 July
                    {"slug": "b", "created_at": "2026-07-01T23:10:00+00:00", "title": "B", "venue_name": "W"},   # 00:10 BST on 2 July
                    {"slug": "c", "created_at": "2026-06-30T10:00:00+00:00", "title": "C", "venue_name": "X"}]

        history, error = dr.load_publish_history(get_all, now=datetime(2026, 7, 1, 23, 30, tzinfo=timezone.utc))  # 00:30 BST on 2 July
        self.assertIsNone(error)
        self.assertEqual(history.published_today, 1)
        self.assertEqual(len(history.recent), 3)
        self.assertEqual((seen["table"], seen["quality_route"], seen["approved"]), ("happenings_staging", "eq.publish", "eq.true"))
        self.assertEqual(seen["created_at"], "gte.2026-06-24T23:30:00Z")

    def test_an_unreadable_history_is_reported_not_raised(self):
        def boom(table, params):
            raise RuntimeError('HTTP 400: {"code":"42703","message":"column quality_route does not exist"}')

        history, error = dr.load_publish_history(boom)
        self.assertIsNone(history)
        self.assertIn("quality_route", error)

    def test_only_the_days_remainder_can_publish(self):
        out = run(self.rows(4), history=self.published(8))
        self.assertEqual(sum(1 for r in out.final if r.route == "publish"), 2)
        self.assertEqual(out.fresh.already_today, 8)
        demoted = [r for r in out.final if r.route == "digest"]
        self.assertTrue(all("over the daily limit of 10 (8 already published today)" in r.result.reasons[-1] for r in demoted))

    def test_a_day_already_at_the_limit_publishes_nothing(self):
        out = run(self.rows(3), history=self.published(10))
        self.assertEqual([r.route for r in out.final], ["digest"] * 3)
        self.assertEqual(out.publishable, [])
        self.assertIn("daily limit of 10 already reached today", out.final[0].result.reasons[-1])
        self.assertEqual(out.fresh.blocked, 3)

    def test_a_rerun_cannot_publish_another_ten(self):
        first = run(self.rows(12))
        self.assertEqual(len(first.publishable), 10)
        # the same day's second run sees those ten as published
        second = run([rec(f"n{i}", venue_name=f"New {i} Tavern", title=f"£3 pints new {i}", source_name=f"T{i}") for i in range(5)],
                     history=self.published(10))
        self.assertEqual(second.publishable, [])

    def test_a_venue_published_in_the_last_week_goes_to_digest_with_a_reason(self):
        history = dr.PublishHistory(1, [{"slug": "bb", "title": "The Blackbird pint deal", "venue_name": "The Blackbird",
                                         "created_at": "2026-10-30T11:50:00+00:00"},
                                        {"slug": "cv", "title": "Civerinos slice", "venue_name": "Civerinos", "created_at": "2026-10-31T11:50:00+00:00"}])
        rows = [rec("a", venue_name="The Blackbird"), rec("b", venue_name="Civerinos Portobello", source_name="S2"),
                rec("c", venue_name="Brand New Bar", source_name="S3")]
        out = run(rows, history=history)
        routes = {r.record["slug"]: r for r in out.final}
        self.assertEqual({k: v.route for k, v in routes.items()}, {"a": "digest", "b": "digest", "c": "publish"})
        self.assertIn("venue cooldown: 'The Blackbird pint deal' was auto-published at this venue on 2026-10-30", routes["a"].result.reasons[-1])
        self.assertIn("Civerinos slice", routes["b"].result.reasons[-1])  # same_venue: name plus an area word
        self.assertEqual(out.fresh.cooldown, 2)

    def test_cooldown_uses_place_id_when_both_have_one(self):
        history = dr.PublishHistory(1, [{"slug": "x", "title": "T", "venue_name": "Name One", "place_id": "p1", "created_at": "2026-11-01T10:00:00+00:00"}])
        out = run([rec("a", venue_name="Different Name", place_id="p1"), rec("b", venue_name="Name One", place_id="p2", source_name="S2")], history=history)
        self.assertEqual({r.record["slug"]: r.route for r in out.final}, {"a": "digest", "b": "publish"})

    def test_an_unreadable_history_publishes_nothing_when_auto_publish_is_on(self):
        logged: list[str] = []
        out = dr.run_routing([rec("a")], make_rating_call=no_rating, verify=passes, in_rate=0.28, out_rate=0.42, rating_budget_usd=0.03,
                             today=TODAY, now=NOW, history=None, history_error="RuntimeError: HTTP 400", fail_safe=True, log=logged.append)
        self.assertEqual(out.final[0].route, "digest")
        self.assertEqual(out.publishable, [])
        self.assertIn("could not be read", out.final[0].result.reasons[-1])
        self.assertTrue(any("could not be read" in m for m in logged))
        calls = []
        result = dr.auto_publish(out, "b1", enabled=True, approve=lambda b, s: calls.append(s) or (s, None), promote=lambda b, s: None, log=lambda _m: None)
        self.assertEqual((calls, result.approved), ([], []))

    def test_in_shadow_an_unreadable_history_is_reported_and_the_cross_run_limits_are_skipped(self):
        out = dr.run_routing([rec("a")], make_rating_call=no_rating, verify=passes, in_rate=0.28, out_rate=0.42, rating_budget_usd=0.03,
                             today=TODAY, now=NOW, history=None, history_error="RuntimeError: HTTP 400", fail_safe=False, log=lambda _m: None)
        self.assertEqual(out.final[0].route, "publish")
        text = "\n".join(dr.markdown_section(out, auto_publish_on=False))
        self.assertIn("Limit history unavailable", text)
        self.assertIn("ignores the cross-run limits", text)

    def test_the_report_states_the_cross_run_numbers(self):
        out = run(self.rows(2), history=self.published(3))
        text = "\n".join(dr.markdown_section(out, auto_publish_on=False))
        self.assertIn("Published today before this run: 3 of 10", text)

    def test_through_main_auto_publish_respects_the_day_and_the_cooldown_and_fails_safe(self):
        t = MainFlagTests()
        # day already full
        _, approve, promote, report, rj = t.run_main(["--auto-publish"], history=(dr.PublishHistory(10, []), None))
        approve.assert_not_called()
        promote.assert_not_called()
        # the venue of the only publishable row published this week
        recent = [{"slug": "x", "title": "Earlier deal", "venue_name": "Local Bar good", "created_at": "2026-11-01T10:00:00+00:00"}]
        _, approve, promote, report, rj = t.run_main(["--auto-publish"], history=(dr.PublishHistory(1, recent), None))
        approve.assert_not_called()
        # history unreadable
        _, approve, promote, report, rj = t.run_main(["--auto-publish"], history=(None, "RuntimeError: HTTP 400"))
        approve.assert_not_called()
        promote.assert_not_called()
        self.assertIn("Limit history unavailable", report)
        # shadow mode applies the same rules: the cooled-down venue is not in "would publish"
        _, approve, promote, report, rj = t.run_main([], history=(dr.PublishHistory(1, recent), None))
        self.assertEqual(rj["routing"]["would_publish"], [])
        approve.assert_not_called()
        # and with a clean history it publishes exactly the one row
        _, approve, _, _, rj = t.run_main(["--auto-publish"], history=(dr.PublishHistory(2, []), None))
        approve.assert_called_once_with("b1", ["good"])


if __name__ == "__main__":
    unittest.main()
