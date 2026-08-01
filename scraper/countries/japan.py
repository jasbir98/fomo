"""Japan country config — the original pipeline target.

ADMIN_UNIT_REGION mirrors the historic module-level PREFECTURE_REGION dict
that used to live directly in discover_cities.py: all 47 prefectures grouped
by the standard JNTO/travel-site regions. Okinawa is kept as its own region
rather than folded into Kyushu, matching how JNTO and most travel sites
present it.
"""

from __future__ import annotations

from .base import CountryConfig

ADMIN_UNIT_REGION: dict[str, str] = {
    "Hokkaido": "Hokkaido",
    "Aomori": "Tohoku",
    "Iwate": "Tohoku",
    "Miyagi": "Tohoku",
    "Akita": "Tohoku",
    "Yamagata": "Tohoku",
    "Fukushima": "Tohoku",
    "Ibaraki": "Kanto",
    "Tochigi": "Kanto",
    "Gunma": "Kanto",
    "Saitama": "Kanto",
    "Chiba": "Kanto",
    "Tokyo": "Kanto",
    "Kanagawa": "Kanto",
    "Niigata": "Chubu",
    "Toyama": "Chubu",
    "Ishikawa": "Chubu",
    "Fukui": "Chubu",
    "Yamanashi": "Chubu",
    "Nagano": "Chubu",
    "Gifu": "Chubu",
    "Shizuoka": "Chubu",
    "Aichi": "Chubu",
    "Mie": "Kansai",
    "Shiga": "Kansai",
    "Kyoto": "Kansai",
    "Osaka": "Kansai",
    "Hyogo": "Kansai",
    "Nara": "Kansai",
    "Wakayama": "Kansai",
    "Tottori": "Chugoku",
    "Shimane": "Chugoku",
    "Okayama": "Chugoku",
    "Hiroshima": "Chugoku",
    "Yamaguchi": "Chugoku",
    "Tokushima": "Shikoku",
    "Kagawa": "Shikoku",
    "Ehime": "Shikoku",
    "Kochi": "Shikoku",
    "Fukuoka": "Kyushu",
    "Saga": "Kyushu",
    "Nagasaki": "Kyushu",
    "Kumamoto": "Kyushu",
    "Oita": "Kyushu",
    "Miyazaki": "Kyushu",
    "Kagoshima": "Kyushu",
    "Okinawa": "Okinawa",
}

JAPAN = CountryConfig(
    code="JP",
    name="Japan",
    demonym="Japanese",
    admin_unit_label="prefecture",
    admin_unit_region=ADMIN_UNIT_REGION,
    category_examples="shrines, temples, parks, museums, viewpoints, markets, landmarks, gardens",
    source_guidance=(
        "Prefer official tourism sites, JNTO, Wikipedia, and Wikimedia Commons. "
        "Do not use Reddit, TripAdvisor, TikTok, Instagram, or review text as factual truth."
    ),
)
