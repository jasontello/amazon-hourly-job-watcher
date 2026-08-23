from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Location:
    city: str
    state: str


@dataclass(frozen=True)
class ApiConfig:
    url: str
    page_size: int
    max_pages: int
    request_timeout_seconds: float
    minimum_request_interval_seconds: float
    retry_attempts: int


@dataclass(frozen=True)
class StateConfig:
    path: Path
    retention_days: int


@dataclass(frozen=True)
class Config:
    locations: tuple[Location, ...]
    include_keywords: tuple[str, ...]
    preferred_shift_keywords: tuple[str, ...]
    timezone: str
    api: ApiConfig
    state: StateConfig


def _required(mapping: dict[str, Any], key: str, expected_type: type) -> Any:
    value = mapping.get(key)
    if not isinstance(value, expected_type):
        raise ValueError(f"Config field '{key}' must be {expected_type.__name__}")
    return value


def load_config(path: Path) -> Config:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"Config file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in {path}: {error}") from error

    if not isinstance(raw, dict):
        raise ValueError("Config root must be a JSON object")

    locations_raw = _required(raw, "locations", list)
    if not locations_raw:
        raise ValueError("At least one location is required")
    locations: list[Location] = []
    for item in locations_raw:
        if not isinstance(item, dict):
            raise ValueError("Each location must be an object")
        city = str(item.get("city", "")).strip()
        state = str(item.get("state", "")).strip().upper()
        if not city or len(state) != 2:
            raise ValueError("Each location needs a city and two-letter state code")
        locations.append(Location(city=city, state=state))

    include_keywords = tuple(
        str(value).strip().casefold()
        for value in _required(raw, "include_keywords", list)
        if str(value).strip()
    )
    if not include_keywords:
        raise ValueError("At least one include keyword is required")

    preferred_keywords = tuple(
        str(value).strip().casefold()
        for value in _required(raw, "preferred_shift_keywords", list)
        if str(value).strip()
    )

    api_raw = _required(raw, "api", dict)
    api = ApiConfig(
        url=str(api_raw.get("url", "")).strip(),
        page_size=int(api_raw.get("page_size", 100)),
        max_pages=int(api_raw.get("max_pages", 10)),
        request_timeout_seconds=float(api_raw.get("request_timeout_seconds", 30)),
        minimum_request_interval_seconds=float(
            api_raw.get("minimum_request_interval_seconds", 1)
        ),
        retry_attempts=int(api_raw.get("retry_attempts", 4)),
    )
    if not api.url.startswith("https://hiring.amazon.com/"):
        raise ValueError("api.url must use Amazon's official hiring.amazon.com HTTPS domain")
    if not 1 <= api.page_size <= 100:
        raise ValueError("api.page_size must be between 1 and 100")
    if api.max_pages < 1 or api.retry_attempts < 1:
        raise ValueError("api.max_pages and api.retry_attempts must be positive")
    if api.minimum_request_interval_seconds < 0.5:
        raise ValueError("minimum_request_interval_seconds must be at least 0.5")

    state_raw = _required(raw, "state", dict)
    state_path = Path(str(state_raw.get("path", "state/seen_jobs.json")))
    if not state_path.is_absolute():
        state_path = path.parent / state_path
    state = StateConfig(
        path=state_path.resolve(),
        retention_days=int(state_raw.get("retention_days", 365)),
    )
    if state.retention_days < 30:
        raise ValueError("state.retention_days must be at least 30")

    return Config(
        locations=tuple(locations),
        include_keywords=include_keywords,
        preferred_shift_keywords=preferred_keywords,
        timezone=str(raw.get("timezone", "America/Los_Angeles")),
        api=api,
        state=state,
    )

