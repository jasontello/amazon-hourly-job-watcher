import { WATCH_CONFIG } from "./config.js";

const SEARCH_JOBS_QUERY = `
query searchJobCardsByLocation($searchJobRequest: SearchJobRequest!) {
  searchJobCardsByLocation(searchJobRequest: $searchJobRequest) {
    nextToken
    jobCards {
      jobId jobTitle jobType city state locationName tagLine jobTypeL10N
    }
  }
}`;

const JOB_DETAIL_QUERY = `
query getJobDetail($getJobDetailRequest: GetJobDetailRequest!) {
  getJobDetail(getJobDetailRequest: $getJobDetailRequest) {
    jobId jobTitle postingStatus mostRecentPostedDate locationName fullAddress
    siteId locationDescription geoClusterDescription locationCode
  }
}`;

const SCHEDULES_QUERY = `
query searchScheduleCards($searchScheduleRequest: SearchScheduleRequest!) {
  searchScheduleCards(searchScheduleRequest: $searchScheduleRequest) {
    nextToken
    scheduleCards {
      scheduleId jobId employmentType scheduleType scheduleTypeL10N hoursPerWeek
      totalPayRate totalPayRateL10N firstDayOnSite firstDayOnSiteL10N
      scheduleText scheduleTextDescription laborDemandAvailableCount
      address city state postalCode siteId
    }
  }
}`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class AmazonHourlyClient {
  constructor(config = WATCH_CONFIG, fetchImplementation = (...args) => fetch(...args)) {
    this.config = config;
    this.fetchImplementation = fetchImplementation;
    this.lastRequestAt = 0;
  }

  async rateLimit() {
    const remaining =
      this.config.minimumRequestIntervalMs - (Date.now() - this.lastRequestAt);
    if (remaining > 0) await sleep(remaining);
    this.lastRequestAt = Date.now();
  }

  async post(operationName, query, variables) {
    const body = JSON.stringify({ operationName, query, variables });
    let lastError;
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt += 1) {
      await this.rateLimit();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await this.fetchImplementation(this.config.amazonApiUrl, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Authorization: "Bearer Status|unauthenticated|Session|",
            "Content-Type": "application/json",
            Country: "United States",
            Iscanary: "false",
            Origin: "https://hiring.amazon.com",
            Referer: "https://hiring.amazon.com/app",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
          },
          body,
        });
        if (!response.ok) {
          const responseBody = (await response.text()).slice(0, 500);
          const error = new Error(
            `Amazon ${operationName} returned HTTP ${response.status}: ${responseBody}`,
          );
          error.status = response.status;
          error.retryAfter = response.headers.get("retry-after");
          throw error;
        }
        const document = await response.json();
        if (!document || typeof document !== "object" || document.errors) {
          throw new Error(
            `Amazon ${operationName} returned GraphQL errors: ${JSON.stringify(document?.errors)}`,
          );
        }
        if (!document.data || typeof document.data !== "object") {
          throw new Error(`Amazon ${operationName} response did not include data`);
        }
        return document.data;
      } catch (error) {
        lastError = error;
        const status = error?.status;
        const retryable =
          error?.name === "AbortError" ||
          status === undefined ||
          [403, 408, 429].includes(status) ||
          status >= 500;
        if (!retryable || attempt === this.config.retryAttempts) break;
        const retryAfter = Number(error.retryAfter);
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1_000
          : Math.min(2 ** (attempt - 1) * 1_000, 15_000) + Math.random() * 500;
        console.warn(
          `Amazon ${operationName} attempt ${attempt}/${this.config.retryAttempts} failed; ` +
            `retrying in ${Math.round(delay)}ms: ${error.message}`,
        );
        await sleep(delay);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`Amazon ${operationName} failed: ${lastError?.message || lastError}`);
  }

  async fetchJobCards() {
    const cardsById = new Map();
    let nextToken;
    for (let page = 1; page <= this.config.maxPages; page += 1) {
      const request = {
        locale: "en-US",
        country: "United States",
        keyWords: "",
        equalFilters: [{ key: "scheduleRequiredLanguage", val: "en-US" }],
        containFilters: [{ key: "isPrivateSchedule", val: ["false"] }],
        rangeFilters: [{ key: "hoursPerWeek", range: { minimum: 0, maximum: 80 } }],
        orFilters: [],
        dateFilters: [],
        sorters: [{ fieldName: "totalPayRateMax", ascending: "false" }],
        pageSize: this.config.pageSize,
        consolidateSchedule: true,
        ...(nextToken ? { nextToken } : {}),
      };
      const data = await this.post("searchJobCardsByLocation", SEARCH_JOBS_QUERY, {
        searchJobRequest: request,
      });
      const result = data.searchJobCardsByLocation;
      if (!result || !Array.isArray(result.jobCards)) {
        throw new Error("Amazon job-card response shape changed");
      }
      for (const card of result.jobCards) {
        if (card?.jobId) cardsById.set(card.jobId, card);
      }
      nextToken = result.nextToken;
      console.log(`Fetched Amazon page ${page}; ${cardsById.size} unique cards`);
      if (!nextToken) return [...cardsById.values()];
    }
    throw new Error(`Amazon search exceeded maxPages=${this.config.maxPages}`);
  }

  async fetchJobDetail(jobId) {
    const data = await this.post("getJobDetail", JOB_DETAIL_QUERY, {
      getJobDetailRequest: { jobId, locale: "en-US" },
    });
    if (!data.getJobDetail || typeof data.getJobDetail !== "object") {
      throw new Error(`Amazon returned no detail for ${jobId}`);
    }
    return data.getJobDetail;
  }

  async fetchSchedules(jobId) {
    const schedulesById = new Map();
    let nextToken;
    for (let page = 1; page <= this.config.maxPages; page += 1) {
      const request = {
        country: "United States",
        jobId,
        locale: "en-US",
        pageSize: this.config.pageSize,
        consolidateSchedule: true,
        ...(nextToken ? { nextToken } : {}),
      };
      const data = await this.post("searchScheduleCards", SCHEDULES_QUERY, {
        searchScheduleRequest: request,
      });
      const result = data.searchScheduleCards;
      if (!result || !Array.isArray(result.scheduleCards)) {
        throw new Error(`Amazon schedule response shape changed for ${jobId}`);
      }
      for (const schedule of result.scheduleCards) {
        if (schedule?.scheduleId) schedulesById.set(schedule.scheduleId, schedule);
      }
      nextToken = result.nextToken;
      if (!nextToken) return [...schedulesById.values()];
    }
    throw new Error(`Schedule search exceeded maxPages for ${jobId}`);
  }
}

const normalized = (value) => String(value ?? "").trim().toLocaleLowerCase("en-US");

const DAY_NAMES = Object.freeze({
  sun: "Sun",
  sunday: "Sun",
  mon: "Mon",
  monday: "Mon",
  tue: "Tue",
  tues: "Tue",
  tuesday: "Tue",
  wed: "Wed",
  wednesday: "Wed",
  thu: "Thu",
  thur: "Thu",
  thurs: "Thu",
  thursday: "Thu",
  fri: "Fri",
  friday: "Fri",
  sat: "Sat",
  saturday: "Sat",
});

function normalizedCode(value) {
  return String(value ?? "").trim().toUpperCase().replaceAll(" ", "_");
}

function clockMinutes(value) {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 1 || hours > 12 || minutes > 59) return null;
  if (hours === 12) hours = 0;
  if (match[3].toUpperCase() === "PM") hours += 12;
  return hours * 60 + minutes;
}

function policyMinutes(value) {
  const match = String(value).match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid day-shift policy time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function siteIdsFrom(...values) {
  const result = new Set();
  for (const value of values.flat(Infinity)) {
    const code = normalizedCode(value);
    if (code) result.add(code);
  }
  return [...result];
}

export function parseScheduleText(scheduleText, policy = WATCH_CONFIG.dayShiftPolicy) {
  const text = String(scheduleText ?? "").replaceAll("\u202f", " ").trim();
  if (!text) return { valid: false, reason: "schedule text missing", days: [], segments: [] };
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const days = new Set();
  const segments = [];
  const earliestStart = policyMinutes(policy.earliestStart);
  const latestStart = policyMinutes(policy.latestStart);
  const latestEnd = policyMinutes(policy.latestEnd);
  for (const line of lines) {
    const match = line.match(/^(.*?)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
    if (!match) {
      return { valid: false, reason: `unrecognized schedule line: ${line}`, days: [], segments: [] };
    }
    const lineDays = [...match[1].matchAll(/\b(Sun(?:day)?|Mon(?:day)?|Tue(?:s|sday)?|Wed(?:nesday)?|Thu(?:r|rs|rsday)?|Fri(?:day)?|Sat(?:urday)?)\b/gi)]
      .map((dayMatch) => DAY_NAMES[dayMatch[1].toLocaleLowerCase("en-US")]);
    if (!lineDays.length || lineDays.some((day) => !day)) {
      return { valid: false, reason: `could not parse schedule days: ${line}`, days: [], segments: [] };
    }
    const start = clockMinutes(match[2]);
    const end = clockMinutes(match[3]);
    if (start === null || end === null) {
      return { valid: false, reason: `could not parse schedule time: ${line}`, days: [], segments: [] };
    }
    if (end <= start) {
      return { valid: false, reason: `overnight shift: ${line}`, days: [], segments: [] };
    }
    if (start < earliestStart || start > latestStart || end > latestEnd) {
      return { valid: false, reason: `outside sleep-safe hours: ${line}`, days: [], segments: [] };
    }
    lineDays.forEach((day) => days.add(day));
    segments.push({ days: lineDays, start, end, text: line });
  }
  return { valid: true, reason: "day shift", days: [...days], segments };
}

export function candidateProfiles(card, config = WATCH_CONFIG) {
  const city = normalized(card.city);
  const state = String(card.state ?? "").trim().toUpperCase();
  const searchable = [card.jobTitle, card.tagLine, card.jobTypeL10N]
    .map(normalized)
    .join(" ");
  return config.profiles.filter((profile) => {
    const locationMatches = profile.locations.some(
      (location) => city === normalized(location.city) && state === location.state,
    );
    return locationMatches && profile.includeKeywords.some((keyword) => searchable.includes(keyword));
  });
}

export function cardMatches(card, config = WATCH_CONFIG) {
  return candidateProfiles(card, config).length > 0;
}

export function buildOpportunities(card, detail, schedules, detectedAt) {
  return schedules
    .filter((schedule) => schedule?.scheduleId)
    .map((schedule) => ({
      jobId: card.jobId || detail.jobId,
      scheduleId: schedule.scheduleId,
      title: card.jobTitle || detail.jobTitle || "Amazon hourly role",
      location: card.locationName || `${card.city}, ${card.state}`,
      jobType: card.jobTypeL10N || card.jobType || "Not listed",
      employmentType: schedule.employmentType || "Not listed",
      scheduleType: schedule.scheduleTypeL10N || schedule.scheduleType || "Not listed",
      scheduleTypeCode: normalizedCode(schedule.scheduleType),
      scheduleText: schedule.scheduleText || "Schedule details not listed",
      siteIds: siteIdsFrom(detail.siteId || [], schedule.siteId || []),
      siteAddress: detail.fullAddress || schedule.address || null,
      hoursPerWeek:
        typeof schedule.hoursPerWeek === "number" ? schedule.hoursPerWeek : null,
      pay: typeof schedule.totalPayRate === "number" ? schedule.totalPayRate : null,
      payDisplay: schedule.totalPayRateL10N
        ? `${schedule.totalPayRateL10N}/hour`
        : "Not listed",
      postedAt: detail.mostRecentPostedDate || "Not listed",
      detectedAt,
      firstDay: schedule.firstDayOnSiteL10N || schedule.firstDayOnSite || "Not listed",
    }));
}

export function matchOpportunityToProfile(opportunity, profile, config = WATCH_CONFIG) {
  const scheduleTypeCode = normalizedCode(opportunity.scheduleTypeCode || opportunity.scheduleType);
  if (
    profile.allowedScheduleTypes.length &&
    !profile.allowedScheduleTypes.map(normalizedCode).includes(scheduleTypeCode)
  ) {
    return null;
  }
  const opportunitySites = new Set(opportunity.siteIds.map(normalizedCode));
  if (
    profile.requiredSiteIds.length &&
    !profile.requiredSiteIds.map(normalizedCode).some((siteId) => opportunitySites.has(siteId))
  ) {
    return null;
  }

  const isFlexible = scheduleTypeCode.includes("FLEX") || normalized(opportunity.scheduleText).includes("flexible shift");
  if (isFlexible) {
    if (!config.dayShiftPolicy.allowFlexibleShifts) return null;
    return {
      ...opportunity,
      profileId: profile.id,
      profileLabel: profile.label,
      isFlexible: true,
      scheduleDays: [],
      otherJobDays: profile.otherJobAvailability?.candidateDays || [],
      fitSummary: "Flex listing — exact days/times are selected later; verify daytime options before accepting.",
      preferred: profile.preferredScheduleTypes.map(normalizedCode).includes(scheduleTypeCode),
    };
  }

  const parsed = parseScheduleText(opportunity.scheduleText, config.dayShiftPolicy);
  if (!parsed.valid) return null;
  let otherJobDays = [];
  if (profile.otherJobAvailability) {
    const scheduledDays = new Set(parsed.days);
    otherJobDays = profile.otherJobAvailability.candidateDays.filter(
      (day) => !scheduledDays.has(day),
    );
    if (otherJobDays.length < profile.otherJobAvailability.requiredFreeDays) return null;
  }
  const fitSummary = profile.otherJobAvailability
    ? `Day-safe schedule; other-job days available: ${otherJobDays.join(", ")}.`
    : "Day-safe schedule; no overnight hours.";
  return {
    ...opportunity,
    profileId: profile.id,
    profileLabel: profile.label,
    isFlexible: false,
    scheduleDays: parsed.days,
    otherJobDays,
    fitSummary,
    preferred: profile.preferredScheduleTypes.map(normalizedCode).includes(scheduleTypeCode),
  };
}

export function matchingProfileOpportunities(opportunity, profiles, config = WATCH_CONFIG) {
  return profiles
    .map((profile) => matchOpportunityToProfile(opportunity, profile, config))
    .filter(Boolean);
}

export function isPreferred(opportunity) {
  return Boolean(opportunity.preferred);
}
