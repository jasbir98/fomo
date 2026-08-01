#!/usr/bin/env python3
"""
humanize.py — shared pacing/movement helpers for the batch scraper.

Two things live here:

1. `wait_for_login()` — an actual poll-and-wait loop for "are you logged in
   yet", used both at batch start and to recover mid-batch if a session drops.
   This does NOT automate login or touch credentials; it just waits for you to
   finish logging in yourself in the visible browser window.

2. `human_mouse_move()` / `human_idle()` — small randomized mouse movements
   and pauses dropped between actions so a long batch run doesn't read as a
   metronomic scroll-extract-scroll-extract loop. This is pacing/movement
   texture only: no fingerprint spoofing, no header/UA tricks, no CAPTCHA
   handling, no proxy rotation. Same "no bot-detection evasion" line as the
   rest of scraper/ — see scraper/README.md.
"""

from __future__ import annotations

import random
import sys
import time
from typing import Callable

from playwright.sync_api import Page


def human_mouse_move(page: Page) -> None:
    """Move the mouse to a random point in the viewport in a few small steps."""
    try:
        viewport = page.viewport_size or {"width": 1280, "height": 900}
        target_x = random.randint(40, max(41, viewport["width"] - 40))
        target_y = random.randint(40, max(41, viewport["height"] - 40))
        steps = random.randint(2, 4)
        for _ in range(steps):
            page.mouse.move(
                random.randint(0, viewport["width"]),
                random.randint(0, viewport["height"]),
                steps=random.randint(3, 8),
            )
            time.sleep(random.uniform(0.05, 0.2))
        page.mouse.move(target_x, target_y, steps=random.randint(5, 12))
    except Exception:
        # Never let cosmetic mouse movement break a scrape.
        pass


def human_idle(page: Page, a: float = 1.0, b: float = 3.5, mouse_chance: float = 0.6) -> None:
    """Random pause, occasionally preceded by a mouse move — simulates 'reading' a page."""
    if random.random() < mouse_chance:
        human_mouse_move(page)
    time.sleep(random.uniform(a, b))


def wait_for_login(
    page: Page,
    platform: str,
    home_url: str,
    is_logged_in: Callable[[Page], bool],
    poll_seconds: float = 5.0,
    timeout_seconds: float | None = 900.0,
) -> bool:
    """Navigate to `home_url` and poll until `is_logged_in(page)` is true.

    Prints a one-time instruction, then a quiet progress dot every poll. This
    replaces a single check-and-bail with an actual wait — intended for both
    the start of a batch run and recovering mid-batch if a session drops.

    Returns True once logged in. Returns False if `timeout_seconds` elapses
    first (pass None to wait indefinitely).
    """
    page.goto(home_url, wait_until="domcontentloaded")
    time.sleep(2.0)

    if is_logged_in(page):
        return True

    print(
        f"\n[wait] Not logged into {platform} yet. Log in normally in the browser "
        f"window that opened — this will keep waiting and continue automatically "
        f"once you're in.",
        flush=True,
    )

    start = time.monotonic()
    while True:
        elapsed = time.monotonic() - start
        if timeout_seconds is not None and elapsed > timeout_seconds:
            print(f"\n[wait] Timed out waiting for {platform} login after {int(elapsed)}s.", file=sys.stderr)
            return False

        time.sleep(poll_seconds)
        try:
            if is_logged_in(page):
                print(f"\n[wait] {platform} login detected — continuing.", flush=True)
                return True
        except Exception:
            pass
        print(".", end="", flush=True)
