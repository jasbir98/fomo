#!/usr/bin/env python3
"""
browser_session.py — one place that knows how to get a usable, logged-in
browser for the scrapers.

Why this exists
---------------
Logging into TikTok inside Playwright's *bundled Chromium* often just dies:
the SMS/phone form accepts the number and never sends (or loops back to the
form), and the QR flow shows "approved" on the phone while the desktop page
never advances. That is not a captcha and not something to bypass — it's that
the bundled Chromium is a stripped build (no proprietary codecs, no Widevine,
no Chrome branding, and Playwright's own launch flags mark it as automated),
and TikTok's login endpoints behave badly on it.

The fix is not to disguise the bundled browser. The fix is to stop using it
and drive a REAL Google Chrome instead. Three modes, in order of reliability:

  1. "attach" (default, recommended) — we start (or reuse) a normal Google
     Chrome with `--remote-debugging-port` on its own profile directory, you
     log in in that window like a human, and Playwright connects to it over
     CDP and drives a tab. No automation launch flags, no patched binary:
     it is the same Chrome you use every day, just with devtools listening.
     `navigator.webdriver` is false here because nothing set it.

  2. "channel" — Playwright launches real Chrome itself
     (`channel="chrome"`) with a persistent profile. Real Chrome binary, but
     still launched by automation. Better than bundled Chromium, worse than
     attach. Use with `--browser-mode channel` if attach can't work for you.

  3. "chromium" — the old behavior (bundled Chromium). Kept so nothing that
     depended on it breaks; expect the login trouble described above.

Nothing here spoofs a fingerprint, patches `navigator`, rotates proxies, or
touches a captcha. It picks which real browser to use and waits for you to
log in yourself — the same rules as the rest of scraper/ (see README.md).

Login detection is cookie-based (`sessionid` on the right domain), with the
DOM only as a fallback: TikTok renders a `profile-icon` element on logged-OUT
pages, so a DOM-first check reports "logged in" when you aren't and the batch
then scrapes nothing for hours.

Attach mode uses one shared Chrome profile for both platforms — log into
TikTok and Instagram in the same window, same as you would normally.

Standalone use — log in once, then run batches later:

    python scraper/browser_session.py --platform tiktok
    python scraper/browser_session.py --platform instagram --browser-mode channel
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from playwright.sync_api import Browser, BrowserContext, Page, Playwright, sync_playwright

SCRAPER_DIR = Path(__file__).resolve().parent
PROFILE_ROOT = SCRAPER_DIR / ".pw-profile"

BROWSER_MODES = ("attach", "channel", "chromium")
DEFAULT_BROWSER_MODE = "attach"
DEFAULT_CDP_PORT = 9222

# Chrome 136+ refuses --remote-debugging-port when pointed at the *default*
# user profile, so attach mode always uses its own directory under here. One
# shared profile for every platform, deliberately: it's a single browser you
# log into both sites in, and a Chrome already listening on the CDP port gets
# reused whatever profile it was started with — per-platform dirs would just
# be a lie the second platform silently ignores.
ATTACH_PROFILE_ROOT = PROFILE_ROOT / "chrome-attach"
DEFAULT_ATTACH_PROFILE = ATTACH_PROFILE_ROOT / "default"

CHROME_CANDIDATES_DARWIN = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)
CHROME_CANDIDATES_LINUX = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
)
CHROME_CANDIDATES_WIN = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)


# ---------------------------------------------------------------- login checks


def _cookie_present(context: BrowserContext, domain_fragment: str, names: Sequence[str]) -> bool:
    """True if any non-empty cookie in `names` exists on a matching domain.

    Far more durable than a DOM probe: TikTok/Instagram reshuffle their markup
    constantly but the session cookie name is stable.
    """
    try:
        cookies = context.cookies()
    except Exception:
        return False
    for cookie in cookies:
        if cookie.get("name") not in names:
            continue
        if domain_fragment not in (cookie.get("domain") or ""):
            continue
        if cookie.get("value"):
            return True
    return False


def _count(page: Page, selector: str) -> int:
    try:
        return page.locator(selector).count()
    except Exception:
        return 0


# TikTok renders `[data-e2e="profile-icon"]` on logged-OUT pages too, so a
# DOM-only check false-positives. The session cookie is the real signal; the
# DOM is only consulted as a fallback, and only when there is no visible
# "Log in" affordance to contradict it.
TIKTOK_LOGIN_AFFORDANCE = (
    '[data-e2e="top-login-button"], div[data-e2e="modal-login-title"], '
    'button:has-text("Log in"), a[href*="/login"]'
)
TIKTOK_ACCOUNT_ONLY = 'a[href*="/upload"], [data-e2e="nav-profile"]'

INSTAGRAM_LOGIN_AFFORDANCE = (
    'form#loginForm, input[name="password"], a[href*="/accounts/login"]'
)
INSTAGRAM_ACCOUNT_ONLY = 'svg[aria-label="Home"], a[href="/direct/inbox/"]'


def tiktok_logged_in(page: Page) -> bool:
    if _cookie_present(page.context, "tiktok.com", ("sessionid", "sessionid_ss")):
        return True
    if _count(page, TIKTOK_LOGIN_AFFORDANCE) > 0:
        return False
    return _count(page, TIKTOK_ACCOUNT_ONLY) > 0


def instagram_logged_in(page: Page) -> bool:
    if _cookie_present(page.context, "instagram.com", ("sessionid",)):
        return True
    if "accounts/login" in page.url or _count(page, INSTAGRAM_LOGIN_AFFORDANCE) > 0:
        return False
    return _count(page, INSTAGRAM_ACCOUNT_ONLY) > 0


PLATFORMS = {
    "tiktok": {
        "login_url": "https://www.tiktok.com/login",
        "home_url": "https://www.tiktok.com/foryou",
        "logged_in": tiktok_logged_in,
    },
    "instagram": {
        "login_url": "https://www.instagram.com/accounts/login/",
        "home_url": "https://www.instagram.com/",
        "logged_in": instagram_logged_in,
    },
}


# ------------------------------------------------------------ chrome discovery


def find_chrome(explicit: str | None = None) -> str | None:
    """Locate a real Google Chrome executable, or None."""
    if explicit:
        return explicit if Path(explicit).exists() else None

    if sys.platform == "darwin":
        candidates = CHROME_CANDIDATES_DARWIN
    elif sys.platform.startswith("win"):
        candidates = CHROME_CANDIDATES_WIN
    else:
        candidates = CHROME_CANDIDATES_LINUX

    for candidate in candidates:
        if "/" in candidate or "\\" in candidate:
            if Path(candidate).exists():
                return candidate
        else:
            found = shutil.which(candidate)
            if found:
                return found
    return None


def _cdp_alive(port: int, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=timeout):
            return True
    except (urllib.error.URLError, OSError):
        return False


def _page_target_count(port: int, timeout: float = 2.0) -> int:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=timeout) as resp:
            targets = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return 0
    return sum(1 for t in targets if t.get("type") == "page")


def _open_blank_tab(port: int, timeout: float = 5.0) -> bool:
    """Ask a running Chrome to open a tab via the HTTP DevTools endpoint.

    Needed because on macOS closing the last window leaves Chrome running with
    zero targets, and Playwright's `connect_over_cdp` then fails outright with
    "Browser context management is not supported". Chrome 111+ requires PUT
    for /json/new.
    """
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout):
            return True
    except (urllib.error.URLError, OSError):
        return False


def ensure_chrome_with_cdp(
    port: int,
    user_data_dir: Path,
    chrome_path: str | None = None,
    startup_timeout: float = 45.0,
) -> subprocess.Popen | None:
    """Make sure a real Chrome is listening for CDP on `port`.

    Reuses one that's already listening (returns None); otherwise spawns one
    on `user_data_dir` and returns the process so the caller can decide
    whether to leave it running. Leaving it running is usually what you want —
    the login stays warm for the next batch.
    """
    if _cdp_alive(port):
        print(f"[browser] reusing the Chrome already listening on port {port}.")
        if _page_target_count(port) == 0:
            # Zero open tabs — reconnecting would fail, so give it one.
            if not _open_blank_tab(port):
                raise RuntimeError(
                    f"Chrome on port {port} has no open tabs and wouldn't open one. "
                    f"Open a tab in that Chrome window (or quit it and re-run) and try again."
                )
            time.sleep(1.0)
        return None

    executable = find_chrome(chrome_path)
    if not executable:
        raise RuntimeError(
            "Couldn't find Google Chrome. Install it, or pass --chrome-path /path/to/chrome, "
            "or use --browser-mode chromium to fall back to Playwright's bundled build."
        )

    user_data_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        executable,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        # Chrome only exposes CDP on localhost; this keeps the new window from
        # being folded into an existing Chrome session on some platforms.
        "--new-window",
        "about:blank",
    ]
    print(f"[browser] starting Chrome (profile: {user_data_dir}, CDP port: {port})")
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    deadline = time.monotonic() + startup_timeout
    while time.monotonic() < deadline:
        if _cdp_alive(port):
            return proc
        if proc.poll() is not None:
            raise RuntimeError(
                f"Chrome exited immediately (code {proc.returncode}). If another Chrome is "
                f"already using {user_data_dir}, quit it first or pass a different "
                f"--chrome-user-data-dir."
            )
        time.sleep(0.5)

    proc.terminate()
    raise RuntimeError(f"Chrome didn't open a CDP endpoint on port {port} within {startup_timeout:.0f}s.")


# ------------------------------------------------------------------- sessions


@dataclass
class BrowserSession:
    """A live browser + page, however it was obtained."""

    page: Page
    context: BrowserContext
    mode: str
    browser: Browser | None = None
    proc: subprocess.Popen | None = None

    def close(self, keep_browser: bool = True) -> None:
        """Close what we own.

        In attach mode the browser belongs to you, not to this script, so we
        just park our tab on about:blank and disconnect — Chrome stays open
        with the session live for the next run. We deliberately do NOT close
        the tab: on macOS that can leave Chrome running with zero targets,
        and a Chrome with no targets refuses the next CDP connection. Pass
        keep_browser=False to also shut down a Chrome that we spawned.
        """
        if self.mode == "attach":
            try:
                self.page.goto("about:blank", wait_until="domcontentloaded", timeout=5000)
            except Exception:
                pass
            try:
                if self.browser:
                    self.browser.close()  # disconnects CDP; doesn't kill Chrome
            except Exception:
                pass
            if not keep_browser and self.proc is not None:
                try:
                    self.proc.terminate()
                    self.proc.wait(timeout=10)
                except Exception:
                    pass
            return

        try:
            self.page.close()
        except Exception:
            pass

        try:
            self.context.close()
        except Exception:
            pass


def open_session(
    pw: Playwright,
    platform: str,
    mode: str = DEFAULT_BROWSER_MODE,
    headless: bool = False,
    cdp_port: int = DEFAULT_CDP_PORT,
    chrome_user_data_dir: Path | None = None,
    chrome_path: str | None = None,
    profile_dir: Path | None = None,
) -> BrowserSession:
    """Open a browser session for `platform` using the requested `mode`."""
    if mode not in BROWSER_MODES:
        raise ValueError(f"unknown browser mode {mode!r}, expected one of {BROWSER_MODES}")

    if mode == "attach":
        if headless:
            print(
                "[browser] note: --headless is ignored in attach mode (you're driving a real "
                "Chrome window). Use --browser-mode channel for a headless run.",
                file=sys.stderr,
            )
        user_data_dir = chrome_user_data_dir or DEFAULT_ATTACH_PROFILE
        proc = ensure_chrome_with_cdp(cdp_port, user_data_dir, chrome_path)
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp_port}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        # Reuse the blank startup tab rather than piling up windows.
        page = next(
            (p for p in context.pages if p.url in ("about:blank", "chrome://newtab/")),
            None,
        ) or context.new_page()
        print("[browser] attached to real Chrome over CDP.")
        return BrowserSession(page=page, context=context, mode=mode, browser=browser, proc=proc)

    resolved_profile = profile_dir or (PROFILE_ROOT / platform)
    resolved_profile.mkdir(parents=True, exist_ok=True)

    launch_kwargs: dict = {
        "headless": headless,
        "viewport": {"width": 1280, "height": 900},
    }
    if mode == "channel":
        launch_kwargs["channel"] = "chrome"
        if chrome_path:
            launch_kwargs["executable_path"] = chrome_path
            launch_kwargs.pop("channel")

    try:
        context = pw.chromium.launch_persistent_context(str(resolved_profile), **launch_kwargs)
    except Exception as exc:
        if mode != "channel":
            raise
        print(
            f"[browser] couldn't launch real Chrome via channel=chrome ({exc}); "
            f"falling back to bundled Chromium. Logging in may be unreliable — "
            f"consider --browser-mode attach.",
            file=sys.stderr,
        )
        launch_kwargs.pop("channel", None)
        context = pw.chromium.launch_persistent_context(str(resolved_profile), **launch_kwargs)

    page = context.pages[0] if context.pages else context.new_page()
    print(f"[browser] launched {'real Chrome' if mode == 'channel' else 'bundled Chromium'} "
          f"(profile: {resolved_profile})")
    return BrowserSession(page=page, context=context, mode=mode)


# ------------------------------------------------------------------ login wait


def wait_for_login(
    page: Page,
    platform: str,
    poll_seconds: float = 3.0,
    timeout_seconds: float | None = None,
    go_to_login: bool = True,
) -> bool:
    """Navigate to the platform and wait until you've logged in yourself.

    Does not automate login, fill credentials, or touch a captcha — it opens
    the page and polls a cookie check until you're in. `timeout_seconds=None`
    waits indefinitely (the sane default for an interactive run where you may
    need to go find your phone).
    """
    config = PLATFORMS[platform]
    checker: Callable[[Page], bool] = config["logged_in"]

    try:
        page.goto(config["home_url"], wait_until="domcontentloaded")
        time.sleep(2.0)
    except Exception as exc:
        print(f"[wait] couldn't load {config['home_url']}: {exc}", file=sys.stderr)

    if checker(page):
        print(f"[wait] {platform}: already logged in.")
        return True

    if go_to_login:
        try:
            page.goto(config["login_url"], wait_until="domcontentloaded")
        except Exception:
            pass

    how_long = (
        "This will keep waiting (no timeout)"
        if timeout_seconds is None
        else f"This will wait up to {int(timeout_seconds)}s"
    )
    print(
        f"\n[wait] Not logged into {platform} yet.\n"
        f"[wait] Log in normally in the Chrome window that just opened. {how_long}\n"
        f"[wait] and continue on its own once the session cookie appears.\n"
        f"[wait] Ctrl-C to give up.\n",
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
            if checker(page):
                print(f"\n[wait] {platform} login detected — continuing.", flush=True)
                return True
        except Exception:
            pass
        print(".", end="", flush=True)


def add_browser_args(parser: argparse.ArgumentParser) -> None:
    """Shared browser/login CLI flags, so every entry point stays consistent."""
    parser.add_argument(
        "--browser-mode",
        choices=BROWSER_MODES,
        default=DEFAULT_BROWSER_MODE,
        help=(
            "attach (default): drive your real Chrome over CDP — most reliable for login. "
            "channel: let Playwright launch real Chrome. "
            "chromium: Playwright's bundled Chromium (login often fails on TikTok)."
        ),
    )
    parser.add_argument("--cdp-port", type=int, default=DEFAULT_CDP_PORT, help="CDP port for attach mode.")
    parser.add_argument(
        "--chrome-user-data-dir",
        type=Path,
        default=None,
        help="Chrome profile dir for attach mode (default: scraper/.pw-profile/chrome-attach/default, shared by both platforms).",
    )
    parser.add_argument("--chrome-path", default=None, help="Explicit Chrome executable path.")
    parser.add_argument(
        "--close-browser",
        action="store_true",
        help="In attach mode, also quit the Chrome this script started when the run ends.",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Open a browser and wait for you to log into TikTok/Instagram, so later batch runs start already authenticated."
    )
    parser.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    parser.add_argument("--headless", action="store_true", default=False)
    add_browser_args(parser)
    args = parser.parse_args()

    with sync_playwright() as pw:
        session = open_session(
            pw,
            args.platform,
            mode=args.browser_mode,
            headless=args.headless,
            cdp_port=args.cdp_port,
            chrome_user_data_dir=args.chrome_user_data_dir,
            chrome_path=args.chrome_path,
        )
        try:
            ok = wait_for_login(session.page, args.platform)
        except KeyboardInterrupt:
            print("\n[browser] cancelled.")
            ok = False
        finally:
            session.close(keep_browser=not args.close_browser)

    if ok:
        print(
            f"[browser] {args.platform} session is live. Run the batch scraper with the same "
            f"--browser-mode and it will pick this up:\n"
            f"    python scraper/scrape_places_batch.py --platform {args.platform}"
        )
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
