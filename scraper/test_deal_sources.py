"""Unit tests for scraper/deal_sources (gate, ledger hashing, discover parsing, runner wiring).

Run: python3 scraper/test_deal_sources.py   (stdlib unittest, no network, no API key)
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from deal_sources import gate  # noqa: E402
from deal_sources.discover import parse_sitemap_locs, parse_wp_items, filter_urls  # noqa: E402
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
        p = gate.PageContext(url="u", text="Save 20% on film studio hire this autumn, EH6 6RB. Terms apply to all bookings made online.",
                             single_deal=True, repair_text="Save 20% on film studio hire this autumn, EH6 6RB. Terms apply to all bookings made online.")
        item = {"title": "20% off studio hire", "kind": "deal", "category": "arts",
                "quote": "Save 20% on film studio hire this autumn, EH6 6RB. Terms apply to all bookings",
                "fields": {"saving_label": {"value": "20% off", "quote": "Save 20% on film studio hire this autumn, EH6 6RB. Terms apply to all bookings made online. Extras"}}}
        # label quote has an extra word at the end (9/10... tail only): repairable, and contains 20%
        r = run_gate(item, page=p)
        self.assertTrue(r.ok, r.detail)
        self.assertTrue(p.repaired)
        # when the cut-off part is the figure itself the repair must not rescue it
        p2 = gate.PageContext(url="u", text="Save 20% on film studio hire this autumn EH6 6RB", single_deal=True,
                              repair_text="Save 20% on film studio hire this autumn EH6 6RB")
        item2 = {"title": "30% off studio hire", "kind": "deal", "category": "arts",
                 "quote": "Save 20% on film studio hire this autumn EH6 6RB",
                 "fields": {"saving_label": {"value": "30% off", "quote": "Save 30% on film studio hire this autumn EH6 6RB"}}}
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
        self.assertEqual({s.id for s in SOURCES}, {"forever-edinburgh-offers", "more-by-the-shore", "resident-rewards"})
        self.assertTrue(all(s.status == "shadow" and s.trust == "official" for s in SOURCES))
        with self.assertRaises(ValueError):
            get_sources(["nope"])
        with self.assertRaises(ValueError):
            DealSource("x", "x", "weird", "shadow", {"kind": "urls", "urls": []})


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


class ReportSqlTests(unittest.TestCase):
    def test_approve_sql_covers_verified_rows_and_review_slugs(self):
        import weekly_edinburgh as w
        sql = "\n".join(w.approve_sql("edi-weekly-2026-10-08", ["a-b", "it's"]))
        self.assertIn("batch_id = 'edi-weekly-2026-10-08'", sql)
        self.assertIn("slug in ('a-b', 'it''s')", sql)
        self.assertIn("extraction_status = 'validated' and approved = false", sql)
        self.assertIn("slug in ('')", "\n".join(w.approve_sql("b", [])))


if __name__ == "__main__":
    unittest.main(verbosity=1)
