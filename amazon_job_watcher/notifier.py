from __future__ import annotations

import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

from .models import Opportunity

LOGGER = logging.getLogger(__name__)


class NotificationError(RuntimeError):
    """Raised when a push notification could not be delivered."""


def _schedule_line(opportunity: Opportunity) -> str:
    hours = (
        f"{opportunity.hours_per_week:g} hrs/week"
        if opportunity.hours_per_week is not None
        else "Hours not listed"
    )
    return (
        f"- {opportunity.schedule_type} | {opportunity.schedule_text} | "
        f"{hours} | {opportunity.pay_display} | starts {opportunity.first_day}\n"
        f"  {opportunity.fit_summary}"
    )


def format_notification(opportunity: Opportunity) -> str:
    return "\n".join(
        (
            opportunity.profile_label,
            opportunity.title,
            f"Location: {opportunity.location_name}",
            *((f"Site: {', '.join(opportunity.site_ids)}",) if opportunity.site_ids else ()),
            f"Shift: {opportunity.schedule_type} | {opportunity.schedule_text}",
            f"Why it fits: {opportunity.fit_summary}",
            (
                f"Hours/type: "
                f"{f'{opportunity.hours_per_week:g} hrs/week' if opportunity.hours_per_week is not None else 'Hours not listed'}"
                f" | {opportunity.employment_type}"
            ),
            f"Pay: {opportunity.pay_display}",
            f"Posted by Amazon: {opportunity.posted_at}",
            f"Detected: {opportunity.detected_at.strftime('%Y-%m-%d %I:%M:%S %p %Z')}",
            f"First day: {opportunity.first_day}",
            f"Apply: {opportunity.direct_application_url}",
        )
    )


def format_batch_notification(opportunities: list[Opportunity]) -> str:
    if not opportunities:
        raise ValueError("At least one opportunity is required")
    if len(opportunities) == 1:
        return format_notification(opportunities[0])
    first = opportunities[0]
    lines = [
        first.profile_label,
        first.title,
        f"Location: {first.location_name}",
        *([f"Site: {', '.join(first.site_ids)}"] if first.site_ids else []),
        f"{len(opportunities)} new selectable schedules:",
        *(_schedule_line(opportunity) for opportunity in opportunities),
        f"Employment: {', '.join(sorted({item.employment_type for item in opportunities}))}",
        f"Posted by Amazon: {first.posted_at}",
        f"Detected: {first.detected_at.strftime('%Y-%m-%d %I:%M:%S %p %Z')}",
        f"Apply now: {first.direct_application_url}",
    ]
    return "\n".join(lines)


class NtfyNotifier:
    def __init__(self, server: str, topic: str, token: str | None, timeout: float = 20) -> None:
        self.server = server.rstrip("/")
        self.topic = topic.strip()
        self.token = token
        self.timeout = timeout
        if not self.server.startswith("https://"):
            raise ValueError("NTFY_SERVER must use HTTPS")
        if not self.topic:
            raise ValueError("NTFY_TOPIC is required")

    @classmethod
    def from_environment(cls) -> "NtfyNotifier":
        return cls(
            server=os.environ.get("NTFY_SERVER", "https://ntfy.sh"),
            topic=os.environ.get("NTFY_TOPIC", ""),
            token=os.environ.get("NTFY_TOKEN") or None,
        )

    def send(self, opportunity: Opportunity, preferred: bool) -> None:
        self.send_many([opportunity], preferred=preferred)

    def send_many(self, opportunities: list[Opportunity], preferred: bool) -> None:
        if not opportunities:
            raise ValueError("At least one opportunity is required")
        first = opportunities[0]
        topic = urllib.parse.quote(self.topic, safe="")
        headers = {
            "Content-Type": "text/plain; charset=utf-8",
            "Title": "Preferred Amazon day job" if preferred else "Amazon day-shift job available",
            "Priority": "urgent" if preferred else "high",
            "Tags": "rotating_light,package" if preferred else "package",
            "Click": first.direct_application_url,
            "Actions": f"view, Apply now, {first.direct_application_url}, clear=true",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            f"{self.server}/{topic}",
            data=format_batch_notification(opportunities).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                if response.status < 200 or response.status >= 300:
                    raise NotificationError(f"ntfy returned HTTP {response.status}")
        except (urllib.error.URLError, TimeoutError) as error:
            body = ""
            if isinstance(error, urllib.error.HTTPError):
                try:
                    body = error.read(500).decode("utf-8", errors="replace")
                except Exception:  # pragma: no cover - diagnostic best effort
                    pass
            raise NotificationError(f"Could not send ntfy notification: {error} {body}") from error
        LOGGER.info(
            "Sent ntfy notification for job %s (%d new schedules)",
            first.job_id,
            len(opportunities),
        )


def test_notification(notifier: NtfyNotifier, now: datetime) -> None:
    example = Opportunity(
        job_id="TEST-JOB",
        schedule_id="TEST-SCHEDULE",
        title="Amazon watcher test notification",
        city="Oakley",
        state="CA",
        location_name="Oakley, CA",
        job_type="Flex Time",
        employment_type="Regular",
        schedule_type="Flex Time",
        schedule_text="Flexible Shifts",
        hours_per_week=19,
        pay=22.50,
        pay_display="$22.50/hour",
        posted_at=now.date().isoformat(),
        detected_at=now,
        first_day="Example only",
        schedule_type_code="FLEX_TIME",
        profile_id="test",
        profile_label="Amazon watcher test",
        fit_summary="Flex listing — verify daytime options before accepting.",
        is_flexible=True,
        preferred=True,
    )
    notifier.send(example, preferred=True)
