import userConfig from "../../config.json" with { type: "json" };

export const WATCH_CONFIG = Object.freeze({
  profiles: userConfig.profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    locations: profile.locations,
    facilityMatch: profile.facility_match
      ? {
          siteIds: profile.facility_match.site_ids,
          addressContains: profile.facility_match.address_contains,
        }
      : null,
    includeKeywords: profile.include_keywords,
    allowedScheduleTypes: profile.allowed_schedule_types,
    preferredScheduleTypes: profile.preferred_schedule_types,
    allowFlexibleShifts:
      profile.allow_flexible_shifts ?? userConfig.day_shift_policy.allow_flexible_shifts,
    notificationChannels: profile.notification_channels ?? ["push"],
    otherJobAvailability: profile.other_job_availability
      ? {
          candidateDays: profile.other_job_availability.candidate_days,
          requiredFreeDays: profile.other_job_availability.required_free_days,
        }
      : null,
  })),
  dayShiftPolicy: {
    earliestStart: userConfig.day_shift_policy.earliest_start,
    latestStart: userConfig.day_shift_policy.latest_start,
    latestEnd: userConfig.day_shift_policy.latest_end,
    allowFlexibleShifts: userConfig.day_shift_policy.allow_flexible_shifts,
  },
  amazonApiUrl: userConfig.api.url,
  pageSize: userConfig.api.page_size,
  maxPages: userConfig.api.max_pages,
  requestTimeoutMs: userConfig.api.request_timeout_seconds * 1_000,
  minimumRequestIntervalMs: userConfig.api.minimum_request_interval_seconds * 1_000,
  retryAttempts: userConfig.api.retry_attempts,
  stateRetentionDays: userConfig.state.retention_days,
  runLeaseMinutes: 4,
  timezone: userConfig.timezone,
});
