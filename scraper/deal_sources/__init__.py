"""Page-grounded deal sources (docs/plans/2026-10-08-event-and-deal-coverage.md §7b).

Each source (registry.py) is discovered (discover.py), fetched politely (fetch.py),
skipped when its page is unchanged (ledger.py), extracted by one DeepSeek forced
tool call per page (extract.py), then run through a strict evidence gate (gate.py).
runner.py orchestrates it for weekly_edinburgh.py.
"""

import sys
from pathlib import Path

# The scraper modules (web_fetch, record_checks, happenings_research, identity, ...)
# are top-level files in scraper/, not a package: make them importable however this
# package is reached (weekly_edinburgh.py, the tests, or a REPL).
_SCRAPER_DIR = str(Path(__file__).resolve().parent.parent)
if _SCRAPER_DIR not in sys.path:
    sys.path.insert(0, _SCRAPER_DIR)
