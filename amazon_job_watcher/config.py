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
class OtherJobAvailability:
    candidate_days: tuple[str, ...]
    required_free_days: int


@dataclass(frozen=True)
class Profile:
    id: str
    label: str
    locations: tuple[Location, ...]
    required_site_ids: tuple[str, ...]
    include_keywords: tuple[str, ...]
    allowed_schedule_types: tuple[str, ...]
    preferred_schedule_types: tuple[str, ...]
    other_job_availability: OtherJobAvailability | None


@dataclass(frozen=True)
class DayShiftPolicy:
    earliest_start: str
    latest_start: str
    latest_end: str
    allow_flexible_shifts: bool


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
    profiles: tuple[Profile, ...]
    day_shift_policy: DayShiftPolicy
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

    profiles_raw = _required(raw, "profiles", list)
    if not profiles_raw:
        raise ValueError("At least one watch profile is required")
    profiles: list[Profile] = []
    profile_ids: set[str] = set()
    valid_days = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
    for profile_raw in profiles_raw:
        if not isinstance(profile_raw, dict):
            raise ValueError("Each profile must be an object")
        profile_id = str(profile_raw.get("id", "")).strip()
        label = str(profile_raw.get("label", "")).strip()
        if not profile_id or not label or profile_id in profile_ids:
            raise ValueError("Every profile needs a unique id and a label")
        profile_ids.add(profile_id)

        locations_raw = _required(profile_raw, "locations", list)
        if not locations_raw:
            raise ValueError(f"Profile '{profile_id}' needs at least one location")
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
            for value in _required(profile_raw, "include_keywords", list)
            if str(value).strip()
        )
        if not include_keywords:
            raise ValueError(f"Profile '{profile_id}' needs at least one include keyword")

        availability_raw = profile_raw.get("other_job_availability")
        availability = None
        if availability_raw is not None:
            if not isinstance(availability_raw, dict):
                raise ValueError("other_job_availability must be an object or null")
            candidate_days = tuple(
                str(day).strip() for day in _required(availability_raw, "candidate_days", list)
            )
            required_free_days = int(availability_raw.get("required_free_days", 0))
            if (
                not candidate_days
                or any(day not in valid_days for day in candidate_days)
                or not 1 <= required_free_days <= len(candidate_days)
            ):
                raise ValueError(f"Profile '{profile_id}' has invalid other-job availability")
            availability = OtherJobAvailability(candidate_days, required_free_days)

        profiles.append(
            Profile(
                id=profile_id,
                label=label,
                locations=tuple(locations),
                required_site_ids=tuple(
                    str(value).strip().upper()
                    for value in _required(profile_raw, "required_site_ids", list)
                    if str(value).strip()
                ),
                include_keywords=include_keywords,
                allowed_schedule_types=tuple(
                    str(value).strip().upper()
                    for value in _required(profile_raw, "allowed_schedule_types", list)
                    if str(value).strip()
                ),
                preferred_schedule_types=tuple(
                    str(value).strip().upper()
                    for value in _required(profile_raw, "preferred_schedule_types", list)
                    if str(value).strip()
                ),
                other_job_availability=availability,
            )
        )

    day_shift_raw = _required(raw, "day_shift_policy", dict)
    policy_times = [
        str(day_shift_raw.get(key, ""))
        for key in ("earliest_start", "latest_start", "latest_end")
    ]
    for value in policy_times:
        parts = value.split(":")
        if len(parts) != 2 or not all(part.isdigit() for part in parts):
            raise ValueError(f"Invalid day-shift policy time: {value}")
        hours, minutes = map(int, parts)
        if not 0 <= hours <= 23 or not 0 <= minutes <= 59:
            raise ValueError(f"Invalid day-shift policy time: {value}")
    day_shift_policy = DayShiftPolicy(
        earliest_start=policy_times[0],
        latest_start=policy_times[1],
        latest_end=policy_times[2],
        allow_flexible_shifts=bool(day_shift_raw.get("allow_flexible_shifts", False)),
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
        profiles=tuple(profiles),
        day_shift_policy=day_shift_policy,
        timezone=str(raw.get("timezone", "America/Los_Angeles")),
        api=api,
        state=state,
    )
