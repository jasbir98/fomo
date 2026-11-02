"""Tests for the families-lens supply: kids' deal sources, evergreen discovery, family
research topics, school holidays and the Bookbug collection.

Run: python3 -m pytest scraper/test_family_supply.py   (no network, no API key)
"""

from __future__ import annotations

import re
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import happenings_research as hr  # noqa: E402
import school_holidays  # noqa: E402
import weekly_edinburgh as weekly  # noqa: E402
from deal_sources import gate  # noqa: E402
from deal_sources.discover import discover  # noqa: E402
from deal_sources.fetch import Response  # noqa: E402
from deal_sources.registry import SOURCES, DealSource  # noqa: E402
from happenings.cities.edinburgh import EDINBURGH  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "deal_sources" / "fixtures"
TODAY = date(2026, 10, 20)
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
BY_ID = {s.id: s for s in SOURCES}


class KidsSourceRegistryTests(unittest.TestCase):
    def test_new_kids_sources_are_shadow_national_with_a_venue(self):
        expected = {
            "scotrail-kids-for-a-quid": ("official", "Edinburgh Waverley station", "https://www.scotrail.co.uk/kids-for-a-quid"),
            "cineworld-family-films": ("commercial", "Cineworld Edinburgh (Fountain Park)", "https://www.cineworld.co.uk/family/"),
            "picturehouse-kids-club": ("commercial", "Cameo Picturehouse", "https://www.picturehouses.com/kids-club"),
        }
        for sid, (trust, venue, url) in expected.items():
            src = BY_ID[sid]
            self.assertEqual(src.status, "shadow", sid)
            self.assertEqual(src.trust, trust, sid)
            self.assertTrue(src.national_ok, sid)
            self.assertEqual(src.national_venue, venue, sid)
            self.assertEqual(src.discover, {"kind": "urls", "urls": [url]}, sid)
            self.assertIn("'family'", src.extract_hints, sid)
            self.assertIn("'kids'", src.extract_hints, sid)
            self.assertNotIn("booking_url", src.extract_hints.replace("Leave booking_url out", ""), sid)

    def test_blocked_chains_are_not_deal_sources(self):
        urls = " ".join(u for s in SOURCES for u in s.discover.get("urls", []))
        for host in ("odeon.co.uk", "myvue.com", "asda.com", "morrisons.com"):
            self.assertNotIn(host, urls)

    def test_existing_hints_carry_the_family_rules(self):
        self.assertIn("'family'", BY_ID["edinburgh-leisure-offers"].extract_hints)
        self.assertNotIn("under-5s, or a disability group", BY_ID["edinburgh-leisure-offers"].extract_hints)
        self.assertIn("disability group", BY_ID["edinburgh-leisure-offers"].extract_hints)
        self.assertIn("'family'", BY_ID["fort-kinnaird-offers"].extract_hints)
        self.assertIn("Kids Eat Free", BY_ID["fort-kinnaird-offers"].extract_hints)
        self.assertIn("'family'", BY_ID["forever-edinburgh-offers"].extract_hints)
        rr = BY_ID["resident-rewards"]
        self.assertIn("'local_resident'", rr.extract_hints)
        self.assertIn("World Children's Day", rr.extract_hints)
        self.assertEqual(rr.default_eligibility, "local_resident")

    def test_national_ok_without_a_venue_is_still_refused(self):
        with self.assertRaises(ValueError):
            DealSource("x", "x", "commercial", "shadow", {"kind": "urls", "urls": []}, national_ok=True)


class EvergreenLeisureDiscoveryTests(unittest.TestCase):
    class FakeSitemaps:
        def __init__(self, xml):
            self.xml = xml

        def get(self, url, accept="", expect_json=False):
            if url.endswith("page-sitemap.xml"):
                return Response(True, url, text=self.xml, headers={})
            return Response(False, url, reason="HTTP 404")

    def urls(self):
        xml = (FIXTURES / "edinburgh-leisure-sitemap.xml").read_text()
        refs, _notes = discover(BY_ID["edinburgh-leisure-offers"], self.FakeSitemaps(xml), NOW)
        return [r.url for r in refs]

    def test_children_pages_are_read_even_when_not_edited_in_90_days(self):
        urls = self.urls()
        base = "https://www.edinburghleisure.co.uk/"
        for slug in ("clambers-soft-play/", "tumbles-soft-play/", "scrambles-soft-play/", "holiday-activities/",
                     "holiday-camps/", "family-days-out-in-edinburgh/",
                     "tiny-tasters-big-adventures-edinburgh-leisures-play-try-week-for-under-5s/"):
            self.assertIn(base + slug, urls, slug)

    def test_the_old_window_and_patterns_still_apply_to_everything_else(self):
        urls = self.urls()
        self.assertIn("https://www.edinburghleisure.co.uk/swim-offer-autumn/", urls)
        self.assertNotIn("https://www.edinburghleisure.co.uk/old-offer-2024/", urls)  # stale and not evergreen
        self.assertNotIn("https://www.edinburghleisure.co.uk/freedom-of-information/", urls)
        self.assertNotIn("https://www.edinburghleisure.co.uk/climbing-holiday-camps-terms-and-conditions/", urls)

    def test_always_pattern_is_optional_for_other_sitemap_sources(self):
        src = DealSource("s", "s", "official", "shadow", {
            "kind": "sitemap", "urls": ["https://www.edinburghleisure.co.uk/page-sitemap.xml"],
            "pattern": r"soft-play|offer", "modified_within_days": 90})
        xml = (FIXTURES / "edinburgh-leisure-sitemap.xml").read_text()
        refs, _ = discover(src, self.FakeSitemaps(xml), NOW)
        got = [r.url for r in refs]
        self.assertIn("https://www.edinburghleisure.co.uk/clambers-soft-play/", got)
        self.assertNotIn("https://www.edinburghleisure.co.uk/scrambles-soft-play/", got)  # 2025 lastmod, no exemption


class LeisureGateFixtureTests(unittest.TestCase):
    """An Edinburgh Leisure 'children under 5 swim free' page, with a mocked LLM answer."""

    TEXT = (FIXTURES / "edinburgh-leisure-under5-swim.txt").read_text()

    def item(self, **over):
        item = {
            "title": "Under-5s swim free at Edinburgh Leisure pools", "kind": "deal", "category": "family",
            "family_fit": "kids",
            "quote": "Children under 5 swim for free at Edinburgh Leisure pools when they come with a paying adult.",
            "fields": {
                "saving_label": {"value": "Under-5s swim free", "quote": "Children under 5 swim for free"},
                "is_free": {"value": True, "quote": "swim for free"},
                "eligibility": {"value": "family", "quote": "Children under 5 swim for free at Edinburgh Leisure pools when they come with a paying adult."},
                "ends_at": {"value": "2026-12-31", "quote": "until 31 December 2026"},
                "venue_name": {"value": "Warrender Baths", "quote": "Warrender Baths"},
                "address": {"value": "55 Thirlestane Road, Edinburgh EH9 1AP", "quote": "55 Thirlestane Road, Edinburgh EH9 1AP"},
            },
        }
        item.update(over)
        return item

    def page(self):
        return gate.PageContext(url="https://www.edinburghleisure.co.uk/under-5s-swim/", text=self.TEXT, single_deal=True)

    def test_under_5s_swim_is_accepted_as_family_not_dropped(self):
        r = gate.gate_deal(self.item(), self.page(), today=TODAY, edinburgh_source=True)
        self.assertTrue(r.ok, r.detail)
        self.assertEqual(r.fields["eligibility"], "family")
        raw = gate.to_raw_happening(self.item(), r, source_name="Edinburgh Leisure", page_url="https://www.edinburghleisure.co.uk/under-5s-swim/")
        self.assertEqual(raw["family_fit"], "kids")
        self.assertEqual(raw["eligibility"], "family")
        record = hr.build_full_record(raw, "batch", EDINBURGH, "deal-source", "model", "2026-10-20T00:00:00+00:00")
        self.assertIsNotNone(record)
        self.assertEqual(record["eligibility"], "family")
        self.assertEqual(record["family_fit"], "kids")

    def test_family_claim_needs_a_quote_on_the_page(self):
        item = self.item()
        item["fields"]["eligibility"] = {"value": "family", "quote": "Children of any age swim for free"}
        r = gate.gate_deal(item, self.page(), today=TODAY, edinburgh_source=True)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "eligibility_unsupported")


class SchoolHolidayTests(unittest.TestCase):
    def test_window_is_inclusive_and_opens_21_days_before(self):
        xmas = school_holidays.HOLIDAYS[1]
        self.assertEqual((xmas.start, xmas.end), (date(2026, 12, 21), date(2027, 1, 5)))
        self.assertIsNone(school_holidays.upcoming_holiday(date(2026, 11, 29)))
        self.assertEqual(school_holidays.upcoming_holiday(date(2026, 11, 30)), xmas)  # start - 21 days
        self.assertEqual(school_holidays.upcoming_holiday(date(2026, 12, 21)), xmas)
        self.assertEqual(school_holidays.upcoming_holiday(date(2027, 1, 5)), xmas)  # last day
        self.assertIsNone(school_holidays.upcoming_holiday(date(2027, 1, 6)))

    def test_lead_days_is_a_parameter(self):
        self.assertIsNone(school_holidays.upcoming_holiday(date(2026, 12, 10), lead_days=7))
        self.assertIsNotNone(school_holidays.upcoming_holiday(date(2026, 12, 14), lead_days=7))

    def test_during_the_october_break_it_is_the_current_holiday(self):
        h = school_holidays.upcoming_holiday(date(2026, 10, 12))
        self.assertEqual(h.label, "October 2026")
        self.assertEqual(school_holidays.upcoming_holiday(date(2026, 10, 19)), h)
        self.assertIsNone(school_holidays.upcoming_holiday(date(2026, 10, 20)))

    def test_list_is_sorted_non_overlapping_and_summer_2027_is_right(self):
        hs = school_holidays.HOLIDAYS
        for a, b in zip(hs, hs[1:]):
            self.assertLess(a.end, b.start)
        summer = next(h for h in hs if h.label == "Summer 2027")
        self.assertEqual((summer.start, summer.end), (date(2027, 6, 30), date(2027, 8, 17)))

    def test_date_range_text(self):
        self.assertEqual(school_holidays.HOLIDAYS[1].date_range, "21 Dec 2026 – 5 Jan 2027")

    def test_stale_list_warns(self):
        with self.assertLogs("school_holidays", level="WARNING"):
            self.assertTrue(school_holidays.warn_if_stale(date(2028, 5, 1)))
        self.assertFalse(school_holidays.warn_if_stale(date(2026, 10, 20)))


class FamilyTopicTests(unittest.TestCase):
    def names(self, today):
        return [t.name for t in weekly.topics_for(today)]

    def test_holiday_topics_appear_only_inside_the_window(self):
        in_window = weekly.topics_for(date(2026, 12, 5))
        holiday = [t for t in in_window if "holidays (" in t.name]
        self.assertEqual(len(holiday), 2)
        by_kind = {t.mode: t for t in holiday}
        self.assertEqual(by_kind["offers"].priority, 90)
        self.assertEqual(by_kind["calendar"].priority, 89)
        self.assertEqual(by_kind["offers"].name,
                         "Kids eat free and kids go free in Edinburgh over the Christmas holidays (21 Dec 2026 – 5 Jan 2027)")
        self.assertTrue(by_kind["calendar"].name.startswith("Edinburgh children's activities over the Christmas holidays"))
        self.assertEqual(by_kind["offers"].seeds, ("edinburgh.org", "fortkinnaird.com", "edinburghleisure.co.uk"))
        self.assertTrue(all(t.family for t in holiday))
        self.assertFalse([n for n in self.names(date(2026, 11, 20)) if "holidays (" in n])
        self.assertEqual(len(self.names(date(2026, 11, 20))), len(weekly.TOPICS))

    def test_seven_static_family_topics_replace_the_old_one(self):
        names = [t.name for t in weekly.TOPICS]
        self.assertNotIn("family activities", names)
        family = [t for t in weekly.TOPICS if t.family]
        self.assertEqual([t.priority for t in family], [84, 83, 82, 81, 80, 79, 78])
        self.assertEqual(len(family), 7)
        self.assertEqual(len(names), len(set(names)))

    def test_family_topics_rank_well_inside_a_normal_run(self):
        ordered = sorted(weekly.topics_for(date(2026, 10, 20)), key=lambda t: -t.priority)
        last_family = max(i for i, t in enumerate(ordered, 1) if t.family)
        # 4 deal-source-capped $0.50 + topics reserve $0.09: all of the first 40 fit while
        # the average topic costs under ~$0.055 (the 27 Sep run averaged ~$0.015).
        self.assertLessEqual(last_family, 40)
        self.assertTrue(all(t.priority > 75 for t in ordered if t.family and "holidays (" not in t.name))

    def test_prompt_carries_family_rules_only_for_family_topics(self):
        family = next(t for t in weekly.TOPICS if t.family)
        other = next(t for t in weekly.TOPICS if not t.family)
        self.assertIn("paid children's classes", weekly.topic_system_prompt(family))
        self.assertIn("private parties", weekly.topic_system_prompt(family))
        self.assertNotIn("paid children's classes", weekly.topic_system_prompt(other))
        self.assertIn("family_fit", weekly.topic_system_prompt(other))

    def test_seed_format_matches_existing_topics(self):
        for t in weekly.TOPICS:
            for seed in t.seeds:
                self.assertRegex(seed, r"^[a-z0-9.-]+\.[a-z]+(/[a-z0-9/_-]*)?$", t.name)


class CollectionTests(unittest.TestCase):
    def rec(self, title, url, **over):
        base = {"title": title, "slug": re.sub(r"\W+", "-", title.lower()), "source_url": url, "source_urls": [url],
                "recurrence": {"type": "weekly", "days": [3]}, "category": "family", "family_fit": "kids"}
        base.update(over)
        return base

    def test_bookbug_sessions_collapse_into_one_kids_card_and_keep_every_page(self):
        records = [
            self.rec("Bookbug at Central Library", "https://edinburgh.gov.uk/libraries/central"),
            self.rec("Bookbug at Morningside Library", "https://edinburgh.gov.uk/libraries/morningside"),
            self.rec("Bookbug at Leith Library", "https://edinburgh.gov.uk/libraries/leith"),
            self.rec("Edinburgh Zoo kids go free", "https://edinburghzoo.org.uk/offer", category="family"),
        ]
        out = weekly.group_same_activity_collections(records)
        self.assertEqual(len(out), 2)
        card = next(r for r in out if r["slug"] == "bookbug-at-edinburgh-libraries")
        self.assertEqual(card["title"], "Bookbug at Edinburgh libraries")
        self.assertEqual(card["category"], "family")
        self.assertEqual(card["family_fit"], "kids")
        self.assertTrue(card["is_free"])
        self.assertEqual(card["saving_label"], "Free")
        self.assertEqual(card["scope"], "city")
        self.assertIn("ages 0 to 4", card["summary"])
        self.assertEqual(card["recurrence"], {"type": "weekly", "days": [3]})  # all members agree
        self.assertEqual([m["source_url"] for m in card["_collection_members"]], [
            "https://edinburgh.gov.uk/libraries/central", "https://edinburgh.gov.uk/libraries/morningside",
            "https://edinburgh.gov.uk/libraries/leith"])
        self.assertEqual(len(card["source_urls"]), 3)
        self.assertIsNone(card["venue_name"])
        self.assertTrue(any(r["title"] == "Edinburgh Zoo kids go free" for r in out))

    def test_bookbug_with_differing_days_gets_always_recurrence(self):
        out = weekly.group_same_activity_collections([
            self.rec("Bookbug at Central Library", "https://x/1"),
            self.rec("Bookbug at Leith Library", "https://x/2", recurrence={"type": "weekly", "days": [5]}),
        ])
        self.assertEqual(out[0]["recurrence"], {"type": "always"})

    def test_single_bookbug_is_left_alone(self):
        records = [self.rec("Bookbug at Central Library", "https://x/1")]
        self.assertEqual(weekly.group_same_activity_collections(records), records)

    def test_parkrun_collection_is_all_ages_whatever_the_first_instance_said(self):
        out = weekly.group_same_activity_collections([
            self.rec("Cramond parkrun", "https://parkrun/cramond", category="wellness", family_fit="kids"),
            self.rec("Holyrood parkrun", "https://parkrun/holyrood", category="wellness", family_fit=None),
        ])
        card = next(r for r in out if r["slug"] == "edinburgh-parkruns")
        self.assertEqual(card["family_fit"], "all_ages")
        self.assertEqual(card["category"], "wellness")

    def test_both_families_group_in_one_pass_and_regrouping_is_stable(self):
        records = [
            self.rec("Cramond parkrun", "https://p/1", category="wellness"),
            self.rec("Holyrood parkrun", "https://p/2", category="wellness"),
            self.rec("Bookbug at A", "https://b/1"), self.rec("Bookbug at B", "https://b/2"),
        ]
        out = weekly.group_same_activity_collections(records)
        self.assertEqual(sorted(r["slug"] for r in out), ["bookbug-at-edinburgh-libraries", "edinburgh-parkruns"])
        again = weekly.group_same_activity_collections(out)
        self.assertEqual(sorted(r["slug"] for r in again), ["bookbug-at-edinburgh-libraries", "edinburgh-parkruns"])


if __name__ == "__main__":
    unittest.main()
