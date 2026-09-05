# Amazon Day-Shift Job Watcher

A hosted, notification-only watcher for two Amazon warehouse job searches:

- **Jason:** Oakley or Vacaville, California; part-time or Flex/FlexPT; compatible with a
  three-day Digital NEST schedule chosen from Tuesday through Friday.
- **Kevin:** **DSM4** at 3620 Ramos Drive, **HSM1** at 3640 Ramos Drive, or another Amazon listing
  explicitly located on Ramos Drive in West Sacramento; confirmed full-time, sleep-safe/day
  schedules only.

It reads Amazon's official hourly hiring feed, evaluates every selectable schedule, remembers
which schedules were already delivered, and pushes new matches to an iPhone. It never signs in,
fills an application, or applies automatically.

> **Production status:** active. The Worker checks every five minutes and sends direct-mention
> alerts to the verified private Discord channel. The existing ntfy credentials remain installed
> as a fallback, but ntfy previously rate-limited Cloudflare's shared outbound IP. Kevin's email
> route remains pending until the one-time Google Apps Script authorization below is completed.

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

### Kevin — Ramos Drive, West Sacramento

The job must be in West Sacramento and match `DSM4`, `HSM1`, or an address containing Ramos Drive.
Amazon's own facility list maps DSM4 to 3620 Ramos Drive and HSM1 to 3640 Ramos Drive, so HSM1 is
the defined nearby same-block facility. Other West Sacramento buildings are rejected.

Only schedules classified as `FULL_TIME` are allowed. Flexible, part-time, and unknown-hour listings
are rejected for this profile: every emailed schedule must list fixed hours that pass the shared
sleep-safe window and do not cross midnight.

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
  -> authenticated Google Apps Script bridge -> email from Jason's Google account to Kevin
  -> store a separate delivered ID after each channel succeeds

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

## Enable Kevin's email alerts (free)

Cloudflare Workers cannot sign in to Gmail directly. The included
[`Code.gs`](apps-script-email-bridge/Code.gs) is a minimal Google Apps Script bridge that can only
send email; it does not read the account's inbox. The recipient stays in Google Script Properties
and is not committed to this repository.

1. Sign in to the Google account that should appear as the sender, open
   [script.new](https://script.new), and name the project **Amazon Job Watcher Email Bridge**.
2. Replace the editor contents with the complete contents of
   [`apps-script-email-bridge/Code.gs`](apps-script-email-bridge/Code.gs), then save.
3. Open **Project Settings → Script properties → Add script property** and create:

   - `ALERT_RECIPIENT`: Kevin's email address.
   - `WEBHOOK_SECRET`: a random value of at least 32 characters. Store the same value in
     Cloudflare with `npx wrangler secret put EMAIL_WEBHOOK_SECRET`.

4. Choose **Deploy → New deployment → Web app**. Set **Execute as: Me** and
   **Who has access: Anyone**, then deploy and approve the send-email permission.
5. Copy the `/exec` web-app URL. Store it as an encrypted Cloudflare secret:

   ```bash
   npx wrangler secret put EMAIL_WEBHOOK_URL
   ```

The public endpoint is protected by the long shared secret, only accepts bounded message payloads,
and remembers delivery IDs to suppress retries. The Worker also refuses to send that secret to any
host except an official `script.google.com/macros/s/.../exec` URL.

To avoid spam, schedules are deduplicated by Amazon schedule ID for each delivery channel, all new
schedules under one posting are batched into a single message, and the email bridge rejects a replay
of the same delivery ID. A schedule is eligible for Kevin only once Amazon explicitly labels it
`FULL_TIME` and provides fixed daytime hours.

Google documents that [`MailApp` sends email without accessing the
inbox](https://developers.google.com/apps-script/reference/mail/mail-app) and that consumer accounts
have a [daily quota of 100 recipients](https://developers.google.com/apps-script/guides/services/quotas),
which is ample for this low-volume watcher. No test or real email is sent until both Cloudflare
secrets are installed. Once enabled, a failed email remains pending without causing the
already-successful Discord notification to repeat.

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

The current [`wrangler.jsonc`](wrangler.jsonc) enables five-minute checks:

```jsonc
"triggers": { "crons": ["*/5 * * * *"] }
```

To pause automatic checks, change it to:

```jsonc
"triggers": { "crons": [] }
```

Then deploy again. Cron changes can take up to 15 minutes to propagate globally. Restore the
five-minute expression and redeploy to reactivate it.

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

Edit [`config.json`](config.json). Each entry in `profiles` has independent locations, facility
matching, keywords, allowed schedule types, preferred schedule types, flexible-shift policy,
notification channels, and optional other-job availability. The shared `day_shift_policy` controls
acceptable fixed-shift hours.

Important fields:

```json
{
  "profiles": [
    {
      "id": "jason",
      "locations": [{ "city": "Oakley", "state": "CA" }],
      "facility_match": null,
      "allowed_schedule_types": ["PART_TIME", "FLEX_TIME"],
      "preferred_schedule_types": ["FLEX_TIME"],
      "allow_flexible_shifts": true,
      "notification_channels": ["push"],
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
- **Channel-scoped deduplication:** successful deliveries are keyed by channel, profile, and Amazon
  schedule ID, so an email retry cannot duplicate a successful Discord push.
- **Safe delivery ordering:** each channel's schedule IDs are stored only after that channel
  succeeds; failed delivery is retried on the next run.
- **Rate limiting:** Amazon requests are at least one second apart, with bounded exponential retry
  and jitter for temporary failures.
- **Strict parsing:** unknown, malformed, overnight, too-early, and too-late fixed schedules fail
  closed rather than creating misleading alerts.
- **Bounded facility matching:** Kevin's search accepts DSM4, same-block HSM1, or an explicit Ramos
  Drive address while rejecting unrelated West Sacramento sites.
- **State retention:** delivered records expire after 365 days.
- **Secrets:** notification and manual-run credentials are encrypted Cloudflare secrets and never
  stored in source control.
- **No auto-apply:** the project only reads public listings and sends official application links.

Worker observability is enabled in [`wrangler.jsonc`](wrangler.jsonc), and `/health` returns the
last run's status and counts by profile. Positions may fill between detection and opening the link.

## Cost and data-source limitations

At this personal polling rate, the watcher is designed to fit Cloudflare's free allowances. Review
Cloudflare's current plan screen before accepting any paid upgrade. Discord webhooks and the Google
Apps Script email bridge are free at this watcher's expected volume; ntfy also has a free hosted
tier but its shared-IP quota was unreliable from this Worker.

The source is `https://hiring.amazon.com/graphql`, the structured feed used by Amazon's official
hourly hiring site. Amazon may publish only a posting date rather than a precise timestamp; every
alert therefore includes both Amazon's value and the watcher's precise detection time.

This independent project is not affiliated with or endorsed by Amazon, Cloudflare, Discord,
Telegram, or ntfy. Use it responsibly and follow the applicable site and service terms.
