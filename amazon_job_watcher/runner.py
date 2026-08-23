from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .amazon import (
    AmazonHourlyClient,
    build_opportunities,
    card_matches,
    is_preferred,
)
from .config import Config
from .notifier import NtfyNotifier
from .state import SeenState

LOGGER = logging.getLogger(__name__)


def run(config: Config, *, dry_run: bool = False, baseline: bool = False) -> int:
    try:
        timezone = ZoneInfo(config.timezone)
    except ZoneInfoNotFoundError as error:
        raise ValueError(f"Unknown timezone in config.json: {config.timezone}") from error

    detected_at = datetime.now(timezone)
    client = AmazonHourlyClient(config.api)
    state = SeenState(config.state.path)
    notifier = None if dry_run or baseline else NtfyNotifier.from_environment()

    cards = client.fetch_job_cards()
    matching_cards = [card for card in cards if card_matches(card, config)]
    LOGGER.info(
        "Found %d location/keyword matches among %d current Amazon hourly job cards",
        len(matching_cards),
        len(cards),
    )

    opportunities = []
    for card in matching_cards:
        job_id = str(card["jobId"])
        detail = client.fetch_job_detail(job_id)
        if detail.get("postingStatus") not in (None, "POSTED"):
            LOGGER.info("Skipping %s because postingStatus=%s", job_id, detail.get("postingStatus"))
            continue
        schedules = client.fetch_schedules(job_id)
        if not schedules:
            LOGGER.warning("Matching job %s currently has no selectable schedules", job_id)
            continue
        opportunities.extend(build_opportunities(card, detail, schedules, detected_at))

    opportunities.sort(
        key=lambda item: (not is_preferred(item, config), -(item.pay or 0), item.schedule_id)
    )
    new_opportunities = [item for item in opportunities if not state.contains(item.key)]

    if dry_run:
        print(json.dumps([item.as_dict() for item in new_opportunities], indent=2))
        LOGGER.info("Dry run complete: %d unseen matching schedules", len(new_opportunities))
        return len(new_opportunities)

    if baseline:
        state.mark_seen_many(new_opportunities)
        LOGGER.info("Baseline complete: recorded %d schedules without notifying", len(new_opportunities))
        return len(new_opportunities)

    assert notifier is not None
    opportunities_by_job: dict[str, list] = defaultdict(list)
    for opportunity in new_opportunities:
        opportunities_by_job[opportunity.job_id].append(opportunity)
    for job_opportunities in opportunities_by_job.values():
        preferred = any(is_preferred(item, config) for item in job_opportunities)
        notifier.send_many(job_opportunities, preferred=preferred)
        # Persist each delivered batch immediately. A later failure will not resend this job.
        state.mark_seen_many(job_opportunities)
    removed = state.prune(config.state.retention_days, detected_at)
    if removed:
        LOGGER.info("Pruned %d expired deduplication records", removed)
    LOGGER.info(
        "Watcher complete: %d current schedules, %d new schedules across %d notifications",
        len(opportunities),
        len(new_opportunities),
        len(opportunities_by_job),
    )
    return len(new_opportunities)
