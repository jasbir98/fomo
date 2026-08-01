#!/usr/bin/env python3
"""
japan_place_extract.py — extracts cited Japan place records from approved
source URLs into Roameo's places_staging JSON shape.

The LLM is deliberately limited to extraction, normalization, and short neutral
descriptions. Google Places / Wikidata should still be used outside this script
for identity, coordinates, ratings, and other API-shaped facts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

SCRAPER_DIR = Path(__file__).resolve().parent
load_dotenv(SCRAPER_DIR / ".env")

DEFAULT_MODEL = "claude-haiku-4-5"
MAX_SOURCE_CHARS = 12000


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = " ".join(data.split())
        if text:
            self._chunks.append(text)

    def text(self) -> str:
        return "\n".join(self._chunks)


def clean_text(html: str) -> str:
    parser = TextExtractor()
    parser.feed(html)
    return parser.text()


def fetch_source(url: str, timeout: int) -> dict[str, str]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"unsupported URL scheme: {url}")

    headers = {
        "User-Agent": "RoameoJapanPlacePilot/0.1 (+personal research; low-volume)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    response = requests.get(url, headers=headers, timeout=timeout)
    response.raise_for_status()
    text = clean_text(response.text)
    return {"url": url, "text": text[:MAX_SOURCE_CHARS]}


def normalize_key(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unknown"


def build_dedupe_key(record: dict[str, Any]) -> str:
    google_place_id = (record.get("google_place_id") or "").strip()
    if google_place_id:
        return f"google:{google_place_id}"

    name = normalize_key(str(record.get("name") or ""))
    prefecture = normalize_key(str(record.get("prefecture") or ""))
    city = normalize_key(str(record.get("city") or ""))
    return f"name:{prefecture}:{city}:{name}"


SYSTEM_PROMPT = """You extract structured Japan place data for Roameo.

Rules:
- Return JSON only with a top-level records array.
- Every factual field must be supported by a source URL.
- If a field is not explicitly supported, set it to null or "unknown".
- Do not copy source prose. Write short neutral descriptions from cited facts.
- Do not infer opening hours, coordinates, ratings, station proximity, or photo license.
- Do not use Reddit, TripAdvisor, TikTok, Instagram, or review text as factual truth.
- Photos must include url, license, credit, and source_url. If any are missing, set photo to null.
- Tips must be practical and source-backed, not marketing copy.
"""


def build_user_prompt(batch: dict[str, Any], sources: list[dict[str, str]]) -> str:
    source_blocks = []
    for index, source in enumerate(sources, start=1):
        source_blocks.append(f"SOURCE {index}: {source['url']}\n{source['text']}")

    requested_places = json.dumps(batch.get("places", []), ensure_ascii=False, indent=2)
    return f"""Batch metadata:
batch_id: {batch.get('batch_id')}
region: {batch.get('region')}
prefectures: {batch.get('prefectures')}

Requested candidate places:
{requested_places}

Output each accepted record in this shape:
{{
  "batch_id": string,
  "region": string | null,
  "prefecture": string,
  "city": string | null,
  "country": "JP",
  "name": string,
  "category": string | null,
  "description": string | null,
  "tips": [{{"text": string, "source_url": string}}],
  "hours": string | "unknown",
  "hours_status": "known" | "unknown" | "stale",
  "station": string | null,
  "google_place_id": string | null,
  "lat": number | null,
  "lng": number | null,
  "address": string | null,
  "rating": number | null,
  "price_level": number | null,
  "image_url": string | null,
  "badges": string[],
  "source_urls": string[],
  "field_sources": object,
  "photo": {{"url": string, "license": string, "credit": string, "source_url": string}} | null
}}

Sources:
{chr(10).join(source_blocks)}
"""


# Forces the response into the exact {"records": [...]} shape via a tool
# call, rather than relying on a "return JSON" instruction — mirrors the
# structured-extraction pattern already used by app/api/chat/route.ts and
# app/api/translate/route.ts in the main Next app.
RECORD_SCHEMA = {
    "type": "object",
    "properties": {
        "batch_id": {"type": "string"},
        "region": {"type": ["string", "null"]},
        "prefecture": {"type": "string"},
        "city": {"type": ["string", "null"]},
        "country": {"type": "string"},
        "name": {"type": "string"},
        "category": {"type": ["string", "null"]},
        "description": {"type": ["string", "null"]},
        "tips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "source_url": {"type": "string"},
                },
                "required": ["text", "source_url"],
            },
        },
        "hours": {"type": "string"},
        "hours_status": {"type": "string", "enum": ["known", "unknown", "stale"]},
        "station": {"type": ["string", "null"]},
        "google_place_id": {"type": ["string", "null"]},
        "lat": {"type": ["number", "null"]},
        "lng": {"type": ["number", "null"]},
        "address": {"type": ["string", "null"]},
        "rating": {"type": ["number", "null"]},
        "price_level": {"type": ["number", "null"]},
        "image_url": {"type": ["string", "null"]},
        "badges": {"type": "array", "items": {"type": "string"}},
        "source_urls": {"type": "array", "items": {"type": "string"}},
        "field_sources": {"type": "object"},
        "photo": {
            "type": ["object", "null"],
            "properties": {
                "url": {"type": "string"},
                "license": {"type": "string"},
                "credit": {"type": "string"},
                "source_url": {"type": "string"},
            },
        },
    },
    "required": ["batch_id", "prefecture", "name"],
}

EXTRACT_TOOL = {
    "name": "submit_place_records",
    "description": "Submit the extracted Japan place records for this batch.",
    "input_schema": {
        "type": "object",
        "properties": {"records": {"type": "array", "items": RECORD_SCHEMA}},
        "required": ["records"],
    },
}


def extract_records(batch: dict[str, Any], sources: list[dict[str, str]], model: str) -> dict[str, Any]:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required for Claude extraction")

    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model,
        max_tokens=8000,
        system=SYSTEM_PROMPT,
        tools=[EXTRACT_TOOL],
        tool_choice={"type": "tool", "name": "submit_place_records"},
        messages=[{"role": "user", "content": build_user_prompt(batch, sources)}],
    )

    tool_use = next((b for b in response.content if b.type == "tool_use"), None)
    if tool_use is None:
        raise RuntimeError("empty response from extraction model")
    extracted = tool_use.input
    if not isinstance(extracted, dict) or not isinstance(extracted.get("records"), list):
        raise RuntimeError("expected extraction response to contain a records array")
    return extracted


def validate_record(record: dict[str, Any]) -> list[str]:
    errors = []
    for field in ["batch_id", "prefecture", "name"]:
        if not record.get(field):
            errors.append(f"missing {field}")

    source_urls = record.get("source_urls")
    if not isinstance(source_urls, list) or not source_urls:
        errors.append("missing source_urls")

    field_sources = record.get("field_sources")
    if not isinstance(field_sources, dict) or not field_sources:
        errors.append("missing field_sources")

    photo = record.get("photo")
    if photo is not None:
        if not isinstance(photo, dict):
            errors.append("photo must be an object or null")
        else:
            for field in ["url", "license", "credit", "source_url"]:
                if not photo.get(field):
                    errors.append(f"photo missing {field}")

    if record.get("hours") and record.get("hours") != "unknown" and record.get("hours_status") != "known":
        errors.append("hours_status must be known when hours are provided")

    return errors


def prepare_staging_records(extracted: dict[str, Any], model: str) -> list[dict[str, Any]]:
    prepared = []
    now = datetime.now(timezone.utc).isoformat()
    for record in extracted["records"]:
        if not isinstance(record, dict):
            continue
        record.setdefault("country", "JP")
        record.setdefault("tips", [])
        record.setdefault("badges", [])
        record.setdefault("source_urls", [])
        record.setdefault("field_sources", {})
        record.setdefault("hours", "unknown")
        record.setdefault("hours_status", "unknown")
        record["dedupe_key"] = build_dedupe_key(record)
        record["extraction_model"] = model
        record["extraction_status"] = "validated"
        record["validation_errors"] = validate_record(record)
        if record["validation_errors"]:
            record["extraction_status"] = "rejected"
            record["rejected_reason"] = "; ".join(record["validation_errors"])
        else:
            record["last_verified_at"] = now
        prepared.append(record)
    return prepared


def load_sources(batch: dict[str, Any], timeout: int, no_fetch: bool) -> list[dict[str, str]]:
    sources = batch.get("sources", [])
    if not isinstance(sources, list):
        raise RuntimeError("batch sources must be a list")

    loaded = []
    for source in sources:
        if isinstance(source, str):
            loaded.append({"url": source, "text": "" if no_fetch else fetch_source(source, timeout)["text"]})
        elif isinstance(source, dict) and source.get("url"):
            if no_fetch and source.get("text"):
                loaded.append({"url": source["url"], "text": source["text"][:MAX_SOURCE_CHARS]})
            elif no_fetch:
                loaded.append({"url": source["url"], "text": ""})
            else:
                loaded.append(fetch_source(source["url"], timeout))
    return loaded


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract Japan place staging JSON with Claude Haiku 4.5.")
    parser.add_argument("batch_json", type=Path, help="Source batch JSON file")
    parser.add_argument("--output", type=Path, required=True, help="Path for extracted staging JSON")
    parser.add_argument("--model", default=os.environ.get("PLACE_EXTRACT_MODEL", DEFAULT_MODEL))
    parser.add_argument("--timeout", type=int, default=20, help="HTTP fetch timeout in seconds")
    parser.add_argument("--no-fetch", action="store_true", help="Use source text already present in the batch JSON")
    parser.add_argument("--validate-only", action="store_true", help="Validate an already-extracted records JSON")
    args = parser.parse_args()

    payload = json.loads(args.batch_json.read_text())

    if args.validate_only:
        records = payload.get("records", payload)
        if not isinstance(records, list):
            print("[extract] validate-only expects a records array or list", file=sys.stderr)
            sys.exit(1)
        output = {"records": prepare_staging_records({"records": records}, args.model)}
    else:
        sources = load_sources(payload, args.timeout, args.no_fetch)
        extracted = extract_records(payload, sources, args.model)
        output = {"records": prepare_staging_records(extracted, args.model)}

    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    rejected = sum(1 for record in output["records"] if record.get("validation_errors"))
    print(f"[extract] wrote {len(output['records'])} record(s) to {args.output}; rejected={rejected}")


if __name__ == "__main__":
    main()