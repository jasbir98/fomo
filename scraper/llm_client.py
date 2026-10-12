"""
llm_client.py — the one place that decides which LLM provider the research
scripts talk to, and how their calls must be shaped to work on it.

Both research pipelines (discover_and_extract_city.py / run_city_batch.py for
places, happenings_research.py for happenings) are built on the Anthropic
Messages API plus the server-side `web_search` tool. They can run against
either Anthropic or DeepSeek's Anthropic-compatible endpoint, because DeepSeek
supports that tool there.

Verified live on 2026-09-13, not taken from docs alone:
  - `deepseek-flash` (DeepSeek V4.1 Flash) at https://api.deepseek.com/anthropic
    ran real searches with BOTH `web_search_20250305` and `web_search_20260209`
    (server_tool_use + web_search_tool_result blocks, usage reported
    web_search_requests=2, real result URLs, correct answer) — with thinking
    on and with thinking off.
  - DeepSeek's Responses API does NOT search — its compatibility table lists
    web_search as ignored. Only the Anthropic-compatible endpoint works.

Three DeepSeek quirks every caller must respect:
  1. Thinking is on by default and CANNOT be bounded: the Anthropic-compatible
     API ignores `thinking.budget_tokens`. In the first live Old Town run,
     thinking consumed the 8,000-token research budget and cut the response off
     mid-search. Research calls therefore pass RESEARCH_CALL_KWARGS (thinking
     off). This also restores the pipeline's original design, which was built
     around Claude Haiku without extended thinking.
  2. Thinking mode rejects a forced `tool_choice={"type": "tool", ...}` with a
     400 ("Thinking mode does not support this tool_choice"). Every forced submit
     call passes SUBMIT_CALL_KWARGS. Tested on the real two-phase flow; returned
     correct structured output. Disabling thinking is equally valid on Anthropic,
     so both kwargs are provider-agnostic.
  3. A response cut off at max_tokens can end with a search call that never got
     its result. DeepSeek then rejects the whole history on the next call:
     400 "`tool_use` ids were found without `tool_result` blocks". Call
     sanitize_history() on the conversation before the submit phase. Reproduced
     deterministically and verified fixed. This guard is worth having on
     Anthropic too, since any max_tokens cut can strand a tool call.

Also: DeepSeek silently maps unknown model names to `deepseek-flash` rather than
erroring, so a typo'd model string will not fail loudly. The model name is
printed at startup for that reason — check it.

Key loading: `scraper/.env` first (the existing scraper convention), then the
app's `.env.local` as a fallback, because that is where DEEPSEEK_API_KEY lives.
`override=False` means scraper/.env wins on any conflict. Keys are only ever
read from the environment here — never logged, never written anywhere.

Provider precedence: DeepSeek whenever DEEPSEEK_API_KEY is set, otherwise
Anthropic. DeepSeek goes first deliberately: scraper/.env still holds an
ANTHROPIC_API_KEY that was revoked, so preferring Anthropic would fail every run.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from deepseek_hours import guard as guard_deepseek_hours

SCRAPER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRAPER_DIR.parent

load_dotenv(SCRAPER_DIR / ".env")
load_dotenv(REPO_ROOT / ".env.local", override=False)

DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic"
# DeepSeek's official ID for V4.1 Flash. Not "deepseek-v4.1-flash" (a
# third-party platform ID) — "deepseek-v4-flash" is only a temporary legacy
# alias. See https://api-docs.deepseek.com/updates/
DEEPSEEK_DEFAULT_MODEL = "deepseek-flash"
ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5"

# Pass on every research call. See quirk 1.
RESEARCH_CALL_KWARGS: dict[str, Any] = {"thinking": {"type": "disabled"}}

# Pass on every forced-tool_choice submit call. See quirk 2.
SUBMIT_CALL_KWARGS: dict[str, Any] = {"thinking": {"type": "disabled"}}

_TOOL_CALL_TYPES = ("server_tool_use", "tool_use")
_TOOL_RESULT_TYPES = ("web_search_tool_result", "tool_result")


def research_provider() -> str:
    """'deepseek', 'anthropic', or 'none' — decided purely by which key is set."""
    if os.environ.get("DEEPSEEK_API_KEY", "").strip():
        return "deepseek"
    if os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return "anthropic"
    return "none"


def default_research_model() -> str:
    """The default --model for whichever provider is active."""
    return DEEPSEEK_DEFAULT_MODEL if research_provider() == "deepseek" else ANTHROPIC_DEFAULT_MODEL


def make_research_client(tag: str) -> tuple[Any, str]:
    """
    Build an Anthropic SDK client for the active provider.

    Returns (client, provider). Exits with a clear message when no key is set.
    Imports `anthropic` lazily so a --dry-run never needs it installed.
    """
    provider = research_provider()
    if provider == "none":
        print(
            f"[{tag}] no API key found. Set DEEPSEEK_API_KEY (in .env.local or "
            "scraper/.env), or ANTHROPIC_API_KEY in scraper/.env.",
            file=sys.stderr,
        )
        sys.exit(1)

    from anthropic import Anthropic

    if provider == "deepseek":
        guard_deepseek_hours()  # raises DeepSeekPeakHours during DeepSeek's peak windows
        return Anthropic(api_key=os.environ["DEEPSEEK_API_KEY"].strip(), base_url=DEEPSEEK_BASE_URL), provider
    return Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"].strip()), provider


def _to_plain(value: Any) -> Any:
    """Convert SDK/Pydantic values without calling ``model_dump``.

    DeepSeek occasionally returns a ``web_search_tool_result`` whose
    ``content`` is a list containing ``WebSearchToolResultError``.  The
    current Anthropic SDK's generated union says that field is one result
    block, not a list, so ``model_dump`` emits a Pydantic warning while it
    tries (and fails) to serialise it.  Reading Pydantic's already-validated
    ``__dict__`` directly preserves the wire fields without exercising that
    invalid union serializer.
    """
    if isinstance(value, dict):
        return {key: _to_plain(item) for key, item in value.items() if item is not None}
    if isinstance(value, (list, tuple)):
        return [_to_plain(item) for item in value]
    fields = getattr(value, "__dict__", None)
    if isinstance(fields, dict):
        return {
            key: _to_plain(item)
            for key, item in fields.items()
            if not key.startswith("_") and item is not None
        }
    return value


def _plain(block: Any) -> dict[str, Any]:
    """SDK content block -> plain wire-shaped dictionary, warning-free."""
    value = _to_plain(block)
    return value if isinstance(value, dict) else {}


def _failed_search_result(block: dict[str, Any]) -> bool:
    """Whether a server-search result is an error rather than usable context."""
    if block.get("type") != "web_search_tool_result":
        return False

    def has_error(value: Any) -> bool:
        if isinstance(value, dict):
            kind = str(value.get("type") or "")
            return kind.endswith("_error") or any(has_error(item) for item in value.values())
        if isinstance(value, list):
            return any(has_error(item) for item in value)
        return False

    return has_error(block.get("content"))


def sanitize_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Return a copy of the conversation with every tool call that has no matching
    result removed from assistant turns. See quirk 3.

    Call ONCE, immediately before the submit phase — never between pause_turn
    resumes, where the assistant content must be sent back exactly as received
    so the server-side search loop can continue.

    Result ids are gathered across the whole history, so this is also correct
    for client tools whose results arrive in the following user turn. An
    assistant turn left empty by the pruning gets a one-line placeholder, since
    an empty content list is itself a validation error.
    """
    plain_messages = [
        {**message, "content": [_plain(block) for block in message["content"]]}
        if isinstance(message.get("content"), list) else message
        for message in messages
    ]
    failed_result_ids = {
        block.get("tool_use_id")
        for message in plain_messages
        if isinstance(message.get("content"), list)
        for block in message["content"]
        if _failed_search_result(block)
    }
    result_ids = {
        block.get("tool_use_id")
        for message in plain_messages
        if isinstance(message.get("content"), list)
        for block in message["content"]
        if block.get("type") in _TOOL_RESULT_TYPES and block.get("tool_use_id") not in failed_result_ids
    }

    cleaned: list[dict[str, Any]] = []
    for message in plain_messages:
        if message.get("role") != "assistant" or not isinstance(message.get("content"), list):
            cleaned.append(message)
            continue
        kept = [
            block
            for block in message["content"]
            if not (
                (block.get("type") in _TOOL_CALL_TYPES and block.get("id") not in result_ids)
                or (block.get("type") in _TOOL_RESULT_TYPES and block.get("tool_use_id") in failed_result_ids)
            )
        ]
        cleaned.append(
            {**message, "content": kept or [{"type": "text", "text": "(research was cut off before any results)"}]}
        )
    return cleaned
