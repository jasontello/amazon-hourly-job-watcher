# Amazon Day-Shift Job Watcher

A hosted, notification-only watcher for two Amazon warehouse job searches:

- **Jason:** Oakley or Vacaville, California; part-time or Flex/FlexPT; compatible with a
  three-day Digital NEST schedule chosen from Tuesday through Friday.
- **Friend:** the exact **DSM4** delivery station at 3620 Ramos Drive in West Sacramento; any
  sleep-safe/day schedule, with full-time openings marked preferred.

It reads Amazon's official hourly hiring feed, evaluates every selectable schedule, remembers
which schedules were already delivered, and pushes new matches to an iPhone. It never signs in,
fills an application, or applies automatically.

> **Production status:** the updated Worker is deployed, but its recurring cron remains paused
> until a private Discord webhook is configured and tested. The existing ntfy credentials remain
> installed, but ntfy has rate-limited Cloudflare's shared outbound IP in production.

## Matching rules

### Jason — Oakley and Vacaville

A schedule must meet all of these rules:

1. The job is in Oakley or Vacaville and describes an Amazon warehouse, fulfillment, sortation,
   delivery-station, or package-sorter role.
2. Amazon classifies the schedule as `PART_TIME` or `FLEX_TIME`.
3. Every fixed shift starts from **5:00 a.m. through 4:00 p.m.**, ends no later than **11:00 p.m.**,
   and does not cross midnight.
4. The Amazon workdays leave at least three of **Tuesday, Wednesday, Thursday, and Friday** open
   for Digital NEST. Equivalently, Amazon may occupy at most one of those four days.

Examples:

- Amazon Sunday/Monday/Tuesday: accepted; Digital NEST can be Wednesday/Thursday/Friday.
- Amazon Sunday/Wednesday/Saturday: accepted; Digital NEST can be Tuesday/Thursday/Friday.
- Amazon Monday/Tuesday/Wednesday: rejected; only Thursday/Friday remain for Digital NEST.

`Flexible Shifts` listings are accepted because their exact days and times are selected later.
Their alert explicitly says to verify that daytime choices are actually available before accepting.

### Friend — DSM4 West Sacramento

The job must resolve to Amazon's exact `SITE-DSM4` facility identifier. Matching by this identifier
avoids notifying for other Amazon buildings in West Sacramento. All employment types are allowed,
the same sleep-safe time window is enforced, and `FULL_TIME` alerts receive preferred priority.

## Notification contents

Each push includes:

- who the match is for;
- job title, city, and Amazon facility ID when available;
- shift type, exact workdays and hours, weekly hours, and employment type;
- why the schedule passed the filter and which Digital NEST days remain available;
- hourly pay, Amazon posting date, detection time, and first day when available; and
- a direct official Amazon application URL with the job and schedule preselected.

If one posting has several new eligible schedules, they are grouped into one notification. Each
profile and schedule ID is stored separately, so an added schedule or a match for the other profile
still produces a new alert.

## Architecture

```text
Cloudflare Cron Trigger (every 5 minutes when enabled)
  -> one strongly consistent Durable Object
  -> Amazon official hourly-jobs GraphQL feed
  -> profile, facility, schedule-type, time, and weekday filters
  -> compare with profile-scoped delivered-schedule state
  -> private Discord channel push to iPhone (Telegram/ntfy fallbacks supported)
  -> store IDs only after successful delivery

GitHub
  -> source control + Node/Python tests + Worker bundle validation
```

Cloudflare is the continuous runtime because the Amazon feed has rejected GitHub-hosted runner
traffic. The Worker uses web-platform APIs and has no production runtime dependencies.

## Finish iPhone notifications with Discord

Discord is the preferred free provider. It needs no Discord bot or account credentials—only an
incoming webhook that is limited to posting in one private channel.

1. Create a private Discord server named **Amazon Job Alerts**.
2. Create or rename a text channel to **amazon-job-alerts**.
3. Open **Server Settings → Integrations → Webhooks → New Webhook**.
4. Name it **Amazon Job Watcher**, select the alert channel, and copy its webhook URL.
5. Store that URL as an encrypted Cloudflare secret:

   ```bash
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```

6. Enable Discord Developer Mode, copy your numeric user ID, and store it so every alert directly
   mentions your account and reliably triggers mobile push:

   ```bash
   npx wrangler secret put DISCORD_USER_ID
   ```

7. On the iPhone, enable mobile push for the server and set the alert channel's notification
   override to **All Messages**.

Treat the webhook URL like a password. Do not commit it or paste it into an issue, README, or chat.
When present, Discord takes priority over the existing Telegram and ntfy fallbacks. Alerts use a
rich embed whose title opens the exact Amazon application schedule.

## Deploy or reactivate

Requirements: Node.js 20 or newer and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler whoami
npm test
python3 -m unittest discover -s tests -v
npx wrangler deploy --dry-run
npm run deploy
```

`whoami` must show the intended Cloudflare account before deployment. The first deployment creates
the SQLite-backed Durable Object automatically.

The current [`wrangler.jsonc`](wrangler.jsonc) intentionally contains:

```jsonc
"triggers": { "crons": [] }
```

After Discord is tested successfully, reactivate five-minute checks by changing it to:

```jsonc
"triggers": { "crons": ["*/5 * * * *"] }
```

Then deploy again. Cron changes can take up to 15 minutes to propagate globally. To stop the
watcher later, restore the empty list and redeploy.

## Verify production

```bash
curl https://amazon-hourly-job-watcher.amazon-hourly-job-watcher-worker.workers.dev/health
npm run tail
```

The optional protected manual run endpoint requires a `WATCHER_TOKEN` secret:

```bash
npx wrangler secret put WATCHER_TOKEN
curl -X POST \
  -H 'Authorization: Bearer YOUR_WATCHER_TOKEN' \
  https://amazon-hourly-job-watcher.amazon-hourly-job-watcher-worker.workers.dev/run
```

The root endpoint and `/health` expose service status only. `/run` rejects requests unless the
exact bearer token is supplied.

## Change locations, schedules, or keywords

Edit [`config.json`](config.json). Each entry in `profiles` has independent locations, exact
facility IDs, keywords, allowed schedule types, preferred schedule types, and optional other-job
availability. The shared `day_shift_policy` controls acceptable fixed-shift hours.

Important fields:

```json
{
  "profiles": [
    {
      "id": "jason",
      "locations": [{ "city": "Oakley", "state": "CA" }],
      "required_site_ids": [],
      "allowed_schedule_types": ["PART_TIME", "FLEX_TIME"],
      "preferred_schedule_types": ["FLEX_TIME"],
      "other_job_availability": {
        "candidate_days": ["Tue", "Wed", "Thu", "Fri"],
        "required_free_days": 3
      }
    }
  ],
  "day_shift_policy": {
    "earliest_start": "05:00",
    "latest_start": "16:00",
    "latest_end": "23:00",
    "allow_flexible_shifts": true
  }
}
```

The Worker and local Python CLI share the same configuration. Matching is case-insensitive, while
facility identifiers and schedule-type codes are normalized to uppercase.

## Test and run locally

```bash
npm test
npx wrangler deploy --dry-run
python3 -m unittest discover -s tests -v
python3 -m amazon_job_watcher --dry-run
```

The Python dry run queries Amazon and prints current eligible schedules as JSON. It does not send a
push or modify `state/seen_jobs.json`. Its state is separate from Cloudflare production state.

Additional commands:

```bash
# Send one Discord test push from the local Python client
DISCORD_WEBHOOK_URL='your-secret-webhook' python3 -m amazon_job_watcher --test-notification

# Record current local matches without notifying
python3 -m amazon_job_watcher --baseline

# Use another configuration file
python3 -m amazon_job_watcher --config path/to/config.json --dry-run
```

## Reliability and safety

- **Strongly consistent coordination:** one Durable Object and a transactional run lease prevent
  overlapping checks.
- **Profile-scoped deduplication:** successful deliveries are keyed by profile plus Amazon schedule
  ID.
- **Safe delivery ordering:** schedule IDs are stored only after the push provider succeeds; a
  failed push is retried on the next run.
- **Rate limiting:** Amazon requests are at least one second apart, with bounded exponential retry
  and jitter for temporary failures.
- **Strict parsing:** unknown, malformed, overnight, too-early, and too-late fixed schedules fail
  closed rather than creating misleading alerts.
- **Exact facility matching:** the friend's search requires Amazon's DSM4 identifier.
- **State retention:** delivered records expire after 365 days.
- **Secrets:** notification and manual-run credentials are encrypted Cloudflare secrets and never
  stored in source control.
- **No auto-apply:** the project only reads public listings and sends official application links.

Worker observability is enabled in [`wrangler.jsonc`](wrangler.jsonc), and `/health` returns the
last run's status and counts by profile. Positions may fill between detection and opening the link.

## Cost and data-source limitations

At this personal polling rate, the watcher is designed to fit Cloudflare's free allowances. Review
Cloudflare's current plan screen before accepting any paid upgrade. Discord webhooks are free; ntfy
also has a free hosted tier but its shared-IP quota was unreliable from this Worker.

The source is `https://hiring.amazon.com/graphql`, the structured feed used by Amazon's official
hourly hiring site. Amazon may publish only a posting date rather than a precise timestamp; every
alert therefore includes both Amazon's value and the watcher's precise detection time.

This independent project is not affiliated with or endorsed by Amazon, Cloudflare, Discord,
Telegram, or ntfy. Use it responsibly and follow the applicable site and service terms.
