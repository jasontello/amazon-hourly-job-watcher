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
    jobId jobTitle postingStatus mostRecentPostedDate
  }
}`;

const SCHEDULES_QUERY = `
query searchScheduleCards($searchScheduleRequest: SearchScheduleRequest!) {
  searchScheduleCards(searchScheduleRequest: $searchScheduleRequest) {
    nextToken
    scheduleCards {
      scheduleId jobId employmentType scheduleType scheduleTypeL10N hoursPerWeek
      totalPayRate totalPayRateL10N firstDayOnSite firstDayOnSiteL10N
      scheduleText laborDemandAvailableCount
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

export function cardMatches(card, config = WATCH_CONFIG) {
  const city = normalized(card.city);
  const state = String(card.state ?? "").trim().toUpperCase();
  const locationMatches = config.locations.some(
    (location) => city === normalized(location.city) && state === location.state,
  );
  if (!locationMatches) return false;
  const searchable = [card.jobTitle, card.tagLine, card.jobTypeL10N]
    .map(normalized)
    .join(" ");
  return config.includeKeywords.some((keyword) => searchable.includes(keyword));
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
      scheduleText: schedule.scheduleText || "Schedule details not listed",
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

export function isPreferred(opportunity, config = WATCH_CONFIG) {
  const searchable = [
    opportunity.jobType,
    opportunity.scheduleType,
    opportunity.scheduleText,
    opportunity.employmentType,
  ]
    .join(" ")
    .toLocaleLowerCase("en-US");
  return config.preferredShiftKeywords.some((keyword) => searchable.includes(keyword));
}
