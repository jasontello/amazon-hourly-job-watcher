from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from amazon_job_watcher.amazon import (
    build_opportunities,
    card_matches,
    is_preferred,
    match_opportunity_to_profile,
    parse_schedule_text,
)
from amazon_job_watcher.config import load_config
from amazon_job_watcher.notifier import (
    DiscordNotifier,
    format_batch_notification,
    format_notification,
)
from amazon_job_watcher.state import SeenState


ROOT = Path(__file__).resolve().parents[1]


class MatchingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_config(ROOT / "config.json")

    def test_matches_warehouse_role_in_target_city(self) -> None:
        card = {
            "city": "Vacaville",
            "state": "CA",
            "jobTitle": "Fulfillment Center Warehouse Associate",
            "tagLine": "Prepare customer orders.",
        }
        self.assertTrue(card_matches(card, self.config))
        self.assertTrue(
            card_matches(
                {
                    "city": "West Sacramento",
                    "state": "CA",
                    "jobTitle": "Delivery Station Warehouse Associate",
                },
                self.config,
            )
        )

    def test_rejects_wrong_city_and_nonwarehouse_role(self) -> None:
        wrong_city = {
            "city": "Tracy",
            "state": "CA",
            "jobTitle": "Warehouse Associate",
        }
        wrong_role = {
            "city": "Oakley",
            "state": "CA",
            "jobTitle": "Area Manager",
        }
        self.assertFalse(card_matches(wrong_city, self.config))
        self.assertFalse(card_matches(wrong_role, self.config))

    def raw_opportunity(
        self,
        *,
        city: str = "Oakley",
        site_ids: list[str] | None = None,
        site_address: str | None = None,
        schedule_type: str = "PART_TIME",
        schedule_type_label: str = "Part Time",
        schedule_text: str = "Sun, Mon, Tue 7:00 AM - 5:00 PM",
        hours_per_week: int = 30,
    ):
        now = datetime(2026, 8, 23, 12, 30, tzinfo=ZoneInfo("America/Los_Angeles"))
        card = {
            "jobId": "JOB-US-123",
            "jobTitle": "Delivery Station Warehouse Associate",
            "city": city,
            "state": "CA",
            "locationName": f"{city}, CA",
            "jobTypeL10N": schedule_type_label,
        }
        detail = {
            "mostRecentPostedDate": "2026-08-23",
            "siteId": site_ids or [],
            "fullAddress": site_address,
        }
        schedules = [
            {
                "scheduleId": "SCH-US-456",
                "employmentType": "Regular",
                "scheduleType": schedule_type,
                "scheduleTypeL10N": schedule_type_label,
                "scheduleText": schedule_text,
                "hoursPerWeek": hours_per_week,
                "totalPayRate": 22.5,
                "totalPayRateL10N": "$22.50",
                "firstDayOnSite": "2026-09-01",
            }
        ]
        return build_opportunities(card, detail, schedules, now)[0]

    def test_accepts_schedules_that_leave_three_tuesday_friday_days_free(self) -> None:
        jason = next(profile for profile in self.config.profiles if profile.id == "jason")
        first = match_opportunity_to_profile(self.raw_opportunity(), jason, self.config)
        assert first is not None
        self.assertEqual(first.other_job_days, ("Wed", "Thu", "Fri"))
        second = match_opportunity_to_profile(
            self.raw_opportunity(schedule_text="Sun, Wed, Sat 7:00 AM - 5:00 PM"),
            jason,
            self.config,
        )
        assert second is not None
        self.assertEqual(second.other_job_days, ("Tue", "Thu", "Fri"))
        self.assertIsNone(
            match_opportunity_to_profile(
                self.raw_opportunity(schedule_text="Mon, Tue, Wed 7:00 AM - 5:00 PM"),
                jason,
                self.config,
            )
        )

    def test_rejects_full_time_and_sleep_disrupting_shifts_for_jason(self) -> None:
        jason = next(profile for profile in self.config.profiles if profile.id == "jason")
        self.assertIsNone(
            match_opportunity_to_profile(
                self.raw_opportunity(
                    schedule_type="FULL_TIME", schedule_type_label="Full Time"
                ),
                jason,
                self.config,
            )
        )
        for text in (
            "Sun, Mon, Tue 1:20 AM - 11:50 AM",
            "Sun, Mon, Tue 6:30 PM - 5:00 AM",
            "Sun, Mon, Tue 7:30 PM - 11:30 PM",
        ):
            self.assertIsNone(
                match_opportunity_to_profile(
                    self.raw_opportunity(schedule_text=text), jason, self.config
                )
            )

    def test_flex_schedule_is_preferred_and_url_targets_schedule(self) -> None:
        jason = next(profile for profile in self.config.profiles if profile.id == "jason")
        opportunity = match_opportunity_to_profile(
            self.raw_opportunity(
                schedule_type="FLEX_TIME",
                schedule_type_label="Flex Time",
                schedule_text="Flexible Shifts",
                hours_per_week=19,
            ),
            jason,
            self.config,
        )
        assert opportunity is not None
        self.assertTrue(is_preferred(opportunity, self.config))
        self.assertTrue(opportunity.is_flexible)
        self.assertIn("verify daytime options", opportunity.fit_summary)
        self.assertIn("jobId=JOB-US-123", opportunity.direct_application_url)
        self.assertIn("scheduleId=SCH-US-456", opportunity.direct_application_url)
        message = format_notification(opportunity)
        self.assertIn("Flexible Shifts", message)
        self.assertIn("$22.50/hour", message)
        self.assertIn("Posted by Amazon: 2026-08-23", message)

    def test_matches_dsm4_hsm1_or_ramos_drive_and_prefers_full_time(self) -> None:
        friend = next(
            profile for profile in self.config.profiles if profile.id == "friend_dsm4"
        )
        opportunity = match_opportunity_to_profile(
            self.raw_opportunity(
                city="West Sacramento",
                site_ids=["SITE-DSM4"],
                schedule_type="FULL_TIME",
                schedule_type_label="Full Time",
                schedule_text="Sun, Mon, Tue, Wed 7:30 AM - 6:00 PM",
                hours_per_week=40,
            ),
            friend,
            self.config,
        )
        assert opportunity is not None
        self.assertTrue(is_preferred(opportunity, self.config))
        self.assertIn("SITE-DSM4", format_notification(opportunity))
        self.assertIsNotNone(
            match_opportunity_to_profile(
                self.raw_opportunity(
                    city="West Sacramento",
                    site_ids=["HSM1"],
                    schedule_type="FULL_TIME",
                    schedule_type_label="Full Time",
                ),
                friend,
                self.config,
            )
        )
        self.assertIsNotNone(
            match_opportunity_to_profile(
                self.raw_opportunity(
                    city="West Sacramento",
                    site_ids=["UNKNOWN"],
                    site_address="3620 Ramos Dr., West Sacramento, CA 95691",
                    schedule_type="FULL_TIME",
                    schedule_type_label="Full Time",
                ),
                friend,
                self.config,
            )
        )
        self.assertIsNone(
            match_opportunity_to_profile(
                self.raw_opportunity(city="West Sacramento", site_ids=["SITE-DSM1"]),
                friend,
                self.config,
            )
        )

    def test_friend_rejects_flexible_shifts_with_unknown_hours(self) -> None:
        friend = next(
            profile for profile in self.config.profiles if profile.id == "friend_dsm4"
        )

    def test_friend_only_accepts_full_time_schedules(self) -> None:
        friend = next(
            profile for profile in self.config.profiles if profile.id == "friend_dsm4"
        )
        self.assertIsNone(
            match_opportunity_to_profile(
                self.raw_opportunity(city="West Sacramento", site_ids=["DSM4"]),
                friend,
                self.config,
            )
        )
        self.assertIsNotNone(
            match_opportunity_to_profile(
                self.raw_opportunity(
                    city="West Sacramento",
                    site_ids=["DSM4"],
                    schedule_type="FULL_TIME",
                    schedule_type_label="Full Time",
                ),
                friend,
                self.config,
            )
        )
        self.assertIsNone(
            match_opportunity_to_profile(
                self.raw_opportunity(
                    city="West Sacramento",
                    site_ids=["DSM4"],
                    schedule_type="FLEX_TIME",
                    schedule_type_label="Flexible Shifts",
                    schedule_text="Flexible Shifts",
                ),
                friend,
                self.config,
            )
        )

    def test_rejects_unsafe_segment_in_split_schedule(self) -> None:
        valid, _reason, _days = parse_schedule_text(
            "Sun, Mon, Thu 2:00 PM - 6:00 PM\nMon 7:30 PM - 11:30 PM",
            self.config,
        )
        self.assertFalse(valid)

    def test_multiple_schedules_are_grouped_into_one_message(self) -> None:
        jason = next(profile for profile in self.config.profiles if profile.id == "jason")
        first = match_opportunity_to_profile(self.raw_opportunity(), jason, self.config)
        second = match_opportunity_to_profile(
            self.raw_opportunity(schedule_text="Sat, Sun, Mon 8:00 AM - 4:00 PM"),
            jason,
            self.config,
        )
        assert first is not None and second is not None
        second = second.__class__(**{**second.__dict__, "schedule_id": "SCH-US-789"})
        opportunities = [first, second]
        message = format_batch_notification(opportunities)
        self.assertIn("2 new selectable schedules", message)
        self.assertIn("other-job days available", message)


class StateTests(unittest.TestCase):
    def test_seen_state_round_trip(self) -> None:
        now = datetime(2026, 8, 23, tzinfo=ZoneInfo("America/Los_Angeles"))
        config = load_config(ROOT / "config.json")
        card = {
            "jobId": "JOB-US-1",
            "jobTitle": "Warehouse Associate",
            "city": "Vacaville",
            "state": "CA",
            "locationName": "Vacaville, CA",
        }
        schedule = {"scheduleId": "SCH-US-1", "scheduleType": "FLEX_TIME"}
        opportunity = build_opportunities(card, {}, [schedule], now)[0]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "seen.json"
            state = SeenState(path)
            self.assertFalse(state.contains(opportunity.key))
            state.mark_seen(opportunity)
            self.assertTrue(SeenState(path).contains(opportunity.key))
            document = json.loads(path.read_text())
            self.assertEqual(document["seen"][opportunity.key]["job_id"], "JOB-US-1")
        self.assertEqual(config.state.retention_days, 365)


class NotificationTests(unittest.TestCase):
    def test_discord_notifier_requires_an_official_webhook(self) -> None:
        with self.assertRaisesRegex(ValueError, "official Discord HTTPS webhook URL"):
            DiscordNotifier("https://example.com/webhooks/not-discord")

    def test_discord_notifier_accepts_the_official_endpoint(self) -> None:
        notifier = DiscordNotifier(
            "https://discord.com/api/webhooks/123456/secret-token",
            "377516438161850391",
        )
        self.assertEqual(
            notifier.webhook_url,
            "https://discord.com/api/webhooks/123456/secret-token",
        )
        self.assertEqual(notifier.user_id, "377516438161850391")

    def test_discord_notifier_rejects_an_invalid_user_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "17-20 digit Discord user ID"):
            DiscordNotifier(
                "https://discord.com/api/webhooks/123456/secret-token",
                "not-a-user",
            )


if __name__ == "__main__":
    unittest.main()
