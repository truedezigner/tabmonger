from __future__ import annotations

import re
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]


class DashboardPolishTests(unittest.TestCase):
    def test_search_action_hover_keeps_the_rounded_right_edge(self) -> None:
        css = (PROJECT / "public" / "search-polish.css").read_text(encoding="utf-8")
        match = re.search(r"#search-submit:hover\s*\{(?P<body>.*?)\}", css, re.S)
        self.assertIsNotNone(match)
        body = match.group("body")
        self.assertIn("border-top-right-radius: 16px", body)
        self.assertIn("border-bottom-right-radius: 16px", body)


if __name__ == "__main__":
    unittest.main()
