from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from amazon_job_watcher.amazon import build_opportunities, card_matches, is_preferred
from amazon_job_watcher.config import load_config
from amazon_job_watcher.notifier import format_batch_notification, format_notification
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

    def test_flex_schedule_is_preferred_and_url_targets_schedule(self) -> None:
        now = datetime(2026, 8, 23, 12, 30, tzinfo=ZoneInfo("America/Los_Angeles"))
        card = {
            "jobId": "JOB-US-123",
            "jobTitle": "Delivery Station Warehouse Associate",
            "city": "Oakley",
            "state": "CA",
            "locationName": "Oakley, CA",
            "jobTypeL10N": "Flex Time",
        }
        detail = {"mostRecentPostedDate": "2026-08-23"}
        schedules = [
            {
                "scheduleId": "SCH-US-456",
                "employmentType": "Regular",
                "scheduleTypeL10N": "Flex Time",
                "scheduleText": "Flexible Shifts",
                "hoursPerWeek": 19,
                "totalPayRate": 22.5,
                "totalPayRateL10N": "$22.50",
                "firstDayOnSite": "2026-09-01",
            }
        ]
        opportunity = build_opportunities(card, detail, schedules, now)[0]
        self.assertTrue(is_preferred(opportunity, self.config))
        self.assertIn("jobId=JOB-US-123", opportunity.direct_application_url)
        self.assertIn("scheduleId=SCH-US-456", opportunity.direct_application_url)
        message = format_notification(opportunity)
        self.assertIn("Flexible Shifts", message)
        self.assertIn("$22.50/hour", message)
        self.assertIn("Posted by Amazon: 2026-08-23", message)

    def test_multiple_schedules_are_grouped_into_one_message(self) -> None:
        now = datetime(2026, 8, 23, 12, 30, tzinfo=ZoneInfo("America/Los_Angeles"))
        card = {
            "jobId": "JOB-US-123",
            "jobTitle": "Warehouse Associate",
            "city": "Vacaville",
            "state": "CA",
            "locationName": "Vacaville, CA",
        }
        schedules = [
            {"scheduleId": "SCH-1", "scheduleType": "PART_TIME", "scheduleText": "Morning"},
            {"scheduleId": "SCH-2", "scheduleType": "FULL_TIME", "scheduleText": "Night"},
        ]
        opportunities = build_opportunities(card, {}, schedules, now)
        message = format_batch_notification(opportunities)
        self.assertIn("2 new selectable schedules", message)
        self.assertIn("Morning", message)
        self.assertIn("Night", message)


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


if __name__ == "__main__":
    unittest.main()
