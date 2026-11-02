"""Tests for the digest quality fixes: the source page check, lapsed series, the rating prompt, the
non-deal score cap, live-duplicate matching and the backlog flow that ties them together.

Run: python3 scraper/test_digest_quality.py   (stdlib unittest; no network, no database, no API key)

Every outside call is a fake. The page text in the fixtures below is cut from the real pages the
2 Nov review opened (Leith Laughs on edfringe.com, Slainte Mhath on What's On Edinburgh, Bonnie & Wild,
Malones Leith), keeping only the parts the rules read.
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import deal_routing as dr  # noqa: E402
import page_check as pc  # noqa: E402
import score_backlog as sb  # noqa: E402
from deal_sources import quality  # noqa: E402
from identity import Catalogue  # noqa: E402

TODAY = date(2026, 11, 2)
NOW = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)


class Resp:
    def __init__(self, ok=True, status=200, text="", reason=None):
        self.ok, self.status, self.text, self.reason = ok, status, text, reason


def structured(*days):
    """Raw page markup with a JSON blob of occurrence dates, as the Fringe site embeds them."""
    blob = ",".join(f'{{"startDateTime":"{d}T14:00:00.000Z","estimatedEndDateTime":"{d}T15:00:00.000Z","status":"OK"}}' for d in days)
    return f'<script id="data" type="application/json">{{"occurrences":[{blob}]}}</script>'


LEITH = ("<html><body><h1>Leith Laughs – Pick of the Fringe</h1><p>A handpicked selection of the best comedians at Fringe 2026 in the "
         "heart of Leith every Saturday and Sunday, for absolutely free!! See the very best in Fringe Comedy at the Brass Monkey on "
         "Leith Walk.</p></body></html>"
         + structured("2026-08-08", "2026-08-09", "2026-08-15", "2026-08-16", "2026-08-22", "2026-08-23", "2026-08-29", "2026-08-30"))
SLAINTE = ("<html><body><h1>Gooses Quiz At Slàinte Mhath</h1><p>Listed Under: Quiz Night Events 2nd November 2026 9th November 2026 16th November "
           "2026 plus 42 more date(s) 7pm Slainte Mhath Edinburgh 143 Cowgate. This is a free event. Free Entry 7pm Every Monday. "
           "Additional Dates: 09 November 2026, 16 November 2026, 23 November 2026, 28 December 2026, 04 January 2027</p></body></html>")
BONNIE = ("<html><body><h1>The White Heather Club Ceilidh - Thursday May 28th</h1><p>Head to the legendary White Heather Club on Level 4 of the St "
          "James Quarter on the last Thursday of every month. Free entry and all welcome.</p><p>Event details 28 th May 2026 8pm-11pm</p></body></html>")
MALONES = ("<html><body><h1>Pub quiz in Leith</h1><p>Malones Leith hosts Goose's Quizzes every Monday at 7pm. The quiz will not be running on "
           "Monday 29th June or 6th July due to World Cup clashes. Price: 1st place £50 bar tab.</p></body></html>")
ONE_OFF_PAST = "<html><body><h1>Autumn Craft Fair</h1><p>Join us on 11 September 2026 for stalls and cake. Free entry.</p></body></html>"


class LapsedSeriesTests(unittest.TestCase):
    def reason(self, markup, record=None):
        return pc.lapsed_reason(pc.page_text(markup), markup, TODAY, record)

    def test_leith_laughs_is_lapsed_though_it_says_every_saturday_and_sunday(self):
        why = self.reason(LEITH, {"recurrence": {"type": "weekly", "days": [0, 6], "until": None}})
        self.assertIsNotNone(why)
        self.assertIn("8 date(s)", why)
        self.assertIn("2026-08-30", why)

    def test_a_true_weekly_row_with_future_dates_is_not_lapsed(self):
        self.assertIsNone(self.reason(SLAINTE, {"recurrence": {"type": "weekly", "days": [1]}}))

    def test_a_weekly_page_with_no_dates_at_all_is_not_lapsed(self):
        self.assertIsNone(self.reason(MALONES, {"recurrence": {"type": "weekly", "days": [1]}}))

    def test_one_stale_date_beside_a_standing_monthly_series_is_left_in_the_digest(self):
        self.assertIsNone(self.reason(BONNIE, {"recurrence": {"type": "weekly", "days": [4]}}))

    def test_a_single_past_date_on_a_non_recurring_page_is_lapsed(self):
        self.assertIsNotNone(self.reason(ONE_OFF_PAST, {"recurrence": {"type": "once"}}))

    def test_a_single_past_date_for_a_weekly_record_is_left_alone(self):
        self.assertIsNone(self.reason(ONE_OFF_PAST, {"recurrence": {"type": "weekly", "days": [3]}}))

    def test_old_posts_on_a_weekly_venue_page_do_not_make_it_lapsed(self):
        # A social mirror of a pub's page: weekly record, several visible past dates, no embedded occurrence list.
        page = ("<html><body><p>The Auld Hoose quiz night every Tuesday. Posted 28 September 2026 ... 5 October 2026 ... 21 September 2026 ... "
                "14 September 2026 ...</p></body></html>")
        self.assertIsNone(self.reason(page, {"recurrence": {"type": "weekly", "days": [2], "until": None}}))
        self.assertIsNone(self.reason(page.replace("every Tuesday", "on Tuesdays"), {"recurrence": {"type": "always"}}))

    def test_history_dates_and_since_dates_are_not_event_dates(self):
        page = "<html><body><p>Family-run since 12 May 2019. Students get 10% off at the bar.</p></body></html>"
        self.assertIsNone(self.reason(page, {"recurrence": {"type": "once"}}))
        old = "<html><body><p>Leaflet printed 3 March 2024. Students get 10% off.</p></body></html>"
        self.assertIsNone(self.reason(old, {"recurrence": {"type": "once"}}))  # older than the recent-past window

    def test_two_embedded_dates_are_not_enough_beside_recurring_wording(self):
        page = "<html><body><p>Comedy every Saturday.</p></body></html>" + structured("2026-08-08", "2026-08-09")
        self.assertIsNone(self.reason(page, {"recurrence": {"type": "weekly", "days": [6]}}))

    def test_a_later_year_or_open_ended_wording_means_it_is_not_over(self):
        self.assertIsNone(self.reason(LEITH.replace("</p></body>", " Back again in 2027!</p></body>")))
        self.assertIsNone(self.reason(LEITH.replace("</p></body>", " Runs year-round.</p></body>")))

    def test_yearless_dates_and_published_dates_are_never_counted(self):
        text = "Festive Pub Quiz 27 Nov - 20 Dec 9.30pm. Take part in the finale showdown on 20th December. Published 3 March 2025"
        self.assertEqual(pc.explicit_dates(text), set())

    def test_uk_slash_dates_read_day_first(self):
        self.assertEqual(pc.explicit_dates("Sale ends 04/05/2026"), {date(2026, 5, 4)})


class CheckPageTests(unittest.TestCase):
    def check(self, resp, record=None):
        record = record or {"slug": "a", "title": "Pub Quiz", "source_url": "https://example.com/quiz", "venue_name": "Malones Leith"}
        return pc.check_page(record, lambda url: resp, TODAY)

    def test_404_and_410_are_gone(self):
        self.assertEqual(self.check(Resp(False, 404, reason="HTTP 404")).status, "gone")
        self.assertEqual(self.check(Resp(False, 410, reason="HTTP 410")).status, "gone")

    def test_a_block_a_timeout_robots_or_a_server_error_stay_unconfirmed(self):
        for resp in (Resp(False, 403, reason="blocked/challenged (HTTP 403)"), Resp(False, None, reason="request failed: ReadTimeout"),
                     Resp(False, None, reason="robots.txt disallows this page"), Resp(False, 500, reason="HTTP 500")):
            out = self.check(resp)
            self.assertEqual(out.status, "unconfirmed", resp.reason)
            self.assertTrue(out.reason)

    def test_a_loaded_page_is_ok_and_gives_a_short_excerpt_around_the_title(self):
        filler = "Lorem ipsum dolor sit amet. " * 400
        page = f"<html><body><p>{filler}</p><p>Pub Quiz at Malones Leith every Monday at 7pm, free to enter.</p><p>{filler}</p></body></html>"
        out = self.check(Resp(True, 200, page))
        self.assertEqual(out.status, "ok")
        self.assertIn("Pub Quiz at Malones Leith", out.excerpt)
        self.assertLessEqual(len(out.excerpt), pc.EXCERPT_CHARS)

    def test_a_lapsed_page_is_lapsed(self):
        self.assertEqual(self.check(Resp(True, 200, LEITH), {"slug": "l", "title": "Leith Laughs", "source_url": "https://e.com/l"}).status, "lapsed")

    def test_a_fetch_that_raises_is_unconfirmed_not_a_crash(self):
        def boom(url):
            raise RuntimeError("socket")

        out = pc.check_page({"slug": "a", "source_url": "https://example.com/x"}, boom, TODAY)
        self.assertEqual(out.status, "unconfirmed")

    def test_no_source_url_is_unconfirmed_without_a_request(self):
        calls = []
        out = pc.check_page({"slug": "a", "source_url": "javascript:alert(1)"}, lambda u: calls.append(u), TODAY)
        self.assertEqual(out.status, "unconfirmed")
        self.assertEqual(calls, [])

    def test_the_cap_counts_distinct_pages_and_rows_sharing_a_url_share_one_request(self):
        urls = []

        def get(url):
            urls.append(url)
            return Resp(True, 200, "<p>fine</p>")

        rows = [{"slug": f"s{i}", "title": "t", "source_url": "https://example.com/shared" if i < 3 else f"https://example.com/p{i}"} for i in range(8)]
        out, requested = pc.check_rows(rows, get, TODAY, cap=3)
        self.assertEqual(requested, 3)
        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(sorted(out), ["s0", "s1", "s2", "s3", "s4"])  # the 3 sharers, then 2 more pages; the rest not reached

    def test_markers(self):
        self.assertEqual(pc.marker(pc.PageCheck("ok"), TODAY), "page check: ok 2026-11-02")
        self.assertTrue(pc.marker(pc.PageCheck("unconfirmed", "HTTP 403"), TODAY).startswith("page check: unconfirmed (HTTP 403)"))
        self.assertTrue(pc.marker(None, TODAY).startswith("page check: not reached"))
        self.assertTrue(pc.marker(pc.PageCheck("gone", "HTTP 404"), TODAY).startswith("page check: gone"))

    def test_an_ok_marker_from_the_last_week_is_reused_and_an_old_or_unconfirmed_one_is_not(self):
        self.assertEqual(pc.check_from_reasons(["x", "page check: ok 2026-10-30"], TODAY).status, "ok")
        self.assertIsNone(pc.check_from_reasons(["page check: ok 2026-10-01"], TODAY))
        self.assertIsNone(pc.check_from_reasons(["page check: unconfirmed (HTTP 403)"], TODAY))


class ApplyChecksTests(unittest.TestCase):
    def routed(self, slug, route="digest", score=80):
        return quality.RoutedDeal({"slug": slug}, quality.QualityResult(score, ["base +20"]), route)

    def test_gone_and_lapsed_drop_the_rest_keep_their_route_with_a_marker(self):
        items = [self.routed(s) for s in ("gone", "lapsed", "ok", "blocked", "far")] + [self.routed("dropped", "drop")]
        checks = {"gone": pc.PageCheck("gone", "HTTP 404"), "lapsed": pc.PageCheck("lapsed", "series lapsed: x"), "ok": pc.PageCheck("ok"),
                  "blocked": pc.PageCheck("unconfirmed", "HTTP 403")}
        out = {i.record["slug"]: i for i in pc.apply_checks(items, checks, TODAY)}
        self.assertEqual({k: v.route for k, v in out.items()},
                         {"gone": "drop", "lapsed": "drop", "ok": "digest", "blocked": "digest", "far": "digest", "dropped": "drop"})
        self.assertTrue(out["gone"].result.reasons[-1].startswith("page check: gone"))
        self.assertTrue(out["lapsed"].result.reasons[-1].startswith("page check: lapsed"))
        self.assertEqual(out["ok"].result.reasons[-1], "page check: ok 2026-11-02")
        self.assertTrue(out["blocked"].result.reasons[-1].startswith("page check: unconfirmed"))
        self.assertTrue(out["far"].result.reasons[-1].startswith("page check: not reached"))
        self.assertEqual(out["dropped"].result.reasons, ["base +20"])  # a dropped row is left as it was
        self.assertEqual(items[0].route, "digest")  # inputs untouched


class RunRoutingPageCheckTests(unittest.TestCase):
    def rec(self, slug, **over):
        base = {"slug": slug, "title": f"£3 pints {slug}", "kind": "deal", "venue_name": f"Bar {slug}", "eligibility": "anyone",
                "recurrence": {"type": "weekly", "days": [2]}, "source_name": "S", "source_url": f"https://example.com/{slug}",
                "verified_at": "2026-11-02T11:00:00+00:00", "validation_errors": [], "extraction_status": "pending"}
        base.update(over)
        return base

    def route(self, records, get, rating=None, **kw):
        return dr.run_routing(records, make_rating_call=rating or (lambda: (_ for _ in ()).throw(RuntimeError("no rating"))),
                              verify=lambda r: [], in_rate=0.28, out_rate=0.42, rating_budget_usd=0.03, today=TODAY, now=NOW,
                              log=lambda _m: None, page_get=get, **kw)

    def test_new_digest_rows_are_looked_at_and_marked(self):
        pages = {"https://example.com/ok": Resp(True, 200, "<p>£3 pints ok</p>"), "https://example.com/gone": Resp(False, 404, reason="HTTP 404"),
                 "https://example.com/blocked": Resp(False, 403, reason="blocked/challenged (HTTP 403)")}
        out = self.route([self.rec("ok"), self.rec("gone"), self.rec("blocked")], lambda u: pages[u])
        by = {r.record["slug"]: r for r in out.final}
        self.assertEqual(by["gone"].route, "drop")
        self.assertTrue(any(x.startswith("page check: gone") for x in by["gone"].record["quality_reasons"]))
        self.assertEqual(by["ok"].route, "digest")
        self.assertIn("page check: ok 2026-11-02", by["ok"].record["quality_reasons"])
        self.assertTrue(any(x.startswith("page check: unconfirmed") for x in by["blocked"].record["quality_reasons"]))
        self.assertEqual(out.pages_requested, 3)

    def test_rows_over_the_cap_are_marked_not_reached(self):
        out = self.route([self.rec(f"r{i}", title=f"£3 pints {i}") for i in range(5)], lambda u: Resp(True, 200, "<p>fine</p>"), page_cap=2)
        marks = [next(x for x in r.record["quality_reasons"] if x.startswith("page check:")) for r in out.final]
        self.assertEqual(sum(m.startswith("page check: ok") for m in marks), 2)
        self.assertEqual(sum(m.startswith("page check: not reached") for m in marks), 3)

    def test_the_best_scores_are_the_ones_checked_first(self):
        seen = []
        rows = [self.rec("weak", title="10% off", saving_label="10% off"), self.rec("strong", title="50% off", saving_label="50% off")]
        self.route(rows, lambda u: seen.append(u) or Resp(True, 200, "<p>x</p>"), page_cap=1)
        self.assertEqual(seen, ["https://example.com/strong"])

    def test_a_lapsed_page_drops_the_row(self):
        out = self.route([self.rec("l", title="Leith Laughs", kind="deal", source_url="https://example.com/l")], lambda u: Resp(True, 200, LEITH))
        self.assertEqual(out.final[0].route, "drop")

    def test_the_page_excerpt_reaches_the_rating_prompt(self):
        prompts = []

        def rating():
            return lambda p: prompts.append(p) or quality.RatingResult([], input_tokens=1, output_tokens=1)

        self.route([self.rec("ok", title="Friday Sport")], lambda u: Resp(True, 200, "<p>Friday Sport is for children aged 10 to 15 only.</p>"), rating=rating)
        self.assertIn("page excerpt: Friday Sport is for children aged 10 to 15 only.", prompts[0])

    def test_without_a_page_getter_nothing_is_fetched_or_marked(self):
        out = dr.run_routing([self.rec("a")], make_rating_call=lambda: (_ for _ in ()).throw(RuntimeError("x")), verify=lambda r: [],
                             in_rate=0.28, out_rate=0.42, rating_budget_usd=0.03, today=TODAY, now=NOW, log=lambda _m: None)
        self.assertFalse(any(x.startswith("page check") for x in out.final[0].record["quality_reasons"]))


class RatingPromptTests(unittest.TestCase):
    ROW = {"slug": "friday-sport", "title": "Friday Sport at Peffermill", "kind": "activity", "venue_name": "Peffermill Playing Fields",
           "eligibility": "anyone", "summary": "Free weekly Friday sport for local children.",
           "eligibility_note": "Children aged between 10 to 15 years in Craigmillar.", "redemption_note": "Donation of £5 requested.",
           "time_note": "Fridays from 1pm", "page_excerpt": "The scheme provides school children with a free place to be active " + "x" * 2000}

    def test_the_prompt_carries_the_summary_the_notes_and_a_short_excerpt(self):
        prompt = quality.build_rating_prompt([self.ROW])
        for part in ("slug: friday-sport", "kind: activity", "summary: Free weekly Friday sport", "eligibility_note: Children aged between 10 to 15",
                     "redemption_note: Donation of £5", "time_note: Fridays from 1pm", "page excerpt: The scheme provides school children"):
            self.assertIn(part, prompt)
        excerpt = prompt.split("page excerpt: ")[1]
        self.assertLessEqual(len(excerpt), quality.RATING_EXCERPT_CHARS)

    def test_a_row_without_notes_or_an_excerpt_has_none_in_the_prompt(self):
        prompt = quality.build_rating_prompt([{"slug": "a", "title": "£3 pints"}])
        self.assertNotIn("summary", prompt)
        self.assertNotIn("page excerpt", prompt)

    def test_the_system_prompt_tells_the_model_narrow_groups_and_unstated_conditions_rate_at_most_two(self):
        text = quality.RATING_SYSTEM_PROMPT
        self.assertIn("at most 2", text)
        for word in ("children", "narrow group", "donation", "ticket"):
            self.assertIn(word, text)
        for venue in ("Peffermill", "Murrayfield", "Holyrood"):  # nothing is hard-coded to the rows that prompted it
            self.assertNotIn(venue, text)

    def test_deals_have_their_own_scale_and_non_deals_keep_the_go_out_of_your_way_one(self):
        text = quality.RATING_SYSTEM_PROMPT
        deals, rest = text.split("EVERYTHING ELSE")
        self.assertIn("DEALS (kind: deal)", deals)
        for phrase in ("5 = clearly cheap and useful", "everyday meal, drink, coffee, cinema trip or night out", "4 = a good saving", "modest price per person",
                       "4 also covers a voucher you pay for in advance when the price per person is £15 or less",
                       "20% or more off food, drink or a night out at a local independent place",
                       "3 = a real discount on something pricey: a voucher over £15 a head, a spa or hotel treat", "2 or less = a narrow group"):
            self.assertIn(phrase, deals)
        self.assertNotIn("go out of your way", deals)
        self.assertIn("worth going out of your way for", rest)
        self.assertIn("per-person price", text)
        self.assertIn("not the headline discount percentage", text)

    def test_the_kind_and_the_price_text_are_sent_with_each_row(self):
        prompt = quality.build_rating_prompt([{"slug": "a", "title": "Lunch and a drink", "kind": "deal", "price_text": "from £8.50", "saving_label": "£8.50 lunch"}])
        self.assertIn("kind: deal", prompt)
        self.assertIn("price_text: from £8.50", prompt)
        self.assertNotIn("Some Voucher Site", quality.build_rating_prompt([{"slug": "b", "title": "t", "source_name": "Some Voucher Site"}]))  # rate on price, not the source

    def test_the_prompt_reaches_the_model_unchanged_by_rate_relevance(self):
        seen = []
        quality.rate_relevance([self.ROW], lambda p: seen.append(p) or quality.RatingResult([{"slug": "friday-sport", "rating": 1}]))
        self.assertIn("eligibility_note", seen[0])

    def test_a_rating_can_only_lower_a_score(self):
        row = {"slug": "x", "title": "£3 pints", "kind": "deal", "venue_name": "Local Bar", "recurrence": {"type": "weekly", "days": [2]}, "eligibility": "anyone"}
        free = quality.score_deal(row)
        self.assertEqual(quality.score_deal(row, ai_rating=5).score, free.score)
        self.assertLess(quality.score_deal(row, ai_rating=2).score, free.score)


class NonDealCapTests(unittest.TestCase):
    def event(self, **over):
        row = {"slug": "quiz", "title": "Pub Quiz", "kind": "event", "venue_name": "Local Bar", "is_free": True, "eligibility": "anyone",
               "recurrence": {"type": "weekly", "days": [1]}, "extraction_status": "validated"}
        row.update(over)
        return row

    def test_a_free_event_with_no_rating_is_capped_below_publish(self):
        result = quality.score_deal(self.event())
        self.assertLessEqual(result.score, quality.PUBLISH_AT - 1)
        self.assertEqual(quality.route_deal(self.event(), result, source_class="web"), "digest")

    def test_a_free_event_needs_a_5_to_publish_and_a_4_is_capped(self):
        row = self.event()
        for rating in (None, 3, 4):
            self.assertLessEqual(quality.score_deal(row, ai_rating=rating).score, quality.NON_DEAL_CAP, rating)
        five = quality.score_deal(row, ai_rating=5)
        self.assertGreaterEqual(five.score, quality.PUBLISH_AT)
        self.assertEqual(quality.route_deal(row, five, source_class="web"), "publish")

    def test_a_low_rating_still_lowers_it_further(self):
        self.assertEqual(quality.score_deal(self.event(), ai_rating=2).score, 45)
        self.assertLessEqual(quality.score_deal(self.event(), ai_rating=3).score, 69)

    def test_the_cap_reason_says_why(self):
        # exactly at the cap before the rating cap: free 20 + base 20 + local 15 + audience 5 + evidence 10 = 70, so a 4 is capped to 69
        result = quality.score_deal(self.event(), ai_rating=4)
        self.assertEqual(result.score, quality.NON_DEAL_CAP)
        self.assertTrue(any(r.startswith("not a deal: capped at 69") and "no AI rating of 5" in r for r in result.reasons))

    def test_an_event_with_no_stated_price_is_capped_even_with_a_5(self):
        row = self.event(is_free=None, title="Gig night")
        result = quality.score_deal(row, ai_rating=5)
        self.assertLessEqual(result.score, quality.PUBLISH_AT - 1)

    def test_a_low_price_event_rated_5_has_a_smaller_value_and_does_not_reach_publish_alone(self):
        row = self.event(is_free=None, saving_label="£5 entry")
        result = quality.score_deal(row, ai_rating=5)
        self.assertIn(f"value: low price £5 +{quality.LOW_PRICE_VALUE}", result.reasons)
        self.assertEqual(quality.LOW_PRICE_VALUE, 15)
        self.assertEqual(quality.FREE_VALUE, 20)
        self.assertLess(result.score, quality.PUBLISH_AT)

    def test_deals_are_not_touched_and_the_thresholds_are_unchanged(self):
        deal = {"slug": "d", "title": "£3 cask pints", "kind": "deal", "venue_name": "Local Bar", "recurrence": {"type": "weekly", "days": [2]},
                "eligibility": "anyone", "extraction_status": "validated"}
        self.assertGreaterEqual(quality.score_deal(deal).score, quality.PUBLISH_AT)
        self.assertEqual((quality.PUBLISH_AT, quality.DROP_BELOW), (70, 40))

    def test_every_non_deal_kind_is_covered(self):
        for kind in quality.OTHER_KINDS:
            self.assertLessEqual(quality.score_deal(self.event(kind=kind)).score, quality.NON_DEAL_CAP, kind)

    def test_a_non_deal_gets_no_limited_days_bonus_but_a_deal_still_does(self):
        event = quality.score_deal(self.event(), ai_rating=5)
        self.assertFalse(any(r.startswith("limited days") for r in event.reasons))
        deal = quality.score_deal({"slug": "d", "title": "£3 cask pints", "kind": "deal", "venue_name": "Bar", "recurrence": {"type": "weekly", "days": [2]}})
        self.assertTrue(any(r.startswith("limited days") for r in deal.reasons))

    def test_the_rating_prompt_defines_5_as_worth_going_out_of_your_way_for_and_a_routine_night_as_3(self):
        text = quality.RATING_SYSTEM_PROMPT
        self.assertIn("worth going out of your way for", text)
        self.assertIn("A routine regular night is a 3", text)
        self.assertIn("Being free is not enough for a 5", text)
        self.assertNotIn("quiz", text.lower())
        self.assertNotIn("open mic", text.lower())


class WeeklyPatternTests(unittest.TestCase):
    LOUD = {"slug": "loud", "title": "Loud Poets Open Mic", "kind": "deal", "venue_name": "Storytelling Centre", "recurrence": {"type": "weekly", "days": [1]},
            "time_note": "Second and last Monday of each month; doors open 6:30pm", "saving_label": "£3 cask pints", "eligibility": "anyone", "extraction_status": "validated"}

    def test_the_wording_is_found_in_the_rows_own_text_or_quote(self):
        for phrase in ("second and last Monday of each month", "first Friday of the month", "every other week", "fortnightly", "monthly showcase",
                       "on the 1st & 3rd Thursday", "once a month", "alternate weekends"):
            self.assertIsNotNone(quality.different_pattern({"summary": f"Open mic {phrase} at the bar"}), phrase)
        self.assertIsNone(quality.different_pattern({"summary": "Every Monday at 7pm, free", "time_note": "Mondays"}))
        self.assertIsNotNone(quality.different_pattern({"_evidence": {"deal_quote": "Join us on the last Thursday of every month"}}))
        self.assertIsNotNone(quality.different_pattern({"page_excerpt": "takes place on the second and last Monday"}))

    def test_a_weekly_row_with_that_wording_earns_no_limited_days_bonus_and_cannot_publish(self):
        result = quality.score_deal(self.LOUD)
        self.assertFalse(any(r.startswith("limited days:") for r in result.reasons))
        self.assertTrue(any(r.startswith("limited days not counted") for r in result.reasons))
        plain = dict(self.LOUD, time_note="Every Monday, doors 6:30pm")
        self.assertGreater(quality.score_deal(plain).score, result.score)
        self.assertGreaterEqual(quality.score_deal(plain).score, quality.PUBLISH_AT)
        self.assertEqual(quality.route_deal(plain, quality.score_deal(plain), source_class="web"), "publish")
        res = quality.score_deal(self.LOUD)
        res.score = 95  # even a high score
        self.assertEqual(quality.route_deal(self.LOUD, res, source_class="web"), "digest")
        self.assertTrue(any(r.startswith("not every week") for r in res.reasons))

    def test_a_row_that_is_not_weekly_is_not_judged_by_this(self):
        row = dict(self.LOUD, recurrence={"type": "dates", "dates": ["2026-12-14"]})
        self.assertIsNone(quality.weekly_pattern_conflict(row))


class AnnualSeasonTests(unittest.TestCase):
    CARNIVAL = {"slug": "carnival", "title": "Edinburgh Festival Carnival 2026", "kind": "event", "recurrence": {"type": "annual", "month": 7, "day": 19},
                "venue_name": "Princes Street Gardens", "is_free": True, "extraction_status": "validated"}

    def test_an_annual_row_whose_date_this_year_has_passed_is_out_of_season(self):
        why = quality.annual_out_of_season(self.CARNIVAL, TODAY)
        self.assertIn("2027-07-19", why)

    def test_one_more_than_45_days_ahead_is_out_of_season_and_one_inside_45_days_is_not(self):
        row = lambda m, d: dict(self.CARNIVAL, recurrence={"type": "annual", "month": m, "day": d})
        self.assertIsNone(quality.annual_out_of_season(row(12, 16), TODAY))   # 44 days
        self.assertIsNone(quality.annual_out_of_season(row(12, 17), TODAY))   # 45 days
        self.assertIsNotNone(quality.annual_out_of_season(row(12, 18), TODAY))  # 46 days
        self.assertIsNone(quality.annual_out_of_season(row(11, 2), TODAY))    # today

    def test_other_recurrences_and_rows_without_a_date_are_never_judged(self):
        self.assertIsNone(quality.annual_out_of_season(dict(self.CARNIVAL, recurrence={"type": "weekly", "days": [1]}), TODAY))
        self.assertIsNone(quality.annual_out_of_season(dict(self.CARNIVAL, recurrence={"type": "annual"}), TODAY))
        self.assertIsNone(quality.annual_out_of_season(dict(self.CARNIVAL, recurrence=None), TODAY))

    def test_such_a_row_never_routes_publish(self):
        res = quality.score_deal(self.CARNIVAL, ai_rating=5)
        res.score = 95
        self.assertEqual(quality.route_deal(self.CARNIVAL, res, source_class="web", today=TODAY), "digest")
        self.assertTrue(any(r.startswith("out of season") for r in res.reasons))


class DailyNonDealLimitTests(unittest.TestCase):
    def item(self, slug, kind, score, venue=None, source="S"):
        return quality.RoutedDeal({"slug": slug, "kind": kind, "venue_name": venue or f"V {slug}", "source_name": source},
                                  quality.QualityResult(score, []), "publish")

    def test_at_most_three_non_deals_in_the_day(self):
        items = [self.item(f"e{i}", "event", 90 - i, source=f"S{i}") for i in range(5)] + [self.item("d", "deal", 70)]
        out = quality.apply_daily_limit(items, 10)
        self.assertEqual([r.route for r in out], ["publish"] * 3 + ["digest", "digest", "publish"])
        self.assertIn("non-deal limit of 3", out[3].result.reasons[-1])

    def test_non_deals_already_published_today_count(self):
        out = quality.apply_daily_limit([self.item("e", "event", 90), self.item("d", "deal", 70)], 10, already_non_deal=3)
        self.assertEqual([r.route for r in out], ["digest", "publish"])

    def test_a_deal_beats_a_non_deal_on_a_tie_for_the_last_slot(self):
        out = quality.apply_daily_limit([self.item("e", "event", 80), self.item("d", "deal", 80)], 1)
        self.assertEqual([r.route for r in out], ["digest", "publish"])

    def test_waiting_rows_come_after_this_runs_rows_even_with_a_higher_score(self):
        new = self.item("new", "deal", 71)
        waiting = self.item("old", "deal", 99)
        waiting.record["_backlog"] = True
        out = quality.apply_daily_limit([waiting, new], 1)
        self.assertEqual([r.route for r in out], ["digest", "publish"])


class LiveDuplicateTests(unittest.TestCase):
    LIVE = [
        {"id": "1", "slug": "resident-rewards-exclusiveoffers-holyrood-distillery-free-guided-tour", "title": "Holyrood Distillery free guided tour",
         "kind": "free_access", "status": "live", "venue_name": "Holyrood Distillery", "place_id": "1b84adfb-ba1c-45f5-994f-88b077480f13",
         "source_url": "https://edinburgh.org/residentrewards/exclusiveoffers/", "saving_label": "Free fully guided distillery tour", "recurrence": {"type": "always"}},
        {"id": "2", "slug": "holyrood-distillery-tour-concession-rate", "title": "Holyrood Distillery tour concession rate £22.00", "kind": "deal",
         "status": "live", "venue_name": "Holyrood Distillery", "place_id": "1b84adfb-ba1c-45f5-994f-88b077480f13", "saving_label": "concession rate of £22.00",
         "recurrence": {"type": "always"}},
        {"id": "3", "slug": "dormant-one", "title": "Cask pints at Nobles", "kind": "deal", "status": "dormant", "venue_name": "Nobles", "recurrence": {"type": "always"}},
    ]
    STAGED = {"id": "x", "slug": "venue-holyrood-distillery-free-resident-tour", "title": "Holyrood Distillery free tour for EH residents", "kind": "tour",
              "venue_name": "Holyrood Distillery", "saving_label": "free distillery tour", "recurrence": {"type": "weekly", "days": [0]},
              "source_url": "https://edinburgh.org/residentrewards/exclusiveoffers/holyrood-distillery-free-tour/"}

    def test_the_holyrood_pair_is_one_offer(self):
        sure, maybe = sb.find_live_duplicates([self.STAGED], Catalogue(self.LIVE, []))
        self.assertEqual(sure, {self.STAGED["slug"]: "resident-rewards-exclusiveoffers-holyrood-distillery-free-guided-tour"})
        self.assertEqual(maybe, {})

    def test_it_drops_with_the_reason_already_live_as_the_slug(self):
        routed = sb.score_rows([self.STAGED], {}, today=TODAY, now=NOW)
        sure, maybe = sb.find_live_duplicates([self.STAGED], Catalogue(self.LIVE, []))
        out = sb.apply_duplicates(routed, sure, maybe)[0]
        self.assertEqual(out.route, "drop")
        self.assertEqual(out.result.reasons[-1], "already live as resident-rewards-exclusiveoffers-holyrood-distillery-free-guided-tour")

    def test_a_different_offer_at_the_same_venue_is_not_a_duplicate(self):
        tasting = dict(self.STAGED, slug="holyrood-whisky-tasting", title="Holyrood Distillery whisky tasting masterclass", saving_label=None)
        sure, _ = sb.find_live_duplicates([tasting], Catalogue(self.LIVE, []))
        self.assertEqual(sure, {})

    def test_a_dormant_row_is_not_a_live_duplicate(self):
        nobles = {"id": "n", "slug": "nobles-cask", "title": "Cask pints at Nobles", "kind": "deal", "venue_name": "Nobles", "recurrence": {"type": "always"}}
        sure, maybe = sb.find_live_duplicates([nobles], Catalogue(self.LIVE, []))
        self.assertEqual((sure, maybe), ({}, {}))

    def test_a_possible_match_is_noted_and_stays_in_the_digest(self):
        routed = sb.score_rows([self.STAGED], {}, today=TODAY, now=NOW)
        out = sb.apply_duplicates(routed, {}, {self.STAGED["slug"]: "some-live-slug"})[0]
        self.assertEqual(out.route, routed[0].route)
        self.assertEqual(out.result.reasons[-1], "possible duplicate of live some-live-slug")


def backlog_row(slug, **over):
    base = {"id": f"id-{slug}", "slug": slug, "batch_id": "b1", "created_at": "2026-10-26T12:00:00+00:00", "title": f"£3 cask pints {slug}", "kind": "deal",
            "venue_name": f"Bar {slug}", "eligibility": "anyone", "recurrence": {"type": "weekly", "days": [2]}, "source_name": "S",
            "source_url": f"https://example.com/{slug}", "extraction_status": "validated", "validation_errors": [], "approved": False,
            "verified_at": "2026-10-26T12:00:00+00:00"}
    base.update(over)
    return base


class BacklogFlowTests(unittest.TestCase):
    def run_main(self, waiting, pages, extra=(), rating=None, live=()):
        written = []
        notes = {"staged_raw": len(waiting), "after_dedupe": len(waiting), "excluded_already_live": 0, "approved_null": 0}
        requested = []

        def get(url):
            requested.append(url)
            return pages.get(url, Resp(True, 200, "<p>fine</p>"))

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(sb, "load_waiting", return_value=(waiting, notes, ("http://x", "k"))), \
                mock.patch.object(sb, "load_live_catalogue", return_value=(Catalogue(list(live), []), len(live))), \
                mock.patch.object(pc, "make_fetcher", return_value=get), \
                mock.patch.object(sb, "make_patch", return_value=lambda row_id, body: written.append((row_id, body))), \
                mock.patch.object(sys, "argv", ["score_backlog.py", *extra, "--out-dir", tmp]), \
                redirect_stdout(io.StringIO()) as out:
            sb.main()
            rows = json.loads((Path(tmp) / "rows.json").read_text())
            report = (Path(tmp) / "report.md").read_text()
        return {r["slug"]: r for r in rows}, written, requested, report

    def test_gone_lapsed_and_blocked_pages_are_routed_and_marked(self):
        waiting = [backlog_row("ok"), backlog_row("gone"), backlog_row("lapsed", title="Leith Laughs", recurrence={"type": "weekly", "days": [0, 6]}),
                   backlog_row("blocked")]
        pages = {"https://example.com/gone": Resp(False, 404, reason="HTTP 404"), "https://example.com/lapsed": Resp(True, 200, LEITH),
                 "https://example.com/blocked": Resp(False, 403, reason="blocked/challenged (HTTP 403)")}
        rows, written, requested, report = self.run_main(waiting, pages, ["--no-ai"])
        self.assertEqual({s: r["route"] for s, r in rows.items()}, {"ok": "publish", "gone": "drop", "lapsed": "drop", "blocked": "digest"})  # ok is a publish candidate; a blocked page cannot be
        self.assertIn("page check: ok 2026-11-02"[:14], " ".join(rows["ok"]["reasons"]))
        self.assertTrue(any(x.startswith("page check: unconfirmed") for x in rows["blocked"]["reasons"]))
        self.assertEqual(len(requested), 4)
        self.assertEqual(written, [])  # a dry run writes nothing
        self.assertIn("Source pages: 4 requested", report)

    def test_the_cap_limits_requests_best_score_first_and_the_rest_are_marked_not_reached(self):
        waiting = [backlog_row(f"r{i}", title=f"{10 + i * 10}% off", saving_label=f"{10 + i * 10}% off") for i in range(5)]
        rows, _, requested, report = self.run_main(waiting, {}, ["--no-ai", "--page-cap", "2"])
        self.assertEqual(sorted(requested), ["https://example.com/r3", "https://example.com/r4"])
        reached = [s for s, r in rows.items() if any(x.startswith("page check: ok") for x in r["reasons"])]
        self.assertEqual(sorted(reached), ["r3", "r4"])
        self.assertEqual(sum(any(x.startswith("page check: not reached") for x in r["reasons"]) for r in rows.values()), 3)
        self.assertIn("cap 2", report)

    def test_a_live_duplicate_drops_and_is_not_fetched(self):
        live = [{"id": "L", "slug": "live-pints", "title": "£3 cask pints dup", "kind": "deal", "status": "live", "venue_name": "Bar dup", "recurrence": {"type": "weekly", "days": [2]}}]
        waiting = [backlog_row("dup")]
        rows, _, requested, _ = self.run_main(waiting, {}, ["--no-ai"], live=live)
        self.assertEqual(rows["dup"]["route"], "drop")
        self.assertIn("already live as live-pints", rows["dup"]["reasons"])
        self.assertEqual(requested, [])

    def test_the_apply_writes_the_three_columns_with_the_markers_and_nothing_else(self):
        _, written, _, _ = self.run_main([backlog_row("a")], {}, ["--no-ai", "--apply"])
        self.assertEqual(len(written), 1)
        row_id, body = written[0]
        self.assertEqual(row_id, "id-a")
        self.assertEqual(set(body), {"quality_score", "quality_reasons", "quality_route"})
        self.assertTrue(any(x.startswith("page check: ok") for x in body["quality_reasons"]))

    def test_pages_seen_today_are_not_fetched_again_on_the_apply_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "page-checks.json"
            get1 = mock.Mock(return_value=Resp(True, 200, "<p>fine</p>"))
            rows = [backlog_row("a")]
            checks, n, reused = sb.check_pages(rows, TODAY, get=get1, cache_path=cache, cap=10)
            self.assertEqual((n, reused), (1, 0))
            get2 = mock.Mock(return_value=Resp(True, 200, "<p>fine</p>"))
            checks2, n2, reused2 = sb.check_pages(rows, TODAY, get=get2, cache_path=cache, cap=10)
            get2.assert_not_called()
            self.assertEqual((n2, reused2, checks2["a"].status), (0, 1, "ok"))
            # a cache from another day is ignored
            get3 = mock.Mock(return_value=Resp(True, 200, "<p>fine</p>"))
            sb.check_pages(rows, date(2026, 11, 3), get=get3, cache_path=cache, cap=10)
            get3.assert_called_once()

    def test_a_row_with_a_recent_ok_marker_is_not_fetched_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            get = mock.Mock()
            rows = [backlog_row("a", quality_reasons=["page check: ok 2026-11-01"])]
            checks, n, reused = sb.check_pages(rows, TODAY, get=get, cache_path=Path(tmp) / "c.json", cap=10)
            get.assert_not_called()
            self.assertEqual((n, reused, checks["a"].status), (0, 1, "ok"))

    def test_offline_makes_no_request(self):
        rows, _, requested, _ = self.run_main([backlog_row("a")], {}, ["--no-ai", "--offline"])
        self.assertEqual(requested, [])
        self.assertFalse(any(x.startswith("page check") for x in rows["a"]["reasons"]))

    def test_the_rating_prompt_for_a_checked_row_has_the_excerpt_and_a_gone_row_is_not_rated(self):
        prompts = []

        def make_call():
            return lambda p: prompts.append(p) or quality.RatingResult([], input_tokens=1, output_tokens=1)

        waiting = [backlog_row("ok", title="Friday Sport"), backlog_row("gone")]
        pages = {"https://example.com/ok": Resp(True, 200, "<p>Friday Sport is for children aged 10 to 15.</p>"), "https://example.com/gone": Resp(False, 404, reason="HTTP 404")}
        notes = {"staged_raw": 2, "after_dedupe": 2, "excluded_already_live": 0, "approved_null": 0}
        fake_llm = mock.Mock()
        fake_llm.research_provider.return_value = "deepseek"
        fake_llm.make_research_client.return_value = (object(), None)
        fake_llm.default_research_model.return_value = "m"
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(sb, "load_waiting", return_value=(waiting, notes, ("http://x", "k"))), \
                mock.patch.object(sb, "load_live_catalogue", return_value=(Catalogue([], []), 0)), \
                mock.patch.object(pc, "make_fetcher", return_value=lambda u: pages[u]), \
                mock.patch.dict(sys.modules, {"llm_client": fake_llm}), \
                mock.patch.object(quality, "make_rating_call", return_value=lambda p: prompts.append(p) or quality.RatingResult([], input_tokens=1, output_tokens=1)), \
                mock.patch.object(sys, "argv", ["score_backlog.py", "--refresh-ai", "--out-dir", tmp]), \
                redirect_stdout(io.StringIO()):
            sb.main()
        self.assertEqual(len(prompts), 1)
        self.assertIn("page excerpt: Friday Sport is for children aged 10 to 15.", prompts[0])
        self.assertNotIn("slug: gone", prompts[0])


if __name__ == "__main__":
    unittest.main()
