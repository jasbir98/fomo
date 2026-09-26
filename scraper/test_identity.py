"""Regression cases for scraper/identity.py. Run: python3 scraper/test_identity.py

Each case is a real pair seen in the live catalogue (2026-09-26) or a
paraphrase the research LLM is known to produce. Expected verdicts are
"match" (reuse the slug), "possible" (review) or None (unrelated).
"""

from identity import Catalogue

KNOWN = [
    {"id": "1", "slug": "stand-fri", "title": "The Friday Show at The Stand Edinburgh", "kind": "event", "status": "live",
     "recurrence": {"type": "weekly", "days": [5]}, "venue_name": "The Stand Comedy Club"},
    {"id": "2", "slug": "stand-sat", "title": "The Saturday Show at The Stand Edinburgh", "kind": "event", "status": "live",
     "recurrence": {"type": "weekly", "days": [6]}, "venue_name": "The Stand Comedy Club"},
    {"id": "3", "slug": "co-20", "title": "Camera Obscura 20% off off-peak tickets", "kind": "deal", "status": "live",
     "saving_label": "20% off", "venue_name": "Camera Obscura and World of Illusions"},
    {"id": "4", "slug": "fringe-2026", "title": "Edinburgh Festival Fringe 2026", "kind": "festival", "status": "dormant"},
    {"id": "5", "slug": "beltane", "title": "Beltane Fire Festival", "kind": "event", "status": "dormant", "venue_name": "Calton Hill"},
    {"id": "6", "slug": "holyrood-parkrun", "title": "Holyrood parkrun around Arthur's Seat", "kind": "activity", "status": "live",
     "recurrence": {"type": "weekly", "days": [6]}, "venue_name": "Holyrood Park"},
    {"id": "7", "slug": "nms-free", "title": "Free Entry at National Museum of Scotland", "kind": "free_access", "status": "live",
     "venue_name": "National Museum of Scotland"},
    {"id": "8", "slug": "afore", "title": "Night Afore Party with The Fratellis", "kind": "event", "status": "live",
     "starts_at": "2026-12-30T19:00:00Z", "venue_name": "Princes Street Gardens"},
]
EVENTS = [{"id": "e1", "name": "Fontaines D.C.", "starts_at": "2026-11-02T19:00:00Z", "venue_name": "Usher Hall"}]

CASES = [
    ({"title": "Friday Night Comedy Show at The Stand", "kind": "event", "recurrence": {"type": "weekly", "days": [5]}, "venue_name": "The Stand"}, "match", "stand-fri"),
    ({"title": "Friday Night Comedy Show at The Stand", "kind": "event", "recurrence": {"type": "weekly", "days": [6]}, "venue_name": "The Stand"}, None, None),
    ({"title": "Camera Obscura: 20% off off-peak", "kind": "deal", "saving_label": "20% off"}, "match", "co-20"),
    ({"title": "Camera Obscura Kids Go Free for Locals", "kind": "deal", "venue_name": "Camera Obscura"}, None, None),
    ({"title": "Camera Obscura 2-for-1 tickets", "kind": "deal", "saving_label": "2 for 1"}, None, None),
    ({"title": "Edinburgh Festival Fringe 2027", "kind": "festival"}, None, None),
    ({"title": "Samhuinn Fire Festival 2026", "kind": "event", "venue_name": "Calton Hill"}, "possible", "beltane"),
    ({"title": "Holyrood parkrun", "kind": "activity", "recurrence": {"type": "weekly", "days": [6]}}, "possible", "holyrood-parkrun"),
    ({"title": "Free Entry at National War Museum", "kind": "free_access", "venue_name": "National War Museum"}, None, None),
    ({"title": "Edinburgh's Hogmanay Night Afore Party ft. The Fratellis", "kind": "event", "starts_at": "2026-12-30T20:00:00Z",
      "venue_name": "Princes Street Gardens"}, "match", "afore"),
    ({"title": "Fontaines D.C. live", "kind": "event", "starts_at": "2026-11-02T20:00:00Z", "venue_name": "Usher Hall"}, "match", "events:e1"),
    ({"title": "Fontaines D.C.", "kind": "event", "starts_at": "2026-11-09T20:00:00Z", "venue_name": "Usher Hall"}, None, None),
]


def main() -> int:
    catalogue = Catalogue(KNOWN, EVENTS)
    failures = 0
    for record, want_verdict, want_target in CASES:
        found = catalogue.best_match(record)
        got_verdict = found.verdict if found else None
        got_target = None
        if found:
            got_target = found.entry.slug if found.entry.table == "happenings" else f"events:{found.entry.id}"
        ok = got_verdict == want_verdict and (want_target is None or got_target == want_target)
        failures += not ok
        print(("ok  " if ok else "FAIL"), record["title"][:55].ljust(56), got_verdict, got_target, found.why if found else "")
    print(f"{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
