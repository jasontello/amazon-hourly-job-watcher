from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import urlencode


@dataclass(frozen=True)
class Opportunity:
    job_id: str
    schedule_id: str
    title: str
    city: str
    state: str
    location_name: str
    job_type: str
    employment_type: str
    schedule_type: str
    schedule_text: str
    hours_per_week: float | None
    pay: float | None
    pay_display: str
    posted_at: str
    detected_at: datetime
    first_day: str
    schedule_type_code: str = ""
    site_ids: tuple[str, ...] = ()
    site_address: str | None = None
    profile_id: str = ""
    profile_label: str = ""
    fit_summary: str = ""
    schedule_days: tuple[str, ...] = ()
    other_job_days: tuple[str, ...] = ()
    is_flexible: bool = False
    preferred: bool = False

    @property
    def key(self) -> str:
        prefix = f"profile:{self.profile_id}:" if self.profile_id else ""
        return f"{prefix}schedule:{self.schedule_id}"

    @property
    def direct_application_url(self) -> str:
        query = urlencode(
            {
                "jobId": self.job_id,
                "page": "pre-consent",
                "scheduleId": self.schedule_id,
                "locale": "en-US",
                "country": "US",
            }
        )
        return f"https://hiring.amazon.com/application/?{query}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "schedule_id": self.schedule_id,
            "title": self.title,
            "location": self.location_name,
            "job_type": self.job_type,
            "employment_type": self.employment_type,
            "schedule_type": self.schedule_type,
            "schedule_text": self.schedule_text,
            "hours_per_week": self.hours_per_week,
            "pay": self.pay_display,
            "posted_at": self.posted_at,
            "detected_at": self.detected_at.isoformat(),
            "first_day": self.first_day,
            "application_url": self.direct_application_url,
            "profile_id": self.profile_id,
            "profile_label": self.profile_label,
            "site_ids": list(self.site_ids),
            "fit_summary": self.fit_summary,
            "schedule_days": list(self.schedule_days),
            "other_job_days": list(self.other_job_days),
            "is_flexible": self.is_flexible,
            "preferred": self.preferred,
        }
