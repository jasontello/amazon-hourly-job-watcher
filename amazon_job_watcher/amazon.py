from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any

from .config import ApiConfig, Config
from .models import Opportunity

LOGGER = logging.getLogger(__name__)

SEARCH_JOBS_QUERY = """
query searchJobCardsByLocation($searchJobRequest: SearchJobRequest!) {
  searchJobCardsByLocation(searchJobRequest: $searchJobRequest) {
    nextToken
    jobCards {
      jobId jobTitle jobType employmentType city state postalCode locationName
      totalPayRateMin totalPayRateMax totalPayRateMinL10N totalPayRateMaxL10N
      tagLine scheduleCount currencyCode jobTypeL10N employmentTypeL10N
    }
  }
}
"""

JOB_DETAIL_QUERY = """
query getJobDetail($getJobDetailRequest: GetJobDetailRequest!) {
  getJobDetail(getJobDetailRequest: $getJobDetailRequest) {
    jobId jobTitle jobType jobTypeL10N employmentType employmentTypeL10N
    locationName postingStatus mostRecentPostedDate currencyCode
  }
}
"""

SCHEDULES_QUERY = """
query searchScheduleCards($searchScheduleRequest: SearchScheduleRequest!) {
  searchScheduleCards(searchScheduleRequest: $searchScheduleRequest) {
    nextToken
    scheduleCards {
      scheduleId jobId employmentType scheduleType scheduleTypeL10N hoursPerWeek
      totalPayRate totalPayRateL10N firstDayOnSite firstDayOnSiteL10N
      scheduleText scheduleTextDescription laborDemandAvailableCount
    }
  }
}
"""


class AmazonApiError(RuntimeError):
    """Raised when Amazon's official hourly jobs feed cannot be read safely."""


class RateLimiter:
    def __init__(self, minimum_interval_seconds: float) -> None:
        self.minimum_interval_seconds = minimum_interval_seconds
        self._last_request_at = 0.0

    def wait(self) -> None:
        remaining = self.minimum_interval_seconds - (time.monotonic() - self._last_request_at)
        if remaining > 0:
            time.sleep(remaining)
        self._last_request_at = time.monotonic()


class AmazonHourlyClient:
    def __init__(self, config: ApiConfig) -> None:
        self.config = config
        self.rate_limiter = RateLimiter(config.minimum_request_interval_seconds)

    def _post(self, operation: str, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        payload = json.dumps(
            {"operationName": operation, "variables": variables, "query": query}
        ).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Authorization": "Bearer Status|unauthenticated|Session|",
            "Content-Type": "application/json",
            "Country": "United States",
            "Iscanary": "false",
            "Origin": "https://hiring.amazon.com",
            "Referer": "https://hiring.amazon.com/app",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
            ),
        }

        last_error: Exception | None = None
        for attempt in range(1, self.config.retry_attempts + 1):
            self.rate_limiter.wait()
            request = urllib.request.Request(
                self.config.url, data=payload, headers=headers, method="POST"
            )
            try:
                with urllib.request.urlopen(
                    request, timeout=self.config.request_timeout_seconds
                ) as response:
                    document = json.load(response)
                if not isinstance(document, dict):
                    raise AmazonApiError("Amazon returned a non-object JSON response")
                if document.get("errors"):
                    raise AmazonApiError(f"Amazon GraphQL error: {document['errors']}")
                data = document.get("data")
                if not isinstance(data, dict):
                    raise AmazonApiError("Amazon response did not contain a data object")
                return data
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, AmazonApiError) as error:
                last_error = error
                status = getattr(error, "code", None)
                retryable = status in (None, 403, 408, 429) or (isinstance(status, int) and status >= 500)
                if not retryable or attempt == self.config.retry_attempts:
                    break
                retry_after = None
                headers_obj = getattr(error, "headers", None)
                if headers_obj:
                    retry_after = headers_obj.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after else min(2 ** (attempt - 1), 15)
                except ValueError:
                    delay = min(2 ** (attempt - 1), 15)
                delay += random.uniform(0, 0.5)
                LOGGER.warning(
                    "Amazon request %s failed (attempt %d/%d); retrying in %.1fs: %s",
                    operation,
                    attempt,
                    self.config.retry_attempts,
                    delay,
                    error,
                )
                time.sleep(delay)

        body = ""
        if isinstance(last_error, urllib.error.HTTPError):
            try:
                body = last_error.read(500).decode("utf-8", errors="replace")
            except Exception:  # pragma: no cover - diagnostic best effort
                pass
        detail = f" Response: {body}" if body else ""
        raise AmazonApiError(f"Amazon request {operation} failed: {last_error}.{detail}")

    def fetch_job_cards(self) -> list[dict[str, Any]]:
        cards_by_id: dict[str, dict[str, Any]] = {}
        next_token: str | None = None
        for page in range(1, self.config.max_pages + 1):
            request: dict[str, Any] = {
                "locale": "en-US",
                "country": "United States",
                "keyWords": "",
                "equalFilters": [{"key": "scheduleRequiredLanguage", "val": "en-US"}],
                "containFilters": [{"key": "isPrivateSchedule", "val": ["false"]}],
                "rangeFilters": [
                    {"key": "hoursPerWeek", "range": {"minimum": 0, "maximum": 80}}
                ],
                "orFilters": [],
                "dateFilters": [],
                "sorters": [{"fieldName": "totalPayRateMax", "ascending": "false"}],
                "pageSize": self.config.page_size,
                "consolidateSchedule": True,
            }
            if next_token:
                request["nextToken"] = next_token
            data = self._post(
                "searchJobCardsByLocation",
                SEARCH_JOBS_QUERY,
                {"searchJobRequest": request},
            )
            result = data.get("searchJobCardsByLocation")
            if not isinstance(result, dict) or not isinstance(result.get("jobCards"), list):
                raise AmazonApiError("Amazon job-card response shape changed")
            for card in result["jobCards"]:
                if isinstance(card, dict) and card.get("jobId"):
                    cards_by_id[str(card["jobId"])] = card
            next_token = result.get("nextToken")
            LOGGER.info(
                "Fetched Amazon job-card page %d (%d unique cards)", page, len(cards_by_id)
            )
            if not next_token:
                return list(cards_by_id.values())
        raise AmazonApiError(
            f"Amazon search exceeded max_pages={self.config.max_pages}; increase it in config.json"
        )

    def fetch_job_detail(self, job_id: str) -> dict[str, Any]:
        data = self._post(
            "getJobDetail",
            JOB_DETAIL_QUERY,
            {"getJobDetailRequest": {"jobId": job_id, "locale": "en-US"}},
        )
        detail = data.get("getJobDetail")
        if not isinstance(detail, dict):
            raise AmazonApiError(f"Amazon returned no detail for {job_id}")
        return detail

    def fetch_schedules(self, job_id: str) -> list[dict[str, Any]]:
        schedules_by_id: dict[str, dict[str, Any]] = {}
        next_token: str | None = None
        for _page in range(1, self.config.max_pages + 1):
            request: dict[str, Any] = {
                "country": "United States",
                "jobId": job_id,
                "locale": "en-US",
                "pageSize": self.config.page_size,
                "consolidateSchedule": True,
            }
            if next_token:
                request["nextToken"] = next_token
            data = self._post(
                "searchScheduleCards",
                SCHEDULES_QUERY,
                {"searchScheduleRequest": request},
            )
            result = data.get("searchScheduleCards")
            if not isinstance(result, dict) or not isinstance(result.get("scheduleCards"), list):
                raise AmazonApiError(f"Amazon schedule response shape changed for {job_id}")
            for schedule in result["scheduleCards"]:
                if isinstance(schedule, dict) and schedule.get("scheduleId"):
                    schedules_by_id[str(schedule["scheduleId"])] = schedule
            next_token = result.get("nextToken")
            if not next_token:
                return list(schedules_by_id.values())
        raise AmazonApiError(f"Schedule search exceeded max_pages for {job_id}")


def _normalized(value: Any) -> str:
    return str(value or "").strip().casefold()


def card_matches(card: dict[str, Any], config: Config) -> bool:
    city = _normalized(card.get("city"))
    state = str(card.get("state") or "").strip().upper()
    location_match = any(
        city == location.city.casefold() and state == location.state
        for location in config.locations
    )
    if not location_match:
        return False
    searchable = " ".join(
        _normalized(card.get(field)) for field in ("jobTitle", "tagLine", "jobTypeL10N")
    )
    return any(keyword in searchable for keyword in config.include_keywords)


def is_preferred(opportunity: Opportunity, config: Config) -> bool:
    searchable = " ".join(
        (
            opportunity.job_type,
            opportunity.schedule_type,
            opportunity.schedule_text,
            opportunity.employment_type,
        )
    ).casefold()
    return any(keyword in searchable for keyword in config.preferred_shift_keywords)


def build_opportunities(
    card: dict[str, Any],
    detail: dict[str, Any],
    schedules: list[dict[str, Any]],
    detected_at: datetime,
) -> list[Opportunity]:
    opportunities: list[Opportunity] = []
    for schedule in schedules:
        schedule_id = str(schedule.get("scheduleId") or "").strip()
        if not schedule_id:
            continue
        pay = schedule.get("totalPayRate")
        pay_number = float(pay) if isinstance(pay, (int, float)) else None
        pay_display = str(schedule.get("totalPayRateL10N") or "Not listed")
        if pay_display != "Not listed":
            pay_display = f"{pay_display}/hour"
        opportunities.append(
            Opportunity(
                job_id=str(card.get("jobId") or detail.get("jobId") or ""),
                schedule_id=schedule_id,
                title=str(card.get("jobTitle") or detail.get("jobTitle") or "Amazon hourly role"),
                city=str(card.get("city") or ""),
                state=str(card.get("state") or ""),
                location_name=str(card.get("locationName") or "").strip()
                or ", ".join(filter(None, (str(card.get("city") or ""), str(card.get("state") or "")))),
                job_type=str(card.get("jobTypeL10N") or card.get("jobType") or "Not listed"),
                employment_type=str(
                    schedule.get("employmentType")
                    or card.get("employmentTypeL10N")
                    or card.get("employmentType")
                    or "Not listed"
                ),
                schedule_type=str(
                    schedule.get("scheduleTypeL10N")
                    or schedule.get("scheduleType")
                    or "Not listed"
                ),
                schedule_text=str(schedule.get("scheduleText") or "Schedule details not listed"),
                hours_per_week=float(schedule["hoursPerWeek"])
                if isinstance(schedule.get("hoursPerWeek"), (int, float))
                else None,
                pay=pay_number,
                pay_display=pay_display,
                posted_at=str(detail.get("mostRecentPostedDate") or "Not listed"),
                detected_at=detected_at,
                first_day=str(
                    schedule.get("firstDayOnSiteL10N")
                    or schedule.get("firstDayOnSite")
                    or "Not listed"
                ),
            )
        )
    return opportunities

