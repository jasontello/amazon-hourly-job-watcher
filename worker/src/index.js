import { AmazonHourlyClient, buildOpportunities, cardMatches, isPreferred } from "./amazon.js";
import { WATCH_CONFIG } from "./config.js";
import { sendNtfy } from "./notification.js";

const STATE_ID = "oakley-vacaville-amazon-watcher";
const LEASE_KEY = "run:lease";
const LAST_RUN_KEY = "run:last";
const SEEN_PREFIX = "seen:";

function stateStub(env) {
  return env.WATCHER_STATE.get(env.WATCHER_STATE.idFromName(STATE_ID));
}

async function assertOk(response) {
  if (!response.ok) {
    throw new Error(`Watcher state returned ${response.status}: ${await response.text()}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return stateStub(env).fetch("https://watcher.internal/health");
    }
    if (url.pathname === "/run" && request.method === "POST") {
      const expected = env.WATCHER_TOKEN ? `Bearer ${env.WATCHER_TOKEN}` : "";
      if (!expected || request.headers.get("authorization") !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
      return stateStub(env).fetch("https://watcher.internal/run", { method: "POST" });
    }
    return Response.json({
      service: "Amazon hourly job watcher",
      status: "ok",
      health: "/health",
      automaticApplications: false,
    });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      stateStub(env)
        .fetch("https://watcher.internal/run", { method: "POST" })
        .then(assertOk),
    );
  },
};

export class WatcherState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const lastRun = await this.ctx.storage.get(LAST_RUN_KEY);
      return Response.json({ status: "ok", lastRun: lastRun || null });
    }
    if (url.pathname !== "/run" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const acquired = await this.acquireLease();
    if (!acquired) {
      return Response.json({ status: "skipped", reason: "run already in progress" }, { status: 409 });
    }
    try {
      const result = await this.runWatcher();
      await this.ctx.storage.put(LAST_RUN_KEY, {
        status: "success",
        finishedAt: new Date().toISOString(),
        ...result,
      });
      return Response.json({ status: "success", ...result });
    } catch (error) {
      console.error(error?.stack || error);
      await this.ctx.storage.put(LAST_RUN_KEY, {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 1_000),
      });
      return Response.json({ status: "error", error: String(error?.message || error) }, { status: 500 });
    } finally {
      await this.ctx.storage.delete(LEASE_KEY);
    }
  }

  async acquireLease() {
    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get(LEASE_KEY);
      if (
        existing?.startedAt &&
        now - existing.startedAt < WATCH_CONFIG.runLeaseMinutes * 60_000
      ) {
        return false;
      }
      await transaction.put(LEASE_KEY, { startedAt: now });
      return true;
    });
  }

  async runWatcher() {
    const detectedAt = new Date();
    const client = new AmazonHourlyClient();
    const cards = await client.fetchJobCards();
    const matchingCards = cards.filter((card) => cardMatches(card));
    console.log(`Found ${matchingCards.length} matching cards among ${cards.length} current cards`);

    const opportunities = [];
    for (const card of matchingCards) {
      const detail = await client.fetchJobDetail(card.jobId);
      const schedules = await client.fetchSchedules(card.jobId);
      if (detail.postingStatus && detail.postingStatus !== "POSTED") continue;
      opportunities.push(...buildOpportunities(card, detail, schedules, detectedAt));
    }
    opportunities.sort(
      (left, right) =>
        Number(isPreferred(right)) - Number(isPreferred(left)) ||
        (right.pay || 0) - (left.pay || 0) ||
        left.scheduleId.localeCompare(right.scheduleId),
    );

    const seenKeys = opportunities.map((item) => `${SEEN_PREFIX}${item.scheduleId}`);
    const seen = seenKeys.length ? await this.ctx.storage.get(seenKeys) : new Map();
    const unseen = opportunities.filter(
      (item) => !seen.has(`${SEEN_PREFIX}${item.scheduleId}`),
    );
    const byJob = Map.groupBy(unseen, (item) => item.jobId);
    let notifications = 0;
    for (const jobOpportunities of byJob.values()) {
      await sendNtfy(
        this.env,
        jobOpportunities,
        jobOpportunities.some((item) => isPreferred(item)),
      );
      const deliveredAt = new Date().toISOString();
      const records = Object.fromEntries(
        jobOpportunities.map((item) => [
          `${SEEN_PREFIX}${item.scheduleId}`,
          {
            deliveredAt,
            jobId: item.jobId,
            scheduleId: item.scheduleId,
            title: item.title,
            location: item.location,
          },
        ]),
      );
      await this.ctx.storage.put(records);
      notifications += 1;
    }
    await this.pruneOldState(detectedAt);
    console.log(
      `Watcher complete: ${opportunities.length} schedules, ${unseen.length} new, ` +
        `${notifications} notifications`,
    );
    return {
      cards: cards.length,
      matchingJobs: matchingCards.length,
      matchingSchedules: opportunities.length,
      newSchedules: unseen.length,
      notifications,
    };
  }

  async pruneOldState(now) {
    const cutoff = now.getTime() - WATCH_CONFIG.stateRetentionDays * 86_400_000;
    const records = await this.ctx.storage.list({ prefix: SEEN_PREFIX });
    const expiredKeys = [];
    for (const [key, record] of records) {
      const deliveredAt = Date.parse(record?.deliveredAt || "");
      if (!Number.isFinite(deliveredAt) || deliveredAt < cutoff) expiredKeys.push(key);
    }
    if (expiredKeys.length) await this.ctx.storage.delete(expiredKeys);
  }
}
