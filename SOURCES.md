# Finding, testing and adding sources

## Where good sources come from

**Cameras** are almost all YouTube live streams. The quickest way to find them is YouTube search with the *Live* filter, for terms like `port live cam`, `railway live camera`, `airport live 24/7`, or the same in the local language (`aeropuerto en vivo`, `Flughafen live`, `ライブカメラ 駅`).

Prefer, in this order:

1. Channels run by the operator itself (Port of Rotterdam, Dublin Port, Port of Helsinki, ProRail).
2. Channels run with the operator's cooperation (Railcam with Network Rail at York).
3. Established independent channels that run many 24/7 streams (Flightradar24, Virtual Railfan, livespotting).
4. Single hobbyist streams, as a last resort.

Skip streams that loop recorded footage, that are mostly a music channel with a camera attached, or whose thumbnail is promotional art you wouldn't want on the wall.

**Data feeds** need to allow direct browser requests (`Access-Control-Allow-Origin: *`) and to be free without a key. Fintraffic's Digitraffic is the model. A feed that needs a key or blocks browsers would need a scheduled job to fetch it, so leave it out unless it's worth that work.

## Testing a candidate

For a YouTube stream with video ID `VIDEOID`:

```sh
# 200 = embeddable (also prints the channel); 401 or 403 = embedding switched off; 404 = gone
curl -s -o /dev/null -w "%{http_code}\n" "https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=VIDEOID"

# Is the live thumbnail a real frame or channel artwork? Open it and look.
open "https://i.ytimg.com/vi/VIDEOID/maxresdefault_live.jpg"
```

Look at the thumbnail at least twice, a few minutes apart. A real frame changes; artwork doesn't.

For a data feed:

```sh
curl -s --compressed -D - -o /dev/null -H "Origin: https://example.github.io" "FEED_URL" | grep -i access-control-allow-origin
```

## Adding an entry

Add an object to `sources` in `data/registry.json`. A camera:

```json
{
  "id": "sea-xyz-harbour",
  "name": "Harbour entrance",
  "place": "Town",
  "country": "XX",
  "tz": "Region/City",
  "lat": 0.0,
  "lon": 0.0,
  "category": "port",
  "kind": "video",
  "youtube": "VIDEOID",
  "operator": "Channel name",
  "official": false,
  "preview": "frame",
  "notes": "What makes it worth a place on the wall."
}
```

| Field | Values |
|---|---|
| `id` | `air-`, `sea-` or `rail-` plus a short slug. Never reuse an old ID. |
| `country` | Two-letter ISO code. |
| `tz` | An IANA time zone such as `Europe/Paris`. The tests reject made-up ones. |
| `lat`, `lon` | City or site level is enough; it drives the daylight calculation. |
| `category` | `airport`, `port` (anything on water) or `rail`. |
| `kind` | `video`, `still` (a refreshing image, with `endpoint` and `cadence_s`) or `data` (a JSON feed, with `endpoint`, `cadence_s` and `licence`). |
| `official` | `true` (operator's own), `"partner"`, `"unconfirmed"` or `false`. |
| `preview` | `"frame"` if the live thumbnail is a real picture, otherwise `"artwork"`. |

To put a source in a themed collection, add its ID to one of the lists under `collections`. To make a new collection, add a key with a `title` and `ids`; it appears as a filter on the index automatically.

A new `data` source also needs a renderer in `js/app.js` (`DATA_TILES`). Cameras and stills need nothing beyond the registry entry.

Run the tests before pushing:

```sh
python3 -m unittest discover -s tests && node --test tests/logic.test.mjs
```

## Disabling or removing an entry

- **To take something off the wall for now**, move its object out of `sources` into `rejected` with a `reason`. The record of why stays in the file.
- **For a removal request from a rights holder**, do the same, give the issue number in the `reason`, then close the issue.
- **Stream ID changed** (the check reports `gone`): find the channel's current live stream, test it as above, and replace the `youtube` value. Keep the same `id`.

Don't delete an entry because of one bad day. The health check already hides a source after three failed days and brings it back when it recovers.
