"""Run: cd scraper && python3 -m unittest test_saving_figures"""

from __future__ import annotations

import unittest

from record_checks import saving_figures_stated_on_page


class SavingFiguresTest(unittest.TestCase):
    def test_reworded_label_passes_when_its_figure_is_on_the_page(self):
        self.assertTrue(saving_figures_stated_on_page("£1 entry", "Young Scot card holders: £1 Entry"))
        self.assertTrue(saving_figures_stated_on_page("25% off cut and colour", "Students get 25 % off all colour"))
        self.assertTrue(saving_figures_stated_on_page("£11.50 student ticket", "Student £ 11.50 online"))

    def test_every_figure_must_be_on_the_page(self):
        self.assertFalse(saving_figures_stated_on_page("20% off food; £3 pints", "20% off food"))

    def test_a_different_figure_does_not_count(self):
        self.assertFalse(saving_figures_stated_on_page("£6 tickets", "Tickets £60"))
        self.assertFalse(saving_figures_stated_on_page("£6 tickets", "Tickets £6.50"))
        self.assertFalse(saving_figures_stated_on_page("5% off", "15% off"))
        self.assertFalse(saving_figures_stated_on_page("£5.99 tickets", "£5.50 tickets"))

    def test_label_with_no_figure_never_passes_this_way(self):
        self.assertFalse(saving_figures_stated_on_page("Student concession tickets", "Student concession tickets"))
        self.assertFalse(saving_figures_stated_on_page("Under-30 concession", "Under-30 concession"))


if __name__ == "__main__":
    unittest.main()
