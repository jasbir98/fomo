"""Tests for the families lens plumbing: eligibility 'family' and the family_fit field.

Run: python3 -m pytest scraper/test_family_fit.py   (no network, no API key)
"""

from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import happenings_research as hr  # noqa: E402
import upsert_happenings  # noqa: E402
from deal_sources import extract, gate  # noqa: E402
from happenings.cities.edinburgh import EDINBURGH  # noqa: E402

TODAY = date(2026, 10, 20)
KIDS_TEXT = "Kids eat free with every adult main at Canopy Kitchen, 1 Castle Street, Edinburgh EH2 2BS. Every Tuesday."


def kids_page(text: str = KIDS_TEXT) -> gate.PageContext:
    return gate.PageContext(url="https://example.com/kids", text=text, single_deal=True)


def kids_deal(eligibility_quote: str | None = "Kids eat free with every adult main", **over):
    fields = {
        "saving_label": {"value": "Kids eat free", "quote": "Kids eat free"},
        "recurrence": {"value": {"type": "weekly", "days": [2]}, "quote": "Every Tuesday"},
    }
    if eligibility_quote is not None:
        fields["eligibility"] = {"value": "family", "quote": eligibility_quote}
    item = {"title": "Kids eat free at Canopy Kitchen", "kind": "deal", "category": "family",
            "quote": "Kids eat free with every adult main", "fields": fields}
    item.update(over)
    return item


def raw_happening(**over):
    base = {
        "title": "Bookbug at the library", "summary": "Free songs and rhymes for under-5s.",
        "kind": "activity", "category": "family", "scope": "venue", "eligibility": "anyone",
        "recurrence": {"type": "always"}, "source_name": "Edinburgh Libraries",
        "source_url": "https://example.com/bookbug", "source_urls": ["https://example.com/bookbug"],
        "field_sources": {"title": "https://example.com/bookbug"},
    }
    base.update(over)
    return base


def build(**over):
    return hr.build_full_record(raw_happening(**over), "batch", EDINBURGH, "offers", "model", "2026-10-20T00:00:00+00:00")


class SchemaTests(unittest.TestCase):
    def test_eligibility_enum_includes_family_everywhere(self):
        self.assertIn("family", hr.ELIGIBILITY_ENUM)
        self.assertIn("family", gate.ELIGIBILITY_ENUM)
        self.assertEqual(set(hr.ELIGIBILITY_ENUM), set(gate.ELIGIBILITY_ENUM))
        props = hr.HAPPENING_SCHEMA["properties"]
        self.assertIn("family", props["eligibility"]["enum"])

    def test_topic_schema_has_family_fit(self):
        prop = hr.HAPPENING_SCHEMA["properties"]["family_fit"]
        self.assertEqual(prop["enum"], ["kids", "all_ages", None])
        self.assertNotIn("family_fit", hr.HAPPENING_SCHEMA["required"])
        self.assertIn("prefer null", hr.COMMON_RULES.lower().replace("prefer null over guessing", "prefer null"))
        self.assertIn('"family"', hr.COMMON_RULES)

    def test_deal_extractor_schema_has_family_fit(self):
        prop = extract.DEAL_SCHEMA["properties"]["family_fit"]
        self.assertEqual(prop["enum"], ["kids", "all_ages", None])
        self.assertNotIn("family_fit", extract.DEAL_SCHEMA["required"])
        self.assertIn("family", extract.FIELDS_SCHEMA["properties"]["eligibility"]["properties"]["value"]["enum"])
        self.assertIn("family_fit", extract.SYSTEM_PROMPT)

    def test_weekly_prompt_mentions_family_rules(self):
        import weekly_edinburgh as weekly
        prompt = weekly.topic_system_prompt(weekly.TOPICS[0])
        self.assertIn("family_fit", prompt)
        self.assertIn('"family"', prompt)


class BuildRecordTests(unittest.TestCase):
    def test_valid_values_pass_through(self):
        self.assertEqual(build(category="museum", family_fit="all_ages")["family_fit"], "all_ages")
        self.assertEqual(build(category="arts", family_fit="kids")["family_fit"], "kids")

    def test_missing_family_fit_is_null(self):
        self.assertIsNone(build(category="music")["family_fit"])

    def test_invalid_family_fit_is_coerced_to_null_and_row_kept(self):
        for bad in ("toddlers", "KIDS", 3, ["kids"], True):
            record = build(category="music", family_fit=bad)
            self.assertIsNotNone(record, bad)
            self.assertIsNone(record["family_fit"], bad)

    def test_eligibility_family_forces_kids(self):
        self.assertEqual(build(eligibility="family", category="food", family_fit=None)["family_fit"], "kids")
        self.assertEqual(build(eligibility="family", category="food", family_fit="all_ages")["family_fit"], "kids")
        self.assertEqual(build(eligibility="family", category="food", family_fit="nonsense")["family_fit"], "kids")

    def test_category_family_without_family_fit_becomes_kids(self):
        self.assertEqual(build(category="family", family_fit=None)["family_fit"], "kids")
        self.assertEqual(build(category="family", family_fit="nonsense")["family_fit"], "kids")
        self.assertEqual(build(category="family", family_fit="all_ages")["family_fit"], "all_ages")

    def test_eligibility_family_is_a_valid_eligibility(self):
        self.assertEqual(build(eligibility="family", category="food")["eligibility"], "family")


class GateFamilyTests(unittest.TestCase):
    def run_gate(self, item, page=None):
        return gate.gate_deal(item, page or kids_page(), today=TODAY, edinburgh_source=True)

    def test_kids_eat_free_passes_with_family_eligibility(self):
        r = self.run_gate(kids_deal())
        self.assertTrue(r.ok, r.detail)
        self.assertEqual(r.fields["eligibility"], "family")
        self.assertEqual(r.evidence["eligibility"]["quote"], "Kids eat free with every adult main")

    def test_kids_offer_is_not_a_restricted_audience(self):
        self.assertIsNone(gate.restricted_audience("Kids eat free with every adult main."))
        self.assertIsNone(gate.restricted_audience("Children under 5 go free with a paying adult."))
        # ...and an undeclared (anyone) kids offer still passes the gate as before.
        r = self.run_gate(kids_deal(eligibility_quote=None))
        self.assertTrue(r.ok, r.detail)
        self.assertEqual(r.fields["eligibility"], "anyone")

    def test_family_needs_a_verbatim_quote(self):
        self.assertEqual(self.run_gate(kids_deal(eligibility_quote="")).reason, "eligibility_unsupported")
        self.assertEqual(self.run_gate(kids_deal(eligibility_quote="made up text")).reason, "eligibility_unsupported")

    def test_family_without_child_wording_is_rejected(self):
        page = kids_page("Canopy Kitchen, 1 Castle Street, Edinburgh EH2 2BS. £5 off every main. Every Tuesday.")
        item = kids_deal(eligibility_quote="£5 off every main", quote="£5 off every main")
        item["fields"]["saving_label"] = {"value": "£5 off", "quote": "£5 off every main"}
        r = self.run_gate(item, page)
        self.assertEqual((r.ok, r.reason), (False, "eligibility_unsupported"))

    def test_child_wording_in_the_deal_quote_is_enough(self):
        page = kids_page("Canopy Kitchen, EH2 2BS. Under-5s eat free. Every Tuesday. Bring the family.")
        item = kids_deal(eligibility_quote="Bring the family", quote="Under-5s eat free")
        item["fields"]["saving_label"] = {"value": "Under-5s eat free", "quote": "Under-5s eat free"}
        self.assertTrue(self.run_gate(item, page).ok)

    def test_child_wording_variants(self):
        for text in ("Kids eat free", "Kid’s menu", "children under 12", "Child goes free", "Under-5s swim free",
                     "under 5s free", "Toddler sessions", "A family ticket", "Families welcome"):
            self.assertTrue(gate.has_child_wording(text), text)
        for text in ("20% off for students", "Free entry for over 60s", "£5 off every main", "Weekday lunch"):
            self.assertFalse(gate.has_child_wording(text), text)

    def test_scheme_wide_family_eligibility_uses_the_page_statement(self):
        page = kids_page("Children eat free with a paying adult at every venue in this scheme.\n"
                          "Kids eat free with every adult main at Canopy Kitchen, EH2 2BS. Every Tuesday.")
        item = kids_deal(eligibility_quote="")
        r = gate.gate_deal(item, page, today=TODAY, edinburgh_source=True, default_eligibility="family")
        self.assertTrue(r.ok, r.detail)
        self.assertEqual(r.fields["eligibility"], "family")

    def test_to_raw_happening_carries_family_fit_into_a_record(self):
        item = kids_deal(family_fit="kids")
        r = self.run_gate(item)
        raw = gate.to_raw_happening(item, r, source_name="Canopy", page_url="https://example.com/kids")
        self.assertEqual(raw["family_fit"], "kids")
        record = hr.build_full_record(raw, "b", EDINBURGH, "deal-source", "m", "2026-10-20T00:00:00+00:00")
        self.assertEqual((record["eligibility"], record["family_fit"]), ("family", "kids"))
        # the model leaving family_fit out still gets 'kids' from the eligibility post-rule
        item2 = kids_deal()
        raw2 = gate.to_raw_happening(item2, self.run_gate(item2), source_name="Canopy", page_url="https://example.com/kids")
        self.assertIsNone(raw2["family_fit"])
        record2 = hr.build_full_record(raw2, "b", EDINBURGH, "deal-source", "m", "2026-10-20T00:00:00+00:00")
        self.assertEqual(record2["family_fit"], "kids")


class UpsertTests(unittest.TestCase):
    def setUp(self):
        upsert_happenings._family_fit_warned = False

    def record(self, **over):
        return {**build(category="family", family_fit="kids"), **over}

    def post_stub(self, responses):
        calls = []

        def fake_post(url, headers=None, params=None, json=None, timeout=None):
            calls.append(json)
            return responses[len(calls) - 1]
        return calls, fake_post

    def resp(self, status=201, text=""):
        r = mock.Mock()
        r.status_code = status
        r.text = text
        r.raise_for_status.side_effect = RuntimeError("http error") if status >= 300 else None
        return r

    def test_family_fit_is_an_allowed_column(self):
        self.assertIn("family_fit", upsert_happenings.ALLOWED_COLUMNS)
        row = upsert_happenings._clean_row(self.record())
        self.assertEqual(row["family_fit"], "kids")

    def test_null_family_fit_is_not_sent(self):
        row = upsert_happenings._clean_row(self.record(family_fit=None))
        self.assertNotIn("family_fit", row)

    def test_payload_includes_family_fit(self):
        calls, fake_post = self.post_stub([self.resp()])
        with mock.patch.object(upsert_happenings, "_get_credentials", return_value=("http://x", "k")), \
                mock.patch.object(upsert_happenings.requests, "post", fake_post):
            sent = upsert_happenings.upsert_happenings([self.record(slug="a"), self.record(slug="b", family_fit="all_ages")])
        self.assertEqual(sent, 2)
        self.assertEqual({row["slug"]: row["family_fit"] for row in calls[0]}, {"a": "kids", "b": "all_ages"})

    def test_missing_column_retries_without_family_fit_and_warns_once(self):
        err = self.resp(400, '{"code":"PGRST204","message":"Could not find the \'family_fit\' column of \'happenings_staging\' in the schema cache"}')
        calls, fake_post = self.post_stub([err, self.resp(), err, self.resp()])
        with mock.patch.object(upsert_happenings, "_get_credentials", return_value=("http://x", "k")), \
                mock.patch.object(upsert_happenings.requests, "post", fake_post), \
                mock.patch("sys.stderr") as stderr:
            self.assertEqual(upsert_happenings.upsert_happenings([self.record(slug="a")]), 1)
            self.assertEqual(upsert_happenings.upsert_happenings([self.record(slug="b")]), 1)
        self.assertIn("family_fit", calls[0][0])
        self.assertNotIn("family_fit", calls[1][0])
        warnings = [c for c in stderr.write.call_args_list if "family_fit column not found" in str(c)]
        self.assertEqual(len(warnings), 1)

    def test_postgres_42703_is_also_treated_as_missing(self):
        err = self.resp(400, '{"code":"42703","message":"column \\"family_fit\\" of relation \\"happenings_staging\\" does not exist"}')
        calls, fake_post = self.post_stub([err, self.resp()])
        with mock.patch.object(upsert_happenings, "_get_credentials", return_value=("http://x", "k")), \
                mock.patch.object(upsert_happenings.requests, "post", fake_post):
            self.assertEqual(upsert_happenings.upsert_happenings([self.record(slug="a")]), 1)
        self.assertNotIn("family_fit", calls[1][0])

    def test_other_errors_are_not_swallowed(self):
        err = self.resp(400, '{"code":"23502","message":"null value in column \\"title\\" violates not-null constraint"}')
        calls, fake_post = self.post_stub([err])
        with mock.patch.object(upsert_happenings, "_get_credentials", return_value=("http://x", "k")), \
                mock.patch.object(upsert_happenings.requests, "post", fake_post), \
                mock.patch("sys.stderr"):
            with self.assertRaises(RuntimeError):
                upsert_happenings.upsert_happenings([self.record(slug="a")])
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
