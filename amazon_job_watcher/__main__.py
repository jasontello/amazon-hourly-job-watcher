from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .config import load_config
from .notifier import notifier_from_environment, test_notification
from .runner import run


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Watch Amazon hourly warehouse job postings")
    parser.add_argument("--config", type=Path, default=Path("config.json"))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run", action="store_true", help="Fetch and print unseen matches without notifying"
    )
    mode.add_argument(
        "--baseline",
        action="store_true",
        help="Record current matches as seen without notifying",
    )
    mode.add_argument(
        "--test-notification",
        action="store_true",
        help="Send one sample push without querying Amazon",
    )
    return parser.parse_args()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = parse_args()
    try:
        config = load_config(args.config.resolve())
        if args.test_notification:
            now = datetime.now(ZoneInfo(config.timezone))
            test_notification(notifier_from_environment(), now)
            logging.getLogger(__name__).info("Test notification sent")
            return 0
        run(config, dry_run=args.dry_run, baseline=args.baseline)
        return 0
    except (ValueError, RuntimeError) as error:
        logging.getLogger(__name__).error("%s", error)
        return 1


if __name__ == "__main__":
    sys.exit(main())
