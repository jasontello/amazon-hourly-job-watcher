from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .models import Opportunity


class SeenState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.document = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "seen": {}}
        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Could not read state file {self.path}: {error}") from error
        if not isinstance(document, dict) or document.get("version") != 1:
            raise RuntimeError(f"Unsupported or invalid state file: {self.path}")
        if not isinstance(document.get("seen"), dict):
            raise RuntimeError(f"State file has an invalid 'seen' object: {self.path}")
        return document

    def contains(self, key: str) -> bool:
        return key in self.document["seen"]

    def mark_seen(self, opportunity: Opportunity) -> None:
        self.mark_seen_many([opportunity])

    def mark_seen_many(self, opportunities: list[Opportunity]) -> None:
        for opportunity in opportunities:
            self.document["seen"][opportunity.key] = {
                "first_seen_at": opportunity.detected_at.astimezone(timezone.utc).isoformat(),
                "job_id": opportunity.job_id,
                "schedule_id": opportunity.schedule_id,
                "title": opportunity.title,
                "location": opportunity.location_name,
            }
        self.save()

    def prune(self, retention_days: int, now: datetime) -> int:
        cutoff = now.astimezone(timezone.utc) - timedelta(days=retention_days)
        removed = 0
        for key, record in list(self.document["seen"].items()):
            try:
                first_seen = datetime.fromisoformat(str(record["first_seen_at"]))
            except (KeyError, TypeError, ValueError):
                first_seen = datetime.min.replace(tzinfo=timezone.utc)
            if first_seen < cutoff:
                del self.document["seen"][key]
                removed += 1
        if removed:
            self.save()
        return removed

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(self.document, indent=2, sort_keys=True) + "\n"
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", dir=self.path.parent, text=True
        )
        try:
            with os.fdopen(file_descriptor, "w", encoding="utf-8") as temporary_file:
                temporary_file.write(serialized)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_name, self.path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
