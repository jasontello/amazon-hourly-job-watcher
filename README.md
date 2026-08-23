# Amazon Hourly Job Watcher

A lightweight, hosted watcher for Amazon hourly warehouse jobs in **Oakley, California** and
**Vacaville, California**, with extra urgency for Flex Time / FlexPT / Flexible Shifts schedules.

It checks Amazon's official hourly hiring feed every five minutes, detects new matching schedules,
stores what it has already reported, and sends an ntfy push notification to an iPhone. It never
logs in, fills out an application, or applies automatically.

## What the notification contains

- Job title and location
- Shift type and exact schedule text
- Hours per week and employment type
- Hourly pay when Amazon lists it
- Amazon's posting date and the exact detection time
- First-day date when available
- A direct official Amazon application link with the job and schedule preselected

When one posting contains several new schedules, the watcher groups them into one notification to
avoid alert spam. It still stores each schedule ID separately, so a Flex schedule added later to an
existing posting creates a fresh alert.

## Architecture

```text
GitHub Actions (every 5 minutes)
  -> Amazon official hourly-jobs GraphQL feed
  -> exact city/state + warehouse keyword filters
  -> job details and selectable schedule details
  -> compare schedule IDs with state/seen_jobs.json
  -> ntfy push to iPhone
  -> commit newly seen schedule IDs back to the repository
```

The project uses only the Python standard library. There are no servers, databases, package installs,
browser automation, or paid dependencies.

## iPhone setup with ntfy

1. Install [ntfy from the iOS App Store](https://apps.apple.com/us/app/ntfy/id1625396347).
2. Create a long, hard-to-guess topic, such as `amazon-oakley-vacaville-` followed by a UUID.
   A topic on the public `ntfy.sh` server works like a password: anyone who knows it can subscribe.
3. Subscribe to that exact topic in the ntfy app and allow notifications.
4. In this GitHub repository, open **Settings -> Secrets and variables -> Actions**.
5. Add a repository secret named `NTFY_TOPIC` containing the topic.
6. Optional: add `NTFY_SERVER` if using a server other than `https://ntfy.sh`.
7. Optional: add `NTFY_TOKEN` if the chosen ntfy server requires a bearer token.

The scheduled workflow safely skips live checks until `NTFY_TOPIC` exists, so an unconfigured fork
does not fail every five minutes.

### Send a test push

From a local terminal:

```bash
export NTFY_TOPIC='your-long-random-topic'
python3 -m amazon_job_watcher --test-notification
```

Or open **Actions -> Watch Amazon hourly jobs -> Run workflow** after adding the secret. A normal
manual run performs a real check and sends current unseen matches.

## First-run behavior

By default, the first live run notifies you about matching jobs that are already open. That is useful
because an existing opening is still actionable.

To start with a silent baseline instead, open **Actions -> Watch Amazon hourly jobs -> Run workflow**,
enable **Record current matches without sending notifications**, and run it once before adding the
ntfy topic. The workflow writes those schedule IDs to the state file without sending pushes.

## Change locations or keywords

Edit [`config.json`](config.json):

```json
{
  "locations": [
    { "city": "Oakley", "state": "CA" },
    { "city": "Vacaville", "state": "CA" }
  ],
  "include_keywords": [
    "warehouse",
    "fulfillment center",
    "sortation center",
    "delivery station",
    "package sorter"
  ],
  "preferred_shift_keywords": [
    "flex_time",
    "flex time",
    "flexible shifts",
    "flexpt",
    "flex pt"
  ]
}
```

Location matching is exact and case-insensitive. A job must match one configured city/state pair and
one `include_keywords` entry. Preferred shift keywords do not exclude other warehouse jobs; they make
matching Flex alerts use ntfy's **urgent** priority instead of **high**.

Commit and push the config change. The next scheduled run uses it automatically.

## Run locally

Requires Python 3.11 or newer.

```bash
python3 -m unittest discover -s tests -v
python3 -m amazon_job_watcher --dry-run
```

`--dry-run` queries Amazon and prints unseen matches as JSON. It does not send a push or modify the
seen-state file.

Other commands:

```bash
# Record current matches without notifying
python3 -m amazon_job_watcher --baseline

# Use another configuration file
python3 -m amazon_job_watcher --config path/to/config.json --dry-run
```

## Reliability and safety

- **Deduplication:** keyed by Amazon schedule ID and persisted in Git.
- **Crash-safe writes:** state is written to a temporary file, synced, and atomically replaced.
- **Delivery ordering:** an item is marked seen only after ntfy accepts the notification.
- **Partial-failure safety:** each successfully delivered job batch is saved immediately.
- **Retries:** transient network errors, HTTP 403/408/429, and server errors use bounded exponential
  backoff with jitter.
- **Rate limiting:** Amazon requests are spaced by at least one second and only matching job cards
  trigger detail/schedule requests.
- **Schema checks:** unexpected API response shapes fail loudly instead of silently recording bad data.
- **Concurrency:** GitHub Actions allows only one watcher run at a time.
- **Secrets:** the ntfy topic/token live in GitHub Actions secrets, never in source control or logs.
- **No auto-apply:** the program only reads public listings and sends links.

Logs are available under the repository's **Actions** tab. If Amazon changes its feed, the run fails
and preserves the previous seen state so a repaired run can alert normally.

## Hosting cost and timing

The five-minute cron is the shortest schedule interval GitHub Actions supports. Scheduled runs can be
delayed during high load, so this is near-real-time rather than a hard real-time guarantee.

Standard GitHub-hosted runners are free for public repositories. Private repositories consume the
account's included Actions minutes; at a five-minute cadence that can exceed the monthly allowance.
For a private repository, either change the cron to every 15-30 minutes or monitor billing.

To change the interval, edit [`.github/workflows/watch-jobs.yml`](.github/workflows/watch-jobs.yml):

```yaml
- cron: "*/10 * * * *" # every 10 minutes
```

Do not poll more often than every five minutes. The one-second internal request spacing is intentional.

## Data source and limitations

The watcher uses `https://hiring.amazon.com/graphql`, the same structured hourly-job and schedule feed
used by Amazon's official hiring site. Amazon currently reports the posting **date**, not a precise
posting timestamp; notifications therefore include both that date and the watcher's precise detection
time. Positions can fill between detection and opening the link.

This project is independent and is not affiliated with or endorsed by Amazon or ntfy. Use it responsibly
and follow the applicable site and service terms.

