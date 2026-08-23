import userConfig from "../../config.json" with { type: "json" };

export const WATCH_CONFIG = Object.freeze({
  locations: userConfig.locations,
  includeKeywords: userConfig.include_keywords,
  preferredShiftKeywords: userConfig.preferred_shift_keywords,
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
