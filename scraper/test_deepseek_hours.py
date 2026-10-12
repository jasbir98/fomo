"""Tests for scraper/deepseek_hours.py. Run: python3 scraper/test_deepseek_hours.py"""

import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import deepseek_hours  # noqa: E402
from deepseek_hours import DeepSeekPeakHours, in_peak, next_clear_start  # noqa: E402


def utc(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


class PeakWindowTests(unittest.TestCase):
    def test_weekday_windows(self):
        # 2026-10-12 is a Monday.
        self.assertFalse(in_peak(utc("2026-10-12T00:59")))
        self.assertTrue(in_peak(utc("2026-10-12T01:00")))
        self.assertTrue(in_peak(utc("2026-10-12T03:59")))
        self.assertFalse(in_peak(utc("2026-10-12T04:00")))
        self.assertTrue(in_peak(utc("2026-10-12T06:00")))
        self.assertFalse(in_peak(utc("2026-10-12T10:00")))

    def test_weekends_are_off_peak(self):
        self.assertFalse(in_peak(utc("2026-10-10T02:00")))  # Saturday
        self.assertFalse(in_peak(utc("2026-10-11T07:00")))  # Sunday

    def test_next_clear_start_needs_the_whole_run_off_peak(self):
        self.assertEqual(next_clear_start(utc("2026-10-12T11:23"), 60), utc("2026-10-12T11:23"))
        self.assertEqual(next_clear_start(utc("2026-10-12T05:30"), 60), utc("2026-10-12T10:00"))  # 06:00 is too close
        self.assertEqual(next_clear_start(utc("2026-10-12T00:30"), 60), utc("2026-10-12T04:00"))
        self.assertEqual(next_clear_start(utc("2026-10-16T09:00"), 60), utc("2026-10-16T10:00"))  # Friday
        self.assertEqual(next_clear_start(utc("2026-10-17T02:00"), 60), utc("2026-10-17T02:00"))  # Saturday


class ClientGuardTests(unittest.TestCase):
    def test_no_deepseek_client_during_peak(self):
        # Peak "now" (guard() asks with no time); clear for the next-start search.
        import llm_client

        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "k"}), mock.patch.object(deepseek_hours, "in_peak", side_effect=lambda now=None: now is None):
            with self.assertRaises(DeepSeekPeakHours):
                llm_client.make_research_client("test")


if __name__ == "__main__":
    unittest.main()
