"""Unit tests for scraper/deal_sources (gate, ledger hashing, discover parsing, runner wiring).

Run: python3 scraper/test_deal_sources.py   (stdlib unittest, no network, no API key)
"""

from __future__ import annotations

import json
import sys
import unittest
from unittest import mock
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from deal_sources import gate, quality  # noqa: E402
from deal_sources.discover import discover, parse_sitemap_entries, parse_sitemap_locs, parse_wp_items, filter_urls  # noqa: E402
from deal_sources.annual import Annual, annual_sources, in_window, load_annual, window_for  # noqa: E402
from deal_sources.fetch import Response  # noqa: E402
from deal_sources.extract import ExtractResult  # noqa: E402
from deal_sources.ledger import Ledger, table_missing  # noqa: E402
from deal_sources.registry import SOURCES, DealSource, get_sources  # noqa: E402
from deal_sources.runner import run_deal_sources  # noqa: E402
from deal_sources.textutil import split_blocks, content_hash, html_to_text, og_image, split_chunks, normalise_for_hash  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "deal_sources" / "fixtures"
TODAY = date(2026, 10, 8)
NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)

PAGE_HTML = """
<p>Malones Leith Irish Boozy Brunch is the perfect way to kick off your weekend.</p>
<h2>Offer</h2>
<p>Available the last Friday of September, October, and November 2026, <strong>enjoy a large brunch plate and 5 drinks from the brunch menu for £35.00 per person.</strong></p>
<ul><li>This offer is available from <strong>11am to 5pm on 25 September, 30 October and 27 November 2026 only.</strong></li>
<li>Use code BOOZY20 for 20% off. Malones, 14 Commercial Street, Edinburgh EH6 6EL.</li></ul>
<a href="https://www.malonesleith.com/irish-boozy-brunch/">Book</a>
"""
PAGE_TEXT = "Malones Leith Irish Boozy Brunch\n" + html_to_text(PAGE_HTML)
LINKS = {"https://www.malonesleith.com/irish-boozy-brunch/"}


def page(single=True, text=PAGE_TEXT):
    return gate.PageContext(url="https://edinburgh.org/x/", text=text, links=set(LINKS), single_deal=single)


def deal(**over):
    base = {
        "title": "Irish boozy brunch at Malones Leith",
        "kind": "deal",
        "category": "food",
        "quote": "enjoy a large brunch plate and 5 drinks from the brunch menu for £35.00 per person.",
        "fields": {
            "saving_label": {"value": "20% off", "quote": "Use code BOOZY20 for 20% off"},
            "price_text": {"value": "£35.00 per person", "quote": "for £35.00 per person"},
            "recurrence": {"value": {"type": "dates", "dates": ["2026-09-25", "2026-10-30", "2026-11-27"]},
                           "quote": "11am to 5pm on 25 September, 30 October and 27 November 2026 only."},
            "venue_name": {"value": "Malones Leith", "quote": "Malones Leith Irish Boozy Brunch"},
            "address": {"value": "14 Commercial Street, Edinburgh EH6 6EL", "quote": "14 Commercial Street, Edinburgh EH6 6EL"},
        },
    }
    base.update(over)
    return base


def run_gate(item, **kw):
    return gate.gate_deal(item, kw.pop("page", page()), today=kw.pop("today", TODAY), edinburgh_source=kw.pop("edinburgh_source", True))


class NormaliseAndMoney(unittest.TestCase):
    def test_normalise(self):
        self.assertEqual(gate.normalise("  It’s  A “Test” – ok… "), "it's a \"test\" - ok...")

    def test_money_figures(self):
        self.assertEqual(gate.money_figures("£35.00 and £1,200 and 50p and 20% off, 15 per cent"), {"£35", "£1200", "50p", "20%", "15%"})
        self.assertEqual(gate.money_figures("25 pizzas, 5pm"), set())


class GateTests(unittest.TestCase):
    def test_good_deal_passes_and_dates_are_london_iso(self):
        r = run_gate(deal())
        self.assertTrue(r.ok, r.detail)
        raw = gate.to_raw_happening(deal(), r, source_name="Forever Edinburgh offers", page_url="https://edinburgh.org/x/")
        self.assertEqual(raw["recurrence"]["dates"], ["2026-09-25", "2026-10-30", "2026-11-27"])
        self.assertEqual(raw["eligibility"], "anyone")
        self.assertEqual(raw["field_sources"]["saving_label"], "https://edinburgh.org/x/")

    def test_quote_not_on_page(self):
        d = deal()
        d["fields"]["saving_label"]["quote"] = "for just twenty percent off"
        r = run_gate(d)
        self.assertEqual((r.ok, r.reason), (False, "quote_not_found"))

    def test_deal_quote_missing(self):
        self.assertEqual(run_gate(deal(quote="")).reason, "no_quote")
        self.assertEqual(run_gate(deal(quote="x" * 600)).reason, "quote_too_long")

    def test_figure_must_be_in_quote(self):
        d = deal()
        d["fields"]["saving_label"] = {"value": "25% off", "quote": "Use code BOOZY20 for 20% off"}
        self.assertEqual(run_gate(d).reason, "figure_not_in_quote")
        d["fields"]["saving_label"] = {"value": "£5 off", "quote": "for £35.00 per person"}
        self.assertEqual(run_gate(d).reason, "figure_not_in_quote")

    def test_quote_matching_ignores_case_whitespace_and_link_markers(self):
        d = deal()
        d["fields"]["saving_label"]["quote"] = "USE CODE  BOOZY20 for 20% off [link: https://x.com/a]"
        self.assertTrue(run_gate(d).ok)

    def test_promo_code_must_be_verbatim(self):
        d = deal()
        d["fields"]["promo_code"] = {"value": "BOOZY20", "quote": "Use code BOOZY20 for 20% off"}
        self.assertTrue(run_gate(d).ok)
        d["fields"]["promo_code"] = {"value": "boozy20", "quote": "Use code BOOZY20 for 20% off"}
        self.assertEqual(run_gate(d).reason, "promo_code_not_verbatim")

    def test_dates_must_be_stated(self):
        d = deal()
        d["fields"]["recurrence"]["value"]["dates"] = ["2026-09-25", "2026-10-31"]
        self.assertEqual(run_gate(d).reason, "date_not_stated")
        d = deal()
        d["fields"]["starts_at"] = {"value": "2026-10-01", "quote": "30 October and 27 November 2026 only."}
        self.assertEqual(run_gate(d).reason, "date_not_stated")

    def test_date_match_is_word_bounded_and_accepts_zero_padded(self):
        self.assertFalse(gate.date_stated("2026-10-01", "valid until 21 October"))
        self.assertTrue(gate.date_stated("2026-10-01", "01 October – 08 November 2026"))
        self.assertTrue(gate.date_stated("2026-11-08", "01 October – 08 November 2026"))
        self.assertFalse(gate.date_stated("2026-11-18", "01 October – 08 November 2026"))
        self.assertTrue(gate.date_stated("2026-08-01", "valid daily from 01 to 31 August 2026."))
        self.assertTrue(gate.date_stated("2026-08-31", "valid daily from 01 to 31 August 2026."))
        self.assertFalse(gate.date_stated("2026-08-15", "valid daily from 01 to 31 August 2026."))
        self.assertFalse(gate.date_stated("2026-09-31", "01 to 31 August"))

    def test_weekday_must_be_stated(self):
        p = gate.PageContext(url="u", text="Kids eat free every Tuesday at Canopy Kitchen, EH1 1AA.", single_deal=True)
        item = {"title": "Kids eat free", "kind": "deal", "category": "family", "quote": "Kids eat free every Tuesday",
                "fields": {"saving_label": {"value": "Kids eat free", "quote": "Kids eat free"},
                           "recurrence": {"value": {"type": "weekly", "days": [2]}, "quote": "every Tuesday"}}}
        self.assertTrue(run_gate(item, page=p).ok)
        item["fields"]["recurrence"]["value"]["days"] = [4]
        self.assertEqual(run_gate(item, page=p).reason, "weekday_not_stated")

    def test_weekly_until_may_be_stated_in_the_date_range_quote(self):
        p = gate.PageContext(url="u", text="2 for 1 on Tuesdays. EH6 6RB\n01 October – 08 November 2026", single_deal=False)
        item = {"title": "2 for 1 Tuesdays", "kind": "deal", "category": "food", "quote": "2 for 1 on Tuesdays.",
                "fields": {"saving_label": {"value": "2 for 1", "quote": "2 for 1"},
                           "ends_at": {"value": "2026-11-08", "quote": "01 October – 08 November 2026"},
                           "recurrence": {"value": {"type": "weekly", "days": [2], "until": "2026-11-08"}, "quote": "on Tuesdays"}}}
        self.assertTrue(run_gate(item, page=p).ok)

    def test_repair_quote(self):
        src = "Each portion contains 8 large pierogi served with garlic sauce. Save 20% on Film Studio Hire. for photographers"
        # model dropped a word and changed one: still >= 80% of its words in one run
        fixed = gate.repair_quote("Save 20% on Film Studio Hire for photographers and brands", src)
        self.assertIsNone(fixed)  # only 6/10 consecutive: too far off
        fixed = gate.repair_quote("Save 20% on Film Studios Hire. for photographers", src)
        self.assertIsNone(fixed)
        fixed = gate.repair_quote("Save 20% on Film Studio Hire.", src)
        self.assertEqual(fixed, "Save 20% on Film Studio Hire.")
        self.assertIsNone(gate.repair_quote("two words", src))

    def test_repaired_quote_still_needs_its_figures(self):
        p = gate.PageContext(url="u", text="Save 20% on film studio hire in Leith, EH6 6RB. Terms apply to all bookings made online.",
                             single_deal=True, repair_text="Save 20% on film studio hire in Leith, EH6 6RB. Terms apply to all bookings made online.")
        item = {"title": "20% off studio hire", "kind": "deal", "category": "arts",
                "quote": "Save 20% on film studio hire in Leith, EH6 6RB. Terms apply to all bookings",
                "fields": {"saving_label": {"value": "20% off", "quote": "Save 20% on film studio hire in Leith, EH6 6RB. Terms apply to all bookings made online. Extras"}}}
        # label quote has an extra word at the end (9/10... tail only): repairable, and contains 20%
        r = run_gate(item, page=p)
        self.assertTrue(r.ok, r.detail)
        self.assertTrue(p.repaired)
        # when the cut-off part is the figure itself the repair must not rescue it
        p2 = gate.PageContext(url="u", text="Save 20% on film studio hire in Leith EH6 6RB", single_deal=True,
                              repair_text="Save 20% on film studio hire in Leith EH6 6RB")
        item2 = {"title": "30% off studio hire", "kind": "deal", "category": "arts",
                 "quote": "Save 20% on film studio hire in Leith EH6 6RB",
                 "fields": {"saving_label": {"value": "30% off", "quote": "Save 30% on film studio hire in Leith EH6 6RB"}}}
        self.assertEqual(run_gate(item2, page=p2).reason, "figure_not_in_quote")

    def test_edinburgh_rules(self):
        p = gate.PageContext(url="u", text="Free brunch for students. Sunday only.", single_deal=False)
        item = {"title": "Free brunch", "kind": "deal", "category": "food", "quote": "Free brunch for students.",
                "fields": {"saving_label": {"value": "Free brunch", "quote": "Free brunch"}}}
        self.assertEqual(run_gate(item, page=p, edinburgh_source=False).reason, "not_edinburgh")
        self.assertTrue(run_gate(item, page=p, edinburgh_source=True).ok)
        p2 = gate.PageContext(url="u", text="Free brunch for students. 1 High Street, Glasgow G1 1AA", single_deal=False)
        item["fields"]["address"] = {"value": "1 High Street, Glasgow G1 1AA", "quote": "1 High Street, Glasgow G1 1AA"}
        self.assertEqual(run_gate(item, page=p2, edinburgh_source=True).reason, "not_edinburgh")
        p3 = gate.PageContext(url="u", text="Free brunch for students. 1 High Street, Edinburgh eh1 1aa", single_deal=False)
        item["fields"]["address"] = {"value": "1 High Street, Edinburgh EH1 1AA", "quote": "1 High Street, Edinburgh eh1 1aa"}
        self.assertTrue(run_gate(item, page=p3, edinburgh_source=False).ok)

    def test_expired(self):
        p = gate.PageContext(url="u", text="Half price entry. 1 June – 30 June 2026. EH1 1AA", single_deal=True)
        item = {"title": "Half price entry", "kind": "deal", "category": "museum", "quote": "Half price entry. 1 June – 30 June 2026.",
                "fields": {"saving_label": {"value": "Half price", "quote": "Half price"},
                           "starts_at": {"value": "2026-06-01", "quote": "1 June"},
                           "ends_at": {"value": "2026-06-30", "quote": "30 June 2026"}}}
        self.assertEqual(run_gate(item, page=p).reason, "expired")
        self.assertTrue(run_gate(item, page=p, today=date(2026, 6, 30)).ok)
        # a weekly offer whose `until` has passed
        p = gate.PageContext(url="u", text="Half price every Monday until 31 August 2026. EH1 1AA", single_deal=True)
        item = {"title": "Half price Mondays", "kind": "deal", "category": "food", "quote": "Half price every Monday until 31 August 2026.",
                "fields": {"saving_label": {"value": "Half price", "quote": "Half price"},
                           "recurrence": {"value": {"type": "weekly", "days": [1], "until": "2026-08-31"}, "quote": "every Monday until 31 August 2026"}}}
        self.assertEqual(run_gate(item, page=p).reason, "expired")

    def test_is_genuine_deal_port(self):
        g = gate.is_genuine_deal
        self.assertTrue(g("x", None, None, "CODE1", "anyone"))
        self.assertTrue(g("x", "20% off", None, None, "anyone"))
        self.assertTrue(g("x", "£4 tickets", None, None, "anyone"))
        self.assertTrue(g("Half-price tickets", None, None, None, "anyone"))
        self.assertTrue(g("x", "£14.50", 3.5, None, "student"))
        self.assertFalse(g("x", "£14.50", 3.5, None, "anyone"))
        self.assertFalse(g("x", "£20.00", None, None, "member"))
        self.assertFalse(g("Afternoon tea", "£45 per person", None, None, "anyone"))
        self.assertFalse(g("x", "On Sale", 0, None, "student"))

    def test_eligibility_needs_quote(self):
        d = deal()
        d["fields"]["eligibility"] = {"value": "local_resident", "quote": "for people who live in Edinburgh"}
        self.assertEqual(run_gate(d).reason, "eligibility_unsupported")
        d["fields"]["eligibility"] = {"value": "local_resident", "quote": "perfect way to kick off your weekend"}
        r = run_gate(d)
        self.assertTrue(r.ok)
        self.assertEqual(r.fields["eligibility"], "local_resident")

    def test_scheme_wide_eligibility_uses_the_page_statement(self):
        txt = "Resident Rewards are for people who live in Edinburgh.\n20% off food at Herringbone, 1 High St, Edinburgh EH1 1AA."
        p = gate.PageContext(url="u", text=txt, single_deal=False, repair_text=txt)
        item = {"title": "Herringbone 20% off", "kind": "deal", "category": "food", "quote": "20% off food at Herringbone",
                "fields": {"saving_label": {"value": "20% off", "quote": "20% off food"},
                           "eligibility": {"value": "local_resident", "quote": ""}}}
        self.assertEqual(gate.gate_deal(item, p, today=TODAY, edinburgh_source=True).reason, "eligibility_unsupported")
        r = gate.gate_deal(item, p, today=TODAY, edinburgh_source=True, default_eligibility="local_resident")
        self.assertTrue(r.ok, r.detail)
        self.assertEqual(r.fields["eligibility"], "local_resident")
        self.assertIn("people who live in Edinburgh", r.evidence["eligibility"]["quote"])

    def test_non_critical_field_is_dropped_not_fatal(self):
        d = deal()
        d["fields"]["includes"] = {"value": "unlimited prosecco", "quote": "all the prosecco you can drink"}
        r = run_gate(d)
        self.assertTrue(r.ok)
        self.assertIn("includes", r.dropped)
        self.assertNotIn("includes", r.fields)

    def test_overlong_display_value_is_dropped_not_fatal(self):
        d = deal()
        d["fields"]["includes"] = {"value": "x" * 300, "quote": "5 drinks from the brunch menu"}
        r = run_gate(d)
        self.assertTrue(r.ok)
        self.assertIn("includes", r.dropped)

    def test_is_free_failure_is_dropped(self):
        d = deal()
        d["fields"]["is_free"] = {"value": True, "quote": "5 drinks from the brunch menu"}
        r = run_gate(d)
        self.assertTrue(r.ok)
        self.assertIn("is_free", r.dropped)

    def test_booking_url_must_be_a_page_link(self):
        d = deal()
        d["fields"]["booking_url"] = {"value": "https://evil.example/x", "quote": "Book"}
        r = run_gate(d)
        self.assertTrue(r.ok)
        self.assertIn("booking_url", r.dropped)
        d["fields"]["booking_url"] = {"value": "https://www.malonesleith.com/irish-boozy-brunch/", "quote": "Book"}
        self.assertEqual(run_gate(d).fields["booking_url"], "https://www.malonesleith.com/irish-boozy-brunch/")


class NotADealTests(unittest.TestCase):
    def test_plain_price_dropped(self):
        p = gate.PageContext(url="u", text="Afternoon tea £45 per person at the Dunstane, EH12 5EE", single_deal=True)
        item = {"title": "Afternoon tea at The Dunstane", "kind": "deal", "category": "food", "quote": "Afternoon tea £45 per person",
                "fields": {"saving_label": {"value": "£45 per person", "quote": "£45 per person"}}}
        r = run_gate(item, page=p)
        self.assertEqual((r.ok, r.reason), (False, "not_a_deal"))


class LedgerTests(unittest.TestCase):
    def test_hash_ignores_whitespace_and_entities_but_not_content(self):
        a = content_hash("Hello   world\n£5 &amp; up")
        b = content_hash("Hello world £5 & up")
        c = content_hash("Hello world £6 & up")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertEqual(normalise_for_hash("  a \n b "), "a b")

    def test_html_to_text(self):
        t = html_to_text("<p>Use <strong>code</strong> A</p><ul><li>one</li><li>two&nbsp;x</li></ul><script>x()</script>")
        self.assertEqual(t.split("\n")[0], "Use code A")
        self.assertIn("two x", t)
        self.assertNotIn("x()", t)

    def test_off_mode_treats_everything_as_changed_and_never_writes(self):
        led = Ledger("off")
        led.load("s")
        self.assertFalse(led.is_unchanged("u", "text"))
        self.assertFalse(led.record("u", "s", "text"))

    def test_read_mode_never_writes_and_compares_hashes(self):
        led = Ledger("read", connection=("http://x", "k"))
        led._known["u"] = {"url": "u", "content_hash": content_hash("text")}
        self.assertTrue(led.is_unchanged("u", "text  "))
        self.assertFalse(led.is_unchanged("u", "other"))
        self.assertFalse(led.record("u", "s", "other"))  # read-only: no request attempted
        self.assertEqual(led.writes, 0)

    def test_deferred_rw_writes_nothing_until_commit(self):
        # 2026-10-12: a run recorded page hashes, then its staging upsert failed,
        # and the re-run skipped those pages as unchanged. Deferred rows only
        # reach source_pages when the caller commits after staging.
        posted = []

        class Ok:
            status_code = 201

        led = Ledger("rw", connection=("http://x", "k"), defer=True)
        with mock.patch("deal_sources.ledger.requests.post", lambda *a, **kw: (posted.append(kw["json"]), Ok())[1]):
            self.assertTrue(led.record("u", "s", "text"))
            self.assertEqual((posted, led.writes), ([], 0))  # an upsert failing here leaves source_pages untouched
            self.assertEqual(led.commit(), 1)
        self.assertEqual([row["url"] for row in posted], ["u"])
        self.assertTrue(led.is_unchanged("u", "text"))
        self.assertEqual(led.commit(), 0)  # the queue is drained

    def test_missing_credentials_or_table_is_logged_once(self):
        logs = []
        led = Ledger("read", connection=None, log=logs.append)
        led.connection = None
        led.available = False
        self.assertFalse(led.is_unchanged("u", "t"))
        self.assertTrue(table_missing(404, None))
        self.assertTrue(table_missing(400, {"code": "PGRST205"}))
        self.assertTrue(table_missing(400, {"code": "42P01"}))
        self.assertFalse(table_missing(500, {"code": "XX000"}))
        led._warn("a")
        led._warn("b")
        self.assertEqual(len([m for m in logs if "ledger unavailable" in m]), 1)


class DiscoverTests(unittest.TestCase):
    def test_wp_items_filter_status_age_and_extract_image(self):
        data = json.loads((FIXTURES / "forever-pages.json").read_text())
        refs, old = parse_wp_items(data, NOW, modified_within_days=None)
        self.assertEqual(len(refs), 4)  # the draft is dropped
        self.assertTrue(all(r.url.startswith("https://edinburgh.org/") and r.html for r in refs))
        malones = next(r for r in refs if "malones-leith-irish" in r.url)
        self.assertEqual(malones.title, "Malones Leith Irish Boozy Brunch")
        self.assertTrue(malones.image_url and malones.image_url.startswith("https://"))
        refs120, old120 = parse_wp_items(data, NOW, modified_within_days=120)
        self.assertEqual(old120, 2)  # the 2023 gin offer and the May Hawksmoor one
        self.assertEqual(len(refs120), 2)

    def test_wp_single_object_and_children(self):
        shore = json.loads((FIXTURES / "shore-page.json").read_text())
        refs, _ = parse_wp_items(shore[0], NOW)
        self.assertEqual(len(refs), 1)
        self.assertIn("Cherry Bay Cafe", html_to_text(refs[0].html))
        kids = json.loads((FIXTURES / "resident-rewards-children.json").read_text())
        refs, _ = parse_wp_items(kids, NOW, 120)
        self.assertEqual(len(refs), 2)

    def test_sitemap_and_filters(self):
        xml = "<urlset><url><loc>https://a.com/offers/x</loc></url><url><loc>https://a.com/about</loc></url></urlset>"
        locs, children = parse_sitemap_locs(xml)
        self.assertEqual(children, [])
        self.assertEqual(filter_urls(locs, r"/offers/", None), ["https://a.com/offers/x"])
        index = "<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>"
        locs, children = parse_sitemap_locs(index)
        self.assertEqual((locs, children), ([], ["https://a.com/s1.xml"]))

    def test_split_blocks_on_offer_cards(self):
        shore = json.loads((FIXTURES / "shore-page.json").read_text())[0]["content"]["rendered"]
        blocks = split_blocks(shore, SOURCES[1].segment)
        self.assertGreaterEqual(len(blocks), 2)
        self.assertIn("Cherry Bay Cafe", html_to_text(blocks[0]))
        self.assertNotIn("Old Chain Pier", html_to_text(blocks[0]))
        self.assertIn("Old Chain Pier", html_to_text(blocks[1]))
        html = '<div data-promotion-container class="a">A</div><div data-promotion-container-loading>x</div><div data-promotion-container class="b">B</div><h2>Next</h2>tail'
        out = split_blocks(html, r"<div data-promotion-container\s")
        self.assertEqual(len(out), 2)
        self.assertNotIn("tail", out[1])
        self.assertEqual(split_blocks("<p>none</p>", r"<div data-promotion-container\s"), [])

    def test_og_image_and_chunks(self):
        self.assertEqual(og_image('<meta property="og:image" content="/i.jpg">', "https://a.com/p"), "https://a.com/i.jpg")
        text = "\n".join(f"line {i} " + "x" * 40 for i in range(200))
        chunks = split_chunks(text, 1500, 300)
        self.assertGreater(len(chunks), 3)
        self.assertTrue(all(len(c) <= 1600 for c in chunks))
        joined = "\n".join(chunks)
        for i in range(200):
            self.assertIn(f"line {i} ", joined)

    def test_registry(self):
        self.assertEqual({s.id for s in SOURCES}, {
            "forever-edinburgh-offers", "more-by-the-shore", "resident-rewards",
            "itison-edinburgh", "fort-kinnaird-offers", "omni-centre-offers",
            "edinburgh-leisure-offers", "pizzaexpress-offers",
            "scotrail-kids-for-a-quid", "cineworld-family-films", "picturehouse-kids-club",
        })
        self.assertTrue(all(s.status in ("shadow", "live") for s in SOURCES))
        by_id = {s.id: s for s in SOURCES}
        self.assertEqual(by_id["edinburgh-leisure-offers"].trust, "official")
        self.assertTrue(all(by_id[i].trust == "commercial" for i in (
            "itison-edinburgh", "fort-kinnaird-offers", "omni-centre-offers", "pizzaexpress-offers")))
        self.assertTrue(by_id["pizzaexpress-offers"].national_ok)
        self.assertEqual(by_id["pizzaexpress-offers"].national_venue, "PizzaExpress (Edinburgh restaurants)")
        with self.assertRaises(ValueError):
            get_sources(["nope"])
        with self.assertRaises(ValueError):
            DealSource("x", "x", "weird", "shadow", {"kind": "urls", "urls": []})
        with self.assertRaises(ValueError):
            DealSource("x", "x", "commercial", "shadow", {"kind": "urls", "urls": []}, national_ok=True)
        with self.assertRaises(ValueError):
            DealSource("x", "x", "commercial", "shadow", {"kind": "urls", "urls": []}, edinburgh_evidence="  ")

    def test_itison_listing_pattern_keeps_deals_and_drops_categories(self):
        rx = next(s for s in SOURCES if s.id == "itison-edinburgh").discover["href_pattern"]
        import re
        self.assertTrue(re.search(rx, "https://www.itison.com/Edinburgh/deals/pizzas-for-two-bonnie-whistle"))
        self.assertTrue(re.search(rx, "https://www.itison.com/Edinburgh/deals/4-rufflets-st-andrews-stay"))
        self.assertFalse(re.search(rx, "https://www.itison.com/Edinburgh/deals/category/food-and-drink"))
        self.assertFalse(re.search(rx, "https://www.itison.com/christmas/deals/category/food-and-drink"))
        self.assertFalse(re.search(rx, "https://www.itison.com/Edinburgh/deals/x/y"))
        html = ('<a href="/Edinburgh/deals/chop-house-voucher-spend">Chop</a>'
                '<a href="/Edinburgh/deals/category/beauty">Beauty</a>')
        links = [u for u, _t in []]  # placeholder replaced below
        from deal_sources.textutil import html_links
        urls = [h for _t, h in html_links(html, "https://www.itison.com/edinburgh")]
        self.assertEqual([u for u in urls if re.search(rx, u)], ["https://www.itison.com/Edinburgh/deals/chop-house-voucher-spend"])


class RunnerWiringTests(unittest.TestCase):
    """Whole path with a fake fetcher and fake LLM: no network, no key."""

    class FakeFetcher:
        def get_json(self, url):
            from deal_sources.fetch import Response
            kids = json.loads((FIXTURES / "forever-pages.json").read_text())[1]
            synthetic = {
                "id": 1, "status": "publish", "link": "https://edinburgh.org/offers/malones/", "slug": "malones",
                "modified_gmt": "2026-10-01T00:00:00", "title": {"rendered": "Malones Leith Irish Boozy Brunch"},
                "content": {"rendered": PAGE_HTML},
                "_embedded": {"wp:featuredmedia": [{"source_url": "https://edinburgh.org/img/malones.jpg"}]},
            }
            return [synthetic, kids], Response(True, url, headers={})

        def get(self, url, **kw):
            from deal_sources.fetch import Response
            return Response(False, url, reason="HTTP 404")

    def test_end_to_end(self):
        import deal_sources.runner as runner

        def fake_extract(client, model, prompt, **kw):
            if "BOOZY20" in prompt:
                d = deal()
                return ExtractResult([d], input_tokens=1000, output_tokens=200)
            # the August kids-eat-free page: a real deal whose dates have passed
            d = {
                "title": "Kids eat free at Malones Leith", "kind": "deal", "category": "family",
                "quote": "Up to 2 children can dine from the Kid\u2019s Menu for free with 1 adult who is dining from the main menu.",
                "fields": {
                    "saving_label": {"value": "Kids eat free", "quote": "Up to 2 children can dine from the Kid\u2019s Menu for free"},
                    "is_free": {"value": True, "quote": "dine from the Kid\u2019s Menu for free"},
                    "starts_at": {"value": "2026-08-01", "quote": "valid daily from 01 to 31 August 2026."},
                    "ends_at": {"value": "2026-08-31", "quote": "valid daily from 01 to 31 August 2026."},
                },
            }
            return ExtractResult([d], input_tokens=500, output_tokens=100)

        original = runner.extract_deals
        runner.extract_deals = fake_extract
        try:
            src = DealSource("t", "Test source", "official", "shadow", {"kind": "wp_rest", "urls": ["https://edinburgh.org/x"]}, edinburgh=True)
            result = run_deal_sources(
                (src,), batch_id="b", today=TODAY, now_iso=NOW.isoformat(), cap_usd=0.5, in_rate=0.28, out_rate=0.42,
                catalogue=None, ledger_enabled=False, fetcher=self.FakeFetcher(), client=object(), model="m", log=lambda *_: None,
            )
        finally:
            runner.extract_deals = original
        stats = result.stats[0]
        self.assertEqual(stats.pages_discovered, 2)
        self.assertEqual(stats.deals_extracted, 2)
        self.assertEqual(stats.kept, 1)
        self.assertEqual(dict(stats.rejected), {"expired": 1})
        self.assertEqual(result.live_records, [])  # shadow: never returned for staging
        self.assertEqual(len(result.shadow_records), 1)
        rec = result.shadow_records[0]
        self.assertEqual(rec["research_mode"], "deal-source")
        self.assertEqual(rec["saving_label"], "20% off")
        self.assertEqual(rec["slug"], "t-malones")
        self.assertEqual(rec["image_url"], "https://edinburgh.org/img/malones.jpg")
        self.assertEqual(rec["source_url"], "https://edinburgh.org/offers/malones/")
        self.assertAlmostEqual(result.cost_usd, 1500 / 1e6 * 0.28 + 300 / 1e6 * 0.42, places=7)

    def test_budget_cap_stops_extraction(self):
        import deal_sources.runner as runner
        original = runner.extract_deals
        runner.extract_deals = lambda *a, **k: ExtractResult([], 10, 10)
        try:
            src = DealSource("t", "Test source", "official", "shadow", {"kind": "wp_rest", "urls": ["https://edinburgh.org/x"]}, edinburgh=True)
            result = run_deal_sources(
                (src,), batch_id="b", today=TODAY, now_iso=NOW.isoformat(), cap_usd=0.0, in_rate=0.28, out_rate=0.42,
                ledger_enabled=False, fetcher=self.FakeFetcher(), client=object(), model="m", log=lambda *_: None,
            )
        finally:
            runner.extract_deals = original
        self.assertTrue(result.budget_exhausted)
        self.assertEqual(result.cost_usd, 0.0)

    def test_every_rejected_deal_is_written_to_out_dir(self):
        import tempfile
        import deal_sources.runner as runner

        def fake_extract(client, model, prompt, **kw):
            if "BOOZY20" in prompt:
                return ExtractResult([deal()], input_tokens=10, output_tokens=10)
            d = {
                "title": "Kids eat free at Malones Leith", "kind": "deal", "category": "family",
                "quote": "Up to 2 children can dine from the Kid\u2019s Menu for free with 1 adult who is dining from the main menu.",
                "fields": {
                    "saving_label": {"value": "Kids eat free", "quote": "Up to 2 children can dine from the Kid\u2019s Menu for free"},
                    "starts_at": {"value": "2026-08-01", "quote": "valid daily from 01 to 31 August 2026."},
                    "ends_at": {"value": "2026-08-31", "quote": "valid daily from 01 to 31 August 2026."},
                },
            }
            return ExtractResult([d], input_tokens=10, output_tokens=10)

        original = runner.extract_deals
        runner.extract_deals = fake_extract
        try:
            src = DealSource("t", "Test source", "official", "shadow", {"kind": "wp_rest", "urls": ["https://edinburgh.org/x"]}, edinburgh=True)
            with tempfile.TemporaryDirectory() as tmp:
                result = run_deal_sources(
                    (src,), batch_id="b", today=TODAY, now_iso=NOW.isoformat(), cap_usd=0.5, in_rate=0.28, out_rate=0.42,
                    ledger_enabled=False, fetcher=self.FakeFetcher(), client=object(), model="m",
                    out_dir=Path(tmp), log=lambda *_: None,
                )
                written = json.loads((Path(tmp) / "t-rejected.json").read_text())
                summary = json.loads((Path(tmp) / "deal-sources-summary.json").read_text())
        finally:
            runner.extract_deals = original
        self.assertEqual(sum(result.stats[0].rejected.values()), 1)
        self.assertEqual(len(written["rejected"]), 1)
        entry = written["rejected"][0]
        self.assertEqual(entry["source_id"], "t")
        self.assertTrue(entry["url"].startswith("https://edinburgh.org/"))
        self.assertEqual(entry["title"], "Kids eat free at Malones Leith")
        self.assertEqual(entry["saving_label"], "Kids eat free")
        self.assertEqual(entry["reason"], "expired")
        self.assertTrue(entry["detail"])
        self.assertIn("Kid", entry["quotes"]["deal"])
        self.assertEqual(entry["quotes"]["fields"]["ends_at"], "valid daily from 01 to 31 August 2026.")
        # The report keeps its counts and examples only: the full list is not in the summary.
        self.assertNotIn("rejected_deals", summary["sources"][0])
        self.assertEqual(summary["sources"][0]["rejected"], {"expired": 1})


class ReportSqlTests(unittest.TestCase):
    def test_approve_sql_covers_verified_rows_and_review_slugs(self):
        import weekly_edinburgh as w
        sql = "\n".join(w.approve_sql("edi-weekly-2026-10-08", ["a-b", "it's"]))
        self.assertIn("batch_id = 'edi-weekly-2026-10-08'", sql)
        self.assertIn("slug in ('a-b', 'it''s')", sql)
        self.assertIn("extraction_status = 'validated' and approved = false", sql)
        self.assertIn("slug in ('')", "\n".join(w.approve_sql("b", [])))

    def test_approve_sql_never_approves_a_row_routed_drop(self):
        import weekly_edinburgh as w
        lines = w.approve_sql("edi-daily-2026-11-02", ["a-b"])
        self.assertIn("coalesce(quality_route, '') <> 'drop'", "\n".join(lines))
        # ANDed outside the OR of the slug list and the validated rule, so it covers both
        drop_at = next(i for i, l in enumerate(lines) if "<> 'drop'" in l)
        or_at = next(i for i, l in enumerate(lines) if "slug in (" in l)
        self.assertLess(drop_at, or_at)
        self.assertTrue(lines[drop_at].lstrip().startswith("and "))
        self.assertTrue(lines[-1].endswith(";"))

    def test_report_says_the_sql_needs_the_quality_columns(self):
        import tempfile
        import weekly_edinburgh as w
        report = {"cost": {"spent_usd": 0, "cap_usd": 1}, "direct_records": 0, "research_records": 0, "verified": [], "review": [],
                  "review_staging_slugs": [], "source_failures": []}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "r.md"
            w.make_report("b1", report, path)
            text = path.read_text()
        self.assertIn("add_deal_quality.sql", text)
        self.assertIn("quality_route = 'drop'", text)


class RestrictedAudienceTests(unittest.TestCase):
    ACCESS_PASS = ("The Access Pass is a free membership scheme designed to improve the booking experience for "
                   "D/deaf, disabled and neurodivergent audience members.")

    def test_access_pass_for_disabled_audience_is_rejected_as_anyone(self):
        p = gate.PageContext(url="u", text=f"Edinburgh International Festival Access Pass\n{self.ACCESS_PASS}", single_deal=True)
        item = {"title": "Edinburgh International Festival Access Pass", "kind": "free_access", "category": "arts",
                "quote": self.ACCESS_PASS,
                "fields": {"is_free": {"value": True, "quote": "The Access Pass is a free membership scheme"}}}
        r = gate.gate_deal(item, p, today=TODAY, edinburgh_source=True)
        self.assertEqual((r.ok, r.reason), (False, "restricted_audience_unsupported"))

    def test_discount_for_a_group_outside_the_enum_is_rejected(self):
        p = gate.PageContext(url="u", text="Teachers save 20% at Canopy Kitchen, EH1 1AA.", single_deal=True)
        item = {"title": "Teachers save 20%", "kind": "deal", "category": "food", "quote": "Teachers save 20% at Canopy Kitchen",
                "fields": {"saving_label": {"value": "20% off", "quote": "Teachers save 20%"}}}
        self.assertEqual(run_gate(item, page=p).reason, "restricted_audience_unsupported")

    def test_declared_eligibility_is_not_second_guessed(self):
        p = gate.PageContext(url="u", text="Teachers save 20% at Canopy Kitchen, EH1 1AA.", single_deal=True)
        item = {"title": "Teachers save 20%", "kind": "deal", "category": "food", "quote": "Teachers save 20% at Canopy Kitchen",
                "fields": {"saving_label": {"value": "20% off", "quote": "Teachers save 20%"},
                           "eligibility": {"value": "student", "quote": "Teachers save 20%"}}}
        r = run_gate(item, page=p)
        self.assertTrue(r.ok, r.detail)
        self.assertEqual(r.fields["eligibility"], "student")

    def test_facility_notes_and_plain_offers_are_not_restricted(self):
        self.assertIsNone(gate.restricted_audience("Step-free access and disabled toilets on every floor."))
        self.assertIsNone(gate.restricted_audience("Free brunch for students. Sunday only."))
        self.assertEqual(gate.restricted_audience("Carers go free. Book at the box office."), "carers")
        self.assertEqual(gate.restricted_audience("Free entry. Offer for blue light workers."), "blue light")
        self.assertEqual(gate.restricted_audience("Veterans get 2 for 1 on tours."), "veterans")
        self.assertEqual(gate.restricted_audience("Free for NHS staff."), "nhs")


class EdinburghEvidenceTests(unittest.TestCase):
    """edinburgh_evidence (a verbatim page statement of the location) and national_ok."""

    OMNI_TEXT = "Student deal: 10% off food at Cosmo.\nOMNi Centre\nGreenside Row, Edinburgh EH1 3AA"

    def item(self, quote="10% off food at Cosmo", **fields):
        base = {"title": "Cosmo 10% off food", "kind": "deal", "category": "food", "quote": quote,
                "fields": {"saving_label": {"value": "10% off", "quote": "10% off food"}, **fields}}
        return base

    def test_page_evidence_counts_as_edinburgh_for_a_multi_offer_page(self):
        p = gate.PageContext(url="u", text=self.OMNI_TEXT, single_deal=False)
        r = gate.gate_deal(self.item(), p, today=TODAY, edinburgh_source=False,
                           edinburgh_evidence="Greenside Row, Edinburgh EH1 3AA")
        self.assertTrue(r.ok, r.detail)
        self.assertFalse(r.national)

    def test_without_page_evidence_a_multi_offer_deal_is_not_edinburgh(self):
        p = gate.PageContext(url="u", text=self.OMNI_TEXT, single_deal=False)
        r = gate.gate_deal(self.item(), p, today=TODAY, edinburgh_source=False)
        self.assertEqual(r.reason, "not_edinburgh")
        r = gate.gate_deal(self.item(), p, today=TODAY, edinburgh_source=False, edinburgh_evidence="Glasgow Central Station")
        self.assertEqual(r.reason, "not_edinburgh")

    def test_evidence_is_matched_after_normalising_whitespace_and_case(self):
        p = gate.PageContext(url="u", text="Offer: 10% off food at Cosmo.\nNewcraighall\n\nEdinburgh\n\nEH15 3RD", single_deal=False)
        r = gate.gate_deal(self.item(), p, today=TODAY, edinburgh_source=False,
                           edinburgh_evidence="newcraighall EDINBURGH eh15 3rd")
        self.assertTrue(r.ok, r.detail)

    def test_non_eh_postcode_in_the_deal_still_rejects_with_evidence(self):
        p = gate.PageContext(url="u", text=self.OMNI_TEXT + "\nSecond site: 1 High Street, Glasgow G1 1AA", single_deal=False)
        item = self.item(address={"value": "1 High Street, Glasgow G1 1AA", "quote": "1 High Street, Glasgow G1 1AA"})
        r = gate.gate_deal(item, p, today=TODAY, edinburgh_source=False, edinburgh_evidence="Greenside Row, Edinburgh EH1 3AA")
        self.assertEqual(r.reason, "not_edinburgh")

    def test_national_offer_with_no_postcode_passes_only_with_national_ok(self):
        text = "Get 20% off with the app at participating PizzaExpress restaurants."
        p = gate.PageContext(url="u", text=text, single_deal=False)
        item = {"title": "PizzaExpress 20% off", "kind": "deal", "category": "food", "quote": "Get 20% off with the app",
                "fields": {"saving_label": {"value": "20% off", "quote": "Get 20% off with the app"}}}
        self.assertEqual(gate.gate_deal(item, p, today=TODAY, edinburgh_source=False).reason, "not_edinburgh")
        r = gate.gate_deal(item, p, today=TODAY, edinburgh_source=False, national_ok=True)
        self.assertTrue(r.ok, r.detail)
        self.assertTrue(r.national)
        raw = gate.to_raw_happening(item, r, source_name="PizzaExpress", page_url="u")
        self.assertEqual(raw["scope"], "national")

    def test_national_ok_never_accepts_a_stated_non_eh_postcode(self):
        text = "20% off at PizzaExpress, 1 Test Street, Glasgow G1 1AA."
        p = gate.PageContext(url="u", text=text, single_deal=False)
        item = {"title": "PizzaExpress 20% off", "kind": "deal", "category": "food", "quote": "20% off at PizzaExpress, 1 Test Street, Glasgow G1 1AA",
                "fields": {"saving_label": {"value": "20% off", "quote": "20% off at PizzaExpress"}}}
        self.assertEqual(gate.gate_deal(item, p, today=TODAY, edinburgh_source=False, national_ok=True).reason, "not_edinburgh")

    def test_local_deal_keeps_venue_scope(self):
        r = run_gate(deal())
        raw = gate.to_raw_happening(deal(), r, source_name="x", page_url="u")
        self.assertEqual(raw["scope"], "venue")


class OrdinalDateTests(unittest.TestCase):
    def test_ordinal_day_and_abbreviated_month_are_stated_dates(self):
        text = "Valid 3rd Jan - 31st Mar 2027"
        self.assertTrue(gate.date_stated("2027-01-03", text))
        self.assertTrue(gate.date_stated("2027-03-31", text))
        self.assertFalse(gate.date_stated("2027-01-21", text))
        self.assertFalse(gate.date_stated("2027-01-01", "Valid 21st Jan"))


class SitemapLastmodTests(unittest.TestCase):
    class FakeSitemaps:
        def __init__(self, docs):
            self.docs = docs
            self.asked = []

        def get(self, url, accept="", expect_json=False):
            self.asked.append(url)
            if url in self.docs:
                return Response(True, url, text=self.docs[url], headers={})
            return Response(False, url, reason="HTTP 404")

    PAGE = ("<urlset>"
            "<url><loc>https://a.com/play-try/</loc><lastmod>2026-10-07T10:00:00+00:00</lastmod></url>"
            "<url><loc>https://a.com/old-offer/</loc><lastmod>2025-03-20T10:00:00+00:00</lastmod></url>"
            "<url><loc>https://a.com/freedom-of-information/</loc><lastmod>2026-10-01</lastmod></url>"
            "<url><loc>https://a.com/no-date-offer/</loc></url>"
            "</urlset>")

    def test_entries_carry_lastmod(self):
        self.assertEqual(parse_sitemap_entries(self.PAGE)[0], ("https://a.com/play-try/", "2026-10-07T10:00:00+00:00"))
        self.assertIsNone(parse_sitemap_entries(self.PAGE)[3][1])

    def test_window_keeps_recent_matching_urls_from_every_sitemap(self):
        src = DealSource("s", "s", "official", "shadow", {
            "kind": "sitemap", "urls": ["https://a.com/page-sitemap.xml", "https://a.com/post-sitemap.xml"],
            "pattern": r"offer|(?:^|[/-])try(?:[-/]|$)", "modified_within_days": 90})
        fetcher = self.FakeSitemaps({"https://a.com/page-sitemap.xml": self.PAGE,
                                     "https://a.com/post-sitemap.xml": self.PAGE.replace("play-try", "post-try")})
        refs, notes = discover(src, fetcher, NOW)
        self.assertEqual(notes, [])
        self.assertEqual([r.url for r in refs], ["https://a.com/play-try/", "https://a.com/post-try/"])
        self.assertEqual(fetcher.asked, ["https://a.com/page-sitemap.xml", "https://a.com/post-sitemap.xml"])

    def test_without_window_every_matching_url_is_kept_and_failures_are_notes(self):
        src = DealSource("s", "s", "official", "shadow", {
            "kind": "sitemap", "urls": ["https://a.com/missing.xml", "https://a.com/page-sitemap.xml"],
            "pattern": r"offer"})
        refs, notes = discover(src, self.FakeSitemaps({"https://a.com/page-sitemap.xml": self.PAGE}), NOW)
        self.assertEqual([r.url for r in refs], ["https://a.com/old-offer/", "https://a.com/no-date-offer/"])
        self.assertEqual(len(notes), 1)


class AnnualWindowTests(unittest.TestCase):
    def test_window_opens_six_weeks_before_the_usual_month_and_ends_with_it(self):
        self.assertEqual(window_for(9, 2026), (date(2026, 7, 21), date(2026, 9, 30)))
        self.assertEqual(window_for(3, 2027), (date(2027, 1, 18), date(2027, 3, 31)))
        self.assertEqual(window_for(2, 2028), (date(2027, 12, 21), date(2028, 2, 29)))  # leap year

    def test_in_window_uses_a_fixed_now(self):
        entry = Annual("x", "X", 9, "https://a.com/x", "official")
        self.assertFalse(in_window(entry, date(2026, 7, 20)))
        self.assertTrue(in_window(entry, date(2026, 7, 21)))
        self.assertTrue(in_window(entry, date(2026, 9, 30)))
        self.assertFalse(in_window(entry, date(2026, 10, 1)))
        jan = Annual("y", "Y", 3, "https://a.com/y", "official")
        self.assertTrue(in_window(jan, date(2026, 1, 20)))   # 2026 edition window
        self.assertFalse(in_window(jan, date(2026, 4, 1)))

    def test_annual_sources_are_shadow_urls_sources_only_in_window(self):
        active = annual_sources(date(2026, 8, 15))
        self.assertEqual({s.id for s in active}, {"national-cinema-weekend", "doors-open-days-edinburgh"})
        self.assertTrue(all(s.status == "shadow" and s.discover["kind"] == "urls" for s in active))
        self.assertEqual(annual_sources(date(2026, 5, 1)), ())
        self.assertEqual(len(annual_sources(date(2026, 5, 1), all_entries=True)), len(load_annual()))

    def test_get_sources_default_includes_active_annual_and_named_ids_are_honoured(self):
        ids = {s.id for s in get_sources(None, date(2026, 8, 15))}
        self.assertIn("doors-open-days-edinburgh", ids)
        self.assertIn("forever-edinburgh-offers", ids)
        self.assertNotIn("national-lottery-open-week", ids)
        self.assertNotIn("doors-open-days-edinburgh", {s.id for s in get_sources(None, date(2026, 5, 1))})
        named = get_sources(["national-lottery-open-week"], date(2026, 5, 1))
        self.assertEqual([s.id for s in named], ["national-lottery-open-week"])

    def test_bad_annual_file_is_refused(self):
        import tempfile
        cases = {
            "month": "- {id: a, name: A, usual_month: 13, url: 'https://a.com/', trust: official}\n",
            "trust": "- {id: a, name: A, usual_month: 3, url: 'https://a.com/', trust: weird}\n",
            "url": "- {id: a, name: A, usual_month: 3, url: 'ftp://a.com/', trust: official}\n",
            "dup": ("- {id: a, name: A, usual_month: 3, url: 'https://a.com/', trust: official}\n"
                    "- {id: a, name: A, usual_month: 4, url: 'https://a.com/', trust: official}\n"),
            "missing": "- {id: a, name: A, usual_month: 3, trust: official}\n",
        }
        for label, text in cases.items():
            with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8") as fh:
                fh.write(text)
            with self.subTest(label), self.assertRaises(ValueError):
                load_annual(Path(fh.name))


class FixedPageTests(unittest.TestCase):
    def test_itison_style_voucher_with_stated_saving_passes_and_plain_voucher_does_not(self):
        text = ("Pizzas for two at Bonnie & Whistle, 19 St Andrew Square, Edinburgh, EH2 1AU\n"
                "Was £30 Now £18 Save up to 43%\nValid 3rd Jan - 31st Mar 2027")
        p = gate.PageContext(url="u", text=text, single_deal=True)
        item = {"title": "Pizzas for two at Bonnie & Whistle", "kind": "deal", "category": "food",
                "quote": "Pizzas for two at Bonnie & Whistle",
                "fields": {"saving_label": {"value": "Save up to 43%", "quote": "Save up to 43%"},
                           "price_text": {"value": "£18", "quote": "Now £18"},
                           "starts_at": {"value": "2027-01-03", "quote": "Valid 3rd Jan - 31st Mar 2027"},
                           "ends_at": {"value": "2027-03-31", "quote": "Valid 3rd Jan - 31st Mar 2027"}}}
        r = gate.gate_deal(item, p, today=TODAY, edinburgh_source=False)
        self.assertTrue(r.ok, r.detail)
        plain = {"title": "Chop House voucher", "kind": "deal", "category": "food", "quote": "Was £50",
                 "fields": {"saving_label": {"value": "£50 voucher spend", "quote": "£50 voucher spend on food"}}}
        p2 = gate.PageContext(url="u", text="£50 voucher spend on food at Chop House, 15 East Market Street, EH8 8FS", single_deal=True)
        self.assertEqual(gate.gate_deal(plain, p2, today=TODAY, edinburgh_source=False).reason, "quote_not_found")



class EdinburghDistrictAndWordingTests(unittest.TestCase):
    def test_city_districts_count_as_edinburgh(self):
        from deal_sources.gate import has_eh_postcode, has_non_eh_postcode
        for pc in ("EH1 1EE", "EH6 6RB", "EH15 3RD", "EH30 9TA"):
            self.assertTrue(has_eh_postcode(pc), pc)
            self.assertFalse(has_non_eh_postcode(pc), pc)

    def test_lothians_districts_do_not(self):
        from deal_sources.gate import has_eh_postcode, has_non_eh_postcode
        for pc in ("EH39 5EG", "EH49 7AE", "EH26 9LP", "EH21 6AA", "EH22 1AA"):
            self.assertFalse(has_eh_postcode(pc), pc)
            self.assertTrue(has_non_eh_postcode(pc), pc)

    def test_buy_one_get_another_is_a_deal(self):
        from deal_sources.gate import is_genuine_deal
        self.assertTrue(is_genuine_deal("£1 Mains", "Buy a Main, get another for £1", None, None, "anyone"))
        self.assertTrue(is_genuine_deal("BOGOF cocktails", None, None, None, "anyone"))
        self.assertFalse(is_genuine_deal("Cocktails £8", "£8", 8, None, "anyone"))

    def test_seasonal_regex(self):
        from deal_sources.gate import SEASONAL_RE
        self.assertTrue(SEASONAL_RE.search("Kids Eat Free this summer"))
        self.assertTrue(SEASONAL_RE.search("all through the October holidays"))
        self.assertFalse(SEASONAL_RE.search("Summer Hall offer, every Monday"))



class QuoteFormattingTests(unittest.TestCase):
    TEXT = ("Veeno Edinburgh\nWine flight with a choice of Italian meat or cheese sharing board for two\n\nFrom\u00a329\n\n"
            "Was \u00a345Save up to 36%\n\nOnline bookings only.\nBook now. Loading... please wait\n76 Rose Street, Edinburgh, EH2 2NN")

    def p(self):
        return gate.PageContext(url="https://www.itison.com/Edinburgh/deals/x", text=self.TEXT, single_deal=True)

    def item(self, quote, label="Was \u00a345 Save up to 36%", label_quote=None):
        return {"title": "Veeno wine flight", "kind": "deal", "category": "food", "quote": quote,
                "fields": {"saving_label": {"value": label, "quote": label_quote or label},
                           "address": {"value": "76 Rose Street, Edinburgh, EH2 2NN", "quote": "76 Rose Street, Edinburgh, EH2 2NN"}}}

    def test_fragments_each_found_on_the_page_pass(self):
        q = "Wine flight with a choice of Italian meat or cheese sharing board for two ... Was \u00a345Save up to 36%"
        self.assertTrue(gate.gate_deal(self.item(q, label_quote="Was \u00a345Save up to 36%"), self.p(), today=TODAY, edinburgh_source=False).ok)
        self.assertTrue(gate.gate_deal(self.item("\u2026 Online bookings only. \u2026 Book now."), self.p(), today=TODAY, edinburgh_source=False).ok)

    def test_a_fragment_not_on_the_page_is_still_rejected(self):
        for q in ("Wine flight with a choice of Italian meat or cheese sharing board for two ... Free dessert with every order",
                  "Free dessert with every order ... Online bookings only.",
                  "Online bookings only. ... Was \u00a345 Save up to 36% ... never on the page"):
            r = gate.gate_deal(self.item(q), self.p(), today=TODAY, edinburgh_source=False)
            self.assertEqual(r.reason, "quote_not_found", q)

    def test_a_quote_with_the_pages_own_ellipsis_still_matches_whole(self):
        self.assertTrue(gate.gate_deal(self.item("Book now. Loading... please wait"), self.p(), today=TODAY, edinburgh_source=False).ok)

    def test_saving_label_ignores_whitespace_only_around_figures(self):
        ok = gate.gate_deal(self.item("Online bookings only."), self.p(), today=TODAY, edinburgh_source=False)
        self.assertTrue(ok.ok, ok.detail)  # "Was \u00a345 Save up to 36%" against the page's "Was \u00a345Save up to 36%"
        bad = self.item("Online bookings only.", label="Was \u00a345 Save up to 63%")
        self.assertEqual(gate.gate_deal(bad, self.p(), today=TODAY, edinburgh_source=False).reason, "quote_not_found")
        # the figure must still be in the quote, and digits are never joined across a space
        self.assertNotEqual(gate.loose_figures("save \u00a31 2"), gate.loose_figures("save \u00a312"))
        self.assertEqual(gate.loose_figures("was \u00a345 save up to 36%"), gate.loose_figures("was \u00a345save up to 36%"))

    def test_loose_matching_is_for_saving_labels_only(self):
        item = self.item("Online bookings only.")
        item["fields"]["address"] = {"value": "76 Rose Street, Edinburgh, EH2 2NN", "quote": "76 Rose Street,Edinburgh,EH2 2NN"}
        self.assertEqual(gate.gate_deal(item, self.p(), today=TODAY, edinburgh_source=False).dropped.get("address") is not None, True)


class CheapPriceTests(unittest.TestCase):
    PASS = ["£4 cask pints", "The Lioness of Leith £5 IPA with any burger", "Patisserie Valerie afternoon tea for two £30"]
    FAIL = ["Victoria Bar classic cocktails £8", "Patisserie Valerie lunch and patisserie £12",
            "Splash and Glow: £29 weekday sessions", "£5 off pints"]

    def test_must_pass(self):
        for title in self.PASS:
            self.assertTrue(gate.is_cheap_price(title, None), title)
            self.assertTrue(gate.is_genuine_deal(title, None, None, None, "anyone"), title)

    def test_must_fail(self):
        for title in self.FAIL:
            self.assertFalse(gate.is_cheap_price(title, None), title)
        # "£5 off pints" still has discount wording, so it is a deal by the old rule; the others are not.
        for title in self.FAIL[:3]:
            self.assertFalse(gate.is_genuine_deal(title, None, None, None, "anyone"), title)

    def test_reads_the_saving_label_too(self):
        self.assertTrue(gate.is_cheap_price("Nobles of Bellfield", "£4 cask pints"))
        self.assertFalse(gate.is_cheap_price("Nobles of Bellfield", "Save £4 on pints"))

    def test_whole_words_and_for_two(self):
        self.assertFalse(gate.is_cheap_price("£3 pinterest board", None))  # "pint" inside a word
        self.assertTrue(gate.is_cheap_price("Cocktails for 2 £12", None))  # £6 a head, under the £7 line
        self.assertFalse(gate.is_cheap_price("Cocktails for two £16", None))  # £8 a head
        self.assertEqual(gate.stated_prices("Save £10, £5 off, was £30 now £20"), [30.0, 20.0])

    def test_lowest_price_wins(self):
        self.assertTrue(gate.is_cheap_price("Pints £6, or £4 on Tuesdays", None))

    def test_a_cheap_price_deal_passes_the_gate_and_its_figure_must_be_quoted(self):
        text = "The Lioness of Leith: £5 IPA with any burger every Tuesday. 3 Constitution Street, Edinburgh EH6 6RS."
        p = gate.PageContext(url="https://example.com/x", text=text, single_deal=True)
        item = {"title": "£5 IPA with any burger", "kind": "deal", "category": "food", "quote": "£5 IPA with any burger every Tuesday.",
                "fields": {"saving_label": {"value": "£5 IPA with any burger", "quote": "£5 IPA with any burger"}}}
        self.assertTrue(gate.gate_deal(item, p, today=TODAY, edinburgh_source=False).ok)
        item["fields"]["saving_label"]["value"] = "£4 IPA with any burger"  # figure not in the quote
        self.assertEqual(gate.gate_deal(item, p, today=TODAY, edinburgh_source=False).reason, "figure_not_in_quote")


class QualityTests(unittest.TestCase):
    def rec(self, **over):
        base = {"title": "Deal", "kind": "deal", "venue_name": "Local Bar", "saving_label": None, "eligibility": "anyone",
                "recurrence": {"type": "always"}, "verified_at": "2026-10-08T12:00:00+00:00", "validation_errors": [],
                "extraction_status": "validated", "price_text": None, "is_free": None}
        base.update(over)
        return base

    def test_evidence_rule(self):
        now = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)
        staged = {"title": "Cheese", "venue_name": "Local Bar", "extraction_status": "pending", "verified_at": "2026-11-02T11:59:00+00:00"}
        live_fresh = {"title": "Cheese", "venue_name": "Local Bar", "verified_at": "2026-10-25T11:59:00.12345+00:00"}
        live_old = {"title": "Cheese", "venue_name": "Local Bar", "verified_at": "2026-10-10T11:59:00.123456+00:00"}
        no_stamp = {"title": "Cheese", "venue_name": "Local Bar"}
        self.assertFalse(quality.has_evidence(staged, now))  # a fresh stamp on a staged row earns nothing
        self.assertTrue(quality.has_evidence(live_fresh, now))
        self.assertFalse(quality.has_evidence(live_old, now))
        self.assertFalse(quality.has_evidence(no_stamp, now))
        self.assertTrue(quality.has_evidence({**staged, "extraction_status": "validated"}, now))
        self.assertTrue(quality.has_evidence({**staged, "_evidence": {"fields": {"saving_label": {"quote": "q"}}}}, now))
        self.assertEqual(quality.score_deal(live_fresh, now=now).score - quality.score_deal(live_old, now=now).score, quality.EVIDENCE_BONUS)
        self.assertEqual(quality.score_deal(staged, now=now).score, quality.score_deal(no_stamp, now=now).score)

    def test_expired_record_routes_to_drop_with_a_reason(self):
        today = date(2026, 11, 2)
        for over in ({"recurrence": {"type": "dates", "dates": ["2026-09-25", "2026-10-30"]}},
                     {"recurrence": {"type": "weekly", "days": [2], "until": "2026-09-30"}},
                     {"recurrence": {"type": "once"}, "ends_at": "2026-09-15T23:59:59+01:00"},
                     {"season_valid_until": "2026-09-30"}):
            r, result = self.strong(**over)
            self.assertGreaterEqual(result.score, quality.PUBLISH_AT)  # high score, still dropped
            self.assertEqual(quality.route_deal(r, result, source_class="web", today=today), "drop", over)
            self.assertIn("expired: every stated date has passed", result.reasons)
            quality.route_deal(r, result, source_class="web", today=today)
            self.assertEqual(result.reasons.count("expired: every stated date has passed"), 1)
        live, result = self.strong(recurrence={"type": "weekly", "days": [2], "until": "2026-12-01"})
        self.assertEqual(quality.route_deal(live, result, source_class="web", today=today), "publish")

    def test_main_alone_is_not_a_main_course(self):
        self.assertFalse(gate.is_cheap_price("Main Stage £5", None))
        self.assertFalse(gate.is_cheap_price("Fringe Main Stage tickets £5", "£5"))
        self.assertTrue(gate.is_cheap_price("Two course main course lunch £9", None) and gate.is_cheap_price("Any main course £9", None))
        self.assertTrue(gate.is_cheap_price("Burger mains £9", None))

    def test_per_person_spend_penalty(self):
        def score(**over):
            return quality.score_deal(self.rec(**{"title": "Cheese", "verified_at": None, "extraction_status": "pending", **over})).score
        base = score()
        self.assertEqual(score(saving_label="£35 a head"), base - 15)
        self.assertEqual(score(saving_label="£39.95 per person"), base - 15)
        self.assertEqual(score(price_text="From£45"), base - 15)
        self.assertEqual(score(price_text="£25"), base)
        self.assertEqual(score(title="Dinner for four £100"), base)  # £25 each
        self.assertEqual(score(title="Dinner for four £120"), base - 15)
        self.assertEqual(score(saving_label="Save up to 58%"), score(saving_label="Save up to 58%", price_text=None))  # no price, no penalty
        self.assertEqual(quality.current_prices("£15 (usually £100)"), [15.0])
        self.assertEqual(quality.current_prices("Was £98, save up to 34%, now £65 each. Worth £120, RRP £50, originally £70"), [65.0])
        self.assertEqual(quality.current_prices("£5 off, save £10, Save up to £8"), [])

    def test_was_prices_do_not_trigger_the_price_penalties(self):
        r = self.rec(title="Health by Science Movement MOT for £15", saving_label="£15 (usually £100)", venue_name="Health by Science")
        reasons = quality.score_deal(r).reasons
        self.assertFalse([x for x in reasons if "poor fit" in x], reasons)
        dear = self.rec(title="Movement MOT", saving_label="£100", venue_name="Health by Science")
        self.assertTrue([x for x in quality.score_deal(dear).reasons if "price over" in x])

    def test_locate_follows_deal_review(self):
        L = quality.locate
        self.assertEqual(L({"address": "1 High St, Musselburgh EH21 6AA"}), (False, "EH21 postcode"))
        self.assertEqual(L({"address": "Leith, Edinburgh EH6 6RB", "venue_name": "Glasgow Bar"}), (True, "EH6 postcode"))  # postcode first
        for pc in ("EH1 1AA", "EH17 8AB", "EH29 9AA", "EH91 1AA", "EH99 1SP"):
            self.assertTrue(L({"address": pc})[0], pc)
        for pc in ("EH18 1AA", "EH22 1AA", "G1 1AA", "KY1 1AA", "EH31 1AA"):
            self.assertFalse(L({"address": pc})[0], pc)
        self.assertEqual(L({"venue_name": "Lido Musselburgh"}), (False, "Musselburgh"))
        self.assertEqual(L({"title": "Go Ape Dalkeith: 15% discount", "venue_name": "Go Ape"}), (False, "Dalkeith"))
        self.assertIsNone(L({"venue_name": "The Lioness of Leith", "title": "Pints"}))  # Leith is inside, no data means keep
        self.assertEqual(L({"lat": 55.95, "lng": -3.19}), (True, "pin 55.95, -3.19"))
        self.assertFalse(L({"lat": 55.86, "lng": -4.25})[0])
        self.assertIsNone(L({"lat": None, "lng": None}))

    def test_street_named_after_a_town_is_not_the_town(self):
        L = quality.locate
        for name in ("Dalkeith Road", "Dalkeith Rd", "Dalkeith Street", "Dalkeith St", "Dalkeith Place", "Dalkeith Pl",
                     "Dalkeith Avenue", "Dalkeith Ave", "Dalkeith Terrace", "Dalkeith Lane", "dalkeith road", "Glasgow Rd", "Musselburgh Lane"):
            self.assertIsNone(L({"venue_name": f"Cafe, {name}", "title": "Free coffee"}), name)
        self.assertEqual(L({"venue_name": "Dalkeith Road Cafe, Dalkeith", "title": "x"}), (False, "Dalkeith"))  # a later bare mention counts
        self.assertEqual(L({"venue_name": "Dalkeith Stables", "title": "x"}), (False, "Dalkeith"))  # "St" is not "Stables"
        self.assertEqual(L({"title": "Go Ape Dalkeith: 15% discount", "venue_name": "Go Ape"}), (False, "Dalkeith"))
        self.assertEqual(L({"venue_name": "Lido Musselburgh"}), (False, "Musselburgh"))
        # With no postcode the street name falls through to the pin: inside Edinburgh keeps the row
        self.assertEqual(L({"venue_name": "Dalkeith Road", "lat": 55.94, "lng": -3.17}), (True, "pin 55.94, -3.17"))
        r, result = self.strong(venue_name="Cafe on Dalkeith Road", address=None)
        self.assertEqual(quality.route_deal(r, result, source_class="web"), "publish")

    def test_same_venue_uses_place_id_then_name_plus_area(self):
        sv = quality.same_venue
        civ, civp = {"venue_name": "Civerinos"}, {"venue_name": "Civerinos Portobello"}
        self.assertTrue(sv(civ, civp) and sv(civp, civ))
        self.assertTrue(sv({"venue_name": "The Blackbird"}, {"venue_name": "Blackbird Edinburgh"}))
        self.assertTrue(sv({"venue_name": "Civerinos"}, {"venue_name": "Civerinos Old Town"}))  # multi-word area
        self.assertFalse(sv({"venue_name": "The Stand"}, {"venue_name": "The Standing Order"}))
        self.assertFalse(sv({"venue_name": "Stand"}, {"venue_name": "Stand Comedy Club"}))  # no general containment
        self.assertFalse(sv({"venue_name": "Civerinos"}, {"venue_name": "Civerinos Slice"}))  # not an area word
        self.assertFalse(sv({"venue_name": "Civerinos Leith"}, {"venue_name": "Civerinos Portobello"}))
        self.assertFalse(sv({"venue_name": ""}, {"venue_name": ""}))
        # place_id decides when both have one, in either direction
        self.assertTrue(sv({"venue_name": "A", "place_id": "p1"}, {"venue_name": "Totally Different", "place_id": "p1"}))
        self.assertFalse(sv({"venue_name": "Civerinos", "place_id": "p1"}, {"venue_name": "Civerinos", "place_id": "p2"}))
        self.assertTrue(sv({"venue_name": "Civerinos", "place_id": "p1"}, {"venue_name": "Civerinos Portobello"}))  # only one has an id: names

    def test_two_civerinos_rows_do_not_both_publish(self):
        def routed(slug, venue, score):
            return quality.RoutedDeal({"slug": slug, "venue_name": venue, "title": slug, "source_name": f"S{slug}"}, quality.QualityResult(score, ["r"]), "publish")
        out = quality.apply_daily_limit([routed("a", "Civerinos", 80), routed("b", "Civerinos Portobello", 90), routed("c", "The Stand", 70), routed("d", "The Standing Order", 70)])
        self.assertEqual([r.route for r in out], ["digest", "publish", "publish", "publish"])
        self.assertIn("same venue", out[0].result.reasons[-1])
        same_id = quality.apply_daily_limit([
            quality.RoutedDeal({"slug": "x", "venue_name": "One", "place_id": "p", "title": "x"}, quality.QualityResult(80, []), "publish"),
            quality.RoutedDeal({"slug": "y", "venue_name": "Two", "place_id": "p", "title": "y"}, quality.QualityResult(75, []), "publish")])
        self.assertEqual([r.route for r in same_id], ["publish", "digest"])

    def test_source_class(self):
        sc = quality.source_class
        self.assertEqual(sc({"source_url": "https://www.instagram.com/p/x/"}), "social")
        self.assertEqual(sc({"source_url": "https://m.facebook.com/x"}), "social")
        self.assertEqual(sc({"source_url": "https://example.com/", "source_urls": ["https://www.tiktok.com/@x"]}), "social")
        self.assertEqual(sc({"source_url": "https://example.com/", "source_name": "Edinburgh newsletter digest"}), "newsletter")
        self.assertEqual(sc({"source_url": "https://notinstagram.com/x"}), "web")
        self.assertEqual(sc({"source_url": "https://itison.com/Edinburgh/deals/x", "source_name": "itison Edinburgh deals"}), "web")

    def test_outside_edinburgh_routes_to_drop_with_a_reason(self):
        for over in ({"venue_name": "Lido Musselburgh"}, {"address": "Dalkeith EH22 1AA"}, {"lat": 55.86, "lng": -4.25}):
            r, result = self.strong(**over)
            self.assertGreaterEqual(result.score, quality.PUBLISH_AT)
            self.assertEqual(quality.route_deal(r, result, source_class="web"), "drop", over)
            self.assertTrue([x for x in result.reasons if x.startswith("outside Edinburgh")], over)
        # national scope is exempt, as in deal-review.ts, and no data keeps the row
        r, result = self.strong(venue_name="Lido Musselburgh", scope="national")
        self.assertEqual(quality.route_deal(r, result, source_class="web"), "publish")
        r, result = self.strong(venue_name="Local Bar", address="EH6 6RB")
        self.assertEqual(quality.route_deal(r, result, source_class="web"), "publish")

    def test_daily_limit_one_per_venue_four_per_source(self):
        def deal(slug, score, venue, source="S", title=None):
            return quality.RoutedDeal({"slug": slug, "venue_name": venue, "title": title or slug, "source_name": source}, quality.QualityResult(score, ["r"]), "publish")
        routed = [deal("a1", 80, "The Blackbird"), deal("a2", 90, "Blackbird"), deal("a3", 85, "THE BLACKBIRD, Edinburgh"),
                  deal("b1", 70, "Vaults"), deal("c1", 75, "56 North", source="T"), deal("c2", 74, "Hanover Tap", source="T"),
                  deal("c3", 73, "Hanover  Tap!", source="T")]
        out = quality.apply_daily_limit(routed)
        self.assertEqual([r.route for r in out], ["digest", "publish", "digest", "publish", "publish", "publish", "digest"])
        self.assertIn("same venue as a higher-scoring publish", out[0].result.reasons[-1])
        self.assertIn("same venue", out[6].result.reasons[-1])
        # a venue-less record falls back to its title
        twins = quality.apply_daily_limit([deal("x", 80, None, title="Pizza night"), deal("y", 79, None, title="Pizza Night")])
        self.assertEqual([r.route for r in twins], ["publish", "digest"])

    def test_daily_limit_per_source_and_overall(self):
        deals = [quality.RoutedDeal({"slug": f"s{i}", "venue_name": f"Venue {i}", "source_name": "One" if i < 6 else f"Src{i}"},
                                    quality.QualityResult(100 - i, []), "publish") for i in range(14)]
        out = quality.apply_daily_limit(deals)
        self.assertEqual([r.route for r in out[:6]], ["publish"] * 4 + ["digest"] * 2)
        self.assertIn("source limit of 4", out[4].result.reasons[-1])
        self.assertEqual([r.route for r in out].count("publish"), 10)  # 4 + 6 others
        self.assertIn("over the daily limit of 10", out[-1].result.reasons[-1])
        self.assertEqual([r.route for r in out][6:12], ["publish"] * 6)

    def test_benchmarks_file_is_valid(self):
        items = gate.load_price_benchmarks()
        self.assertEqual({i["id"] for i in items}, {"pint", "cocktail", "coffee", "lunch", "main", "brunch", "afternoon_tea", "cinema"})
        for i in items:
            self.assertGreater(i["max_gbp"], 0)
            self.assertTrue(i["terms"])

    def test_film_studio_hire_scores_below_70(self):
        r = self.rec(title="20% off film studio hire", saving_label="20% off")
        result = quality.score_deal(r)
        self.assertLess(result.score, 70)
        self.assertTrue(any("hire" in reason for reason in result.reasons))
        self.assertNotEqual(quality.route_deal(r, result, source_class="web"), "publish")

    def test_clinical_service_scores_lower(self):
        plain = quality.score_deal(self.rec(title="Free check", saving_label="Free")).score
        clinical = quality.score_deal(self.rec(title="Free spinal screening", saving_label="Free")).score
        self.assertEqual(plain - clinical, quality.SERVICE_PENALTY)
        self.assertEqual(quality.score_deal(self.rec(title="Free film screening", saving_label="Free")).score, plain)

    def test_tuesday_cask_pints_at_a_local_venue_scores_70_plus(self):
        r = self.rec(title="£4 cask pints", venue_name="Nobles of Bellfield", recurrence={"type": "weekly", "days": [2], "until": None})
        result = quality.score_deal(r)
        self.assertGreaterEqual(result.score, 70)
        self.assertEqual(quality.route_deal(r, result, source_class="web"), "publish")
        self.assertTrue(all(isinstance(reason, str) and reason for reason in result.reasons))

    def test_components(self):
        base = quality.score_deal(self.rec(title="Cheese", eligibility="anyone", verified_at=None, extraction_status="pending")).score  # 20 + 6 + 15 + 5
        self.assertEqual(base, 46)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese", verified_at=None, extraction_status="pending", recurrence={"type": "weekly", "days": [1, 2]})).score, base + 20)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese", verified_at=None, extraction_status="pending", recurrence={"type": "weekly", "days": [1, 2, 3]})).score, base + 8)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese", verified_at=None, extraction_status="pending", recurrence={"type": "weekly", "days": [1, 2, 3, 4, 5]})).score, base)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese", verified_at=None, extraction_status="pending", eligibility="student")).score, base + 5)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese", verified_at=None, extraction_status="pending", eligibility="member")).score, base - 15)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese", venue_name="Nando's", verified_at=None, extraction_status="pending")).score, base - 40)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese", verified_at=None)).score, base + 10)  # validated
        self.assertEqual(quality.score_deal(self.rec(title="Cheese", verified_at=None, extraction_status="pending", _evidence={"deal_quote": "Cheese"})).score, base + 10)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese dinner package", verified_at=None, extraction_status="pending")).score, base - 25)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese dinner £80", verified_at=None, extraction_status="pending")).score, base - 25)
        self.assertEqual(quality.score_deal(self.rec(title="Cheese dinner for two £80", verified_at=None, extraction_status="pending")).score, base - quality.SPEND_PENALTY)  # £40 a head
        self.assertEqual(quality.score_deal(self.rec(title="Cheese dinner for two £50", verified_at=None, extraction_status="pending")).score, base)  # £25 a head

    def test_depth_is_a_port_of_deal_depth(self):
        for text, depth in [("50% off", 50), ("up to 95% off", 90), ("2 for 1", 50), ("Free entry", 40), ("£5 off", 20), ("£4 pints", 40), ("£12 lunch", 20), ("mystery", 10)]:
            self.assertEqual(quality.deal_depth(text, None), depth, text)
        self.assertEqual(quality.score_deal(self.rec(title="X", saving_label="50% off", verified_at=None, extraction_status="pending")).score, 20 + 30 + 15 + 5)

    def test_deep_cheap_price_is_worth_35(self):
        shallow = quality.score_deal(self.rec(title="£4 cask pints", verified_at=None, extraction_status="pending")).score  # 4 > 70% of 4.5
        deep = quality.score_deal(self.rec(title="£3 cask pints", verified_at=None, extraction_status="pending")).score
        self.assertEqual(deep - shallow, 10)

    def test_other_kinds_value(self):
        free = quality.score_deal(self.rec(kind="event", title="Gallery late", is_free=True, verified_at=None, extraction_status="pending")).score
        cheap = quality.score_deal(self.rec(kind="activity", title="Pottery", price_text="£8", verified_at=None, extraction_status="pending")).score
        dear = quality.score_deal(self.rec(kind="tour", title="Whisky tour", price_text="£25", verified_at=None, extraction_status="pending")).score
        self.assertEqual((free, cheap, dear), (20 + 30 + 15 + 5, 20 + 20 + 15 + 5, 20 + 15 + 5))

    def test_clamped(self):
        r = self.rec(title="£1 cask pints", recurrence={"type": "weekly", "days": [2]}, eligibility="student", _evidence={"deal_quote": "x"})
        self.assertEqual(quality.score_deal(r).score, 100)  # 20 + 35 + 20 + 15 + 10 + 10 = 110
        bad = self.rec(title="Hospitality package hire", venue_name="Nando's", eligibility="member", verified_at=None, extraction_status="pending")
        self.assertEqual(quality.score_deal(bad).score, 0)

    def test_drop_below_40(self):
        bad = self.rec(title="Hospitality package", venue_name="Nando's", verified_at=None, extraction_status="pending")
        result = quality.score_deal(bad)
        self.assertLess(result.score, quality.DROP_BELOW)
        self.assertEqual(quality.route_deal(bad, result, source_class="web"), "drop")

    def strong(self, **over):
        r = self.rec(**{"title": "£3 cask pints", "recurrence": {"type": "weekly", "days": [2]}, **over})
        return r, quality.score_deal(r)

    def test_a_failed_check_never_publishes(self):
        for errors in (["quote_not_found"], ["possible duplicate of happenings 'X' (same venue)"],
                       ["matches dormant row 'X' (same title) -- revive?"], ["commercial_source_review", "date_not_stated"]):
            r, result = self.strong(validation_errors=errors)
            self.assertGreaterEqual(result.score, 90)
            self.assertEqual(quality.route_deal(r, result, source_class="web"), "digest", errors)
        r, result = self.strong(_force_review="possible duplicate of happenings 'X' (same venue)")
        self.assertEqual(quality.route_deal(r, result, source_class="web"), "digest")

    def test_commercial_review_alone_can_publish_if_the_gate_passed(self):
        r, result = self.strong(validation_errors=["commercial_source_review"], extraction_status="pending", _evidence={"deal_quote": "£3 cask pints"})
        self.assertEqual(quality.route_deal(r, result, source_class="web"), "publish")
        r, result = self.strong(validation_errors=["commercial_source_review"], extraction_status="pending")
        self.assertEqual(quality.route_deal(r, result, source_class="web"), "digest")  # not validated, no gate evidence

    def test_social_and_newsletter_never_publish(self):
        r, result = self.strong()
        self.assertEqual(quality.route_deal(r, result, source_class="web"), "publish")
        for source_class in ("social", "newsletter", "anything-else"):
            self.assertEqual(quality.route_deal(r, result, source_class=source_class), "digest")
        low = quality.QualityResult(10, [])
        self.assertEqual(quality.route_deal(r, low, source_class="social"), "drop")

    def test_publish_threshold(self):
        r = self.rec(title="Cheese", extraction_status="validated")
        self.assertEqual(quality.route_deal(r, quality.QualityResult(69, []), source_class="web"), "digest")
        self.assertEqual(quality.route_deal(r, quality.QualityResult(70, []), source_class="web"), "publish")
        self.assertEqual(quality.route_deal(r, quality.QualityResult(40, []), source_class="web"), "digest")
        self.assertEqual(quality.route_deal(r, quality.QualityResult(39, []), source_class="web"), "drop")

    def test_apply_daily_limit(self):
        routed = [quality.RoutedDeal({"slug": f"d{i}"}, quality.QualityResult(score, ["r"]), route)
                  for i, (score, route) in enumerate([(80, "publish"), (95, "publish"), (72, "publish"), (88, "publish"), (60, "digest"), (30, "drop"), (72, "publish")])]
        out = quality.apply_daily_limit(routed, limit=3)
        self.assertEqual([r.route for r in out], ["publish", "publish", "digest", "publish", "digest", "drop", "digest"])
        self.assertEqual(out[2].result.reasons[-1], "over the daily limit of 3: moved to digest")
        self.assertEqual(routed[2].route, "publish")  # input untouched
        self.assertEqual([r.route for r in quality.apply_daily_limit(routed, limit=10)], [r.route for r in routed])
        self.assertEqual([r.route for r in quality.apply_daily_limit(routed, limit=0)].count("publish"), 0)

    def test_ai_rating_caps_but_never_raises(self):
        r, _ = self.strong()
        uncapped = quality.score_deal(r).score
        self.assertGreater(uncapped, 90)
        self.assertEqual(quality.score_deal(r, ai_rating=1).score, 25)
        self.assertEqual(quality.score_deal(r, ai_rating=2).score, 45)
        self.assertEqual(quality.score_deal(r, ai_rating=3).score, 69)
        self.assertEqual(quality.score_deal(r, ai_rating=4).score, uncapped)
        self.assertEqual(quality.score_deal(r, ai_rating=5).score, uncapped)
        self.assertEqual(quality.score_deal(r, ai_rating=None).score, uncapped)
        weak = self.rec(title="Cheese", verified_at=None, extraction_status="pending")  # 46: below the caps for 3, 4 and 5, above the cap for 1
        self.assertEqual(quality.score_deal(weak).score, 46)
        self.assertEqual(quality.score_deal(weak, ai_rating=3).score, 46)
        self.assertEqual(quality.score_deal(weak, ai_rating=5).score, 46)
        self.assertEqual(quality.score_deal(weak, ai_rating=2).score, 45)
        self.assertEqual(quality.score_deal(weak, ai_rating=1).score, 25)
        # a rating of 3 stops a publish
        self.assertEqual(quality.route_deal(r, quality.score_deal(r, ai_rating=3), source_class="web"), "digest")

    def test_rate_relevance_batches_of_25_with_a_fake_client(self):
        prompts = []

        def fake(prompt):
            prompts.append(prompt)
            slugs = [line.split("slug: ")[1].split(" |")[0] for line in prompt.splitlines() if line.startswith("slug: ")]
            ratings = [{"slug": s, "rating": 1 + (int(s[1:]) % 5)} for s in slugs] + [{"slug": "not-asked", "rating": 5}]
            return quality.RatingResult(ratings)

        records = [{"slug": f"s{i}", "title": f"Deal {i}", "venue_name": "V"} for i in range(60)]
        out = quality.rate_relevance(records, fake)
        self.assertEqual(len(prompts), 3)
        self.assertEqual([p.count("slug: ") for p in prompts], [25, 25, 10])
        self.assertEqual(len(out), 60)
        self.assertEqual(out["s7"], 3)
        self.assertNotIn("not-asked", out)
        self.assertIn("student or young professional", quality.RATING_SYSTEM_PROMPT)

    def test_rate_relevance_ignores_bad_answers(self):
        calls = iter([quality.RatingResult([], error="boom"),
                      quality.RatingResult([{"slug": "s26", "rating": 9}, {"slug": "s27", "rating": True}, {"slug": "s28", "rating": 4}])])
        out = quality.rate_relevance([{"slug": f"s{i}", "title": "t"} for i in range(30)], lambda prompt: next(calls))
        self.assertEqual(out, {"s28": 4})

    def test_rating_tool_call_shape_with_a_fake_sdk_client(self):
        seen = {}

        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get_final_message(self):
                block = type("B", (), {"type": "tool_use", "input": {"ratings": [{"slug": "a", "rating": 4}]}})()
                usage = type("U", (), {"input_tokens": 11, "output_tokens": 3})()
                return type("M", (), {"content": [block], "usage": usage})()

        class Client:
            class messages:
                @staticmethod
                def stream(**kw):
                    seen.update(kw)
                    return Stream()

        result = quality.call_rating_tool(Client, "m", "prompt")
        self.assertEqual(result.ratings, [{"slug": "a", "rating": 4}])
        self.assertEqual((result.input_tokens, result.output_tokens), (11, 3))
        self.assertEqual(seen["tool_choice"], {"type": "tool", "name": "submit_ratings"})
        self.assertEqual(seen["thinking"], {"type": "disabled"})

        class Broken:
            class messages:
                @staticmethod
                def stream(**kw):
                    raise RuntimeError("down")

        self.assertIn("down", quality.call_rating_tool(Broken, "m", "p").error)


if __name__ == "__main__":
    unittest.main(verbosity=1)
