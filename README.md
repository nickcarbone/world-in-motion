# The World in Motion

A private wall of live public views of airports, ports and railways around the world, built for a second screen or wall display and browsable with a mouse.

It is a static site for GitHub Pages: no server, no build step, no accounts and no API keys.

## What's on it

- **Wall.** One large hero camera, four smaller cameras, three live data tiles from Finland (ships off Helsinki, departures from Helsinki Central, every train in the country) and one "quiet side" camera. The selection rotates every 10 minutes and favours places that are in daylight right now.
- **Index.** Every source as a card, filterable by type and by themed collection, sortable by daylight.
- **Detail view.** Click any tile or card for a large player with sound and controls, plus the source's operator, standing, licence, refresh rate and last health check.

## Honesty rules the page follows

- A tile only says **live video playing** when the YouTube player reports that it is playing. Otherwise it says *connecting*, *buffering*, *not playing — stream may be offline* or *embedding blocked*.
- Tiles that aren't playing show a **still from the stream** (YouTube's live thumbnail, which YouTube refreshes about every five minutes). The label says so, with the time it was loaded. Streams whose thumbnail is channel artwork get a plain placeholder instead.
- Data tiles show **fresh / delayed / stale** against each feed's own cadence, the time of the newest record and the time it was fetched. If an update fails, the last good data stays up and is labelled stale.
- Train delays appear only when Digitraffic supplies an estimate. Nothing is inferred from the timetable.

## Deploying

1. Create a **public** repository on GitHub and push these files to the `main` branch.
2. In the repository, go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick `main` and `/ (root)`, then save. The site appears at `https://<your-username>.github.io/<repo-name>/` within a minute or two.
3. Go to **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**, so the daily health check can commit its results.
4. Open the **Actions** tab, enable workflows if GitHub asks, then run **Source health check** once by hand (*Run workflow*). After that it runs daily at 06:17 UTC.
5. Make sure **Issues** are enabled (Settings → General → Features). The footer's removal-request link opens a pre-filled issue in this repository; the address is worked out from the Pages URL, so there is nothing to configure.

The page carries `noindex, nofollow`, so search engines are asked not to list it. Anyone with the URL can still open it.

### Running it locally

Modules don't load from `file://`, so serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

### Tests

```sh
python3 -m unittest discover -s tests -v   # registry structure and the health checker
node --test tests/logic.test.mjs           # curation, freshness, daylight, departure parsing
```

Both suites also run on every push (`.github/workflows/test.yml`).

## How it fits together

| Path | What it is |
|---|---|
| `data/registry.json` | The editorial source list and themed collections. Edit by hand. |
| `data/health.json` | Written by the daily check. Don't edit by hand. |
| `js/logic.js` | Pure functions: curation, daylight, freshness, parsing. Tested. |
| `js/app.js` | The page: wall, index, detail view, players, data tiles. |
| `css/styles.css` | The Observatory design. Colours are custom properties at the top. |
| `scripts/check_sources.py` | Daily health check. Standard library only. |
| `.github/workflows/` | Daily health check and tests. |

**Why the data tiles need no scheduled job:** Digitraffic allows direct browser requests (`Access-Control-Allow-Origin: *`), so the page fetches each feed itself, about once a minute. GitHub Actions only runs the daily health check, which keeps Actions use to a minute or two a day.

**Why the daily commit matters:** GitHub switches off scheduled workflows in a public repository after 60 days without activity. The health check commits `data/health.json` whenever anything changes, including its timestamp, which keeps the schedule alive.

## Health policy

- `ok` — passed today's check.
- `failing` — failed one or two consecutive daily checks. Still shown.
- `unavailable` — failed three in a row. Hidden from the wall, and from the index unless *Show unavailable* is ticked. It comes back automatically on the next pass.
- `embed_disabled` — the YouTube owner has switched embedding off. Taken off the wall straight away, because that answer is definitive.

The check confirms a stream can be embedded and that feeds return sensible data. It cannot confirm that a camera is pointing at anything interesting, or that a stream is live at that moment. That is the player's job on the page, which reports what it actually sees.

## Known limits

- Coverage leans on Europe, North America and Japan. Nothing usable was found in Africa, the Middle East, South Asia or Hong Kong, so the hours when only Asia and the Pacific are in daylight (roughly 00:00–03:00 UTC) show more night views.
- Most cameras are independent YouTube streams that can disappear without notice. The health check will catch that within a day.
- Some channels change their stream ID when they restart, Kyoto Station's in particular. When that happens the check marks the source `gone` and the registry needs the new ID.

See [SOURCES.md](SOURCES.md) for how to find, test and add sources.
