#!/usr/bin/env python3
"""Daily health check for every source in data/registry.json.

Writes data/health.json. One failed check never removes a source: a source is
marked "failing" after its first failure and "unavailable" only after
FAIL_LIMIT consecutive failed daily checks. A YouTube stream whose owner has
switched off embedding is marked "embed_disabled" straight away, because that
answer is definitive rather than a transient error.

Usage: python3 scripts/check_sources.py [--registry PATH] [--out PATH]
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FAIL_LIMIT = 3
USER_AGENT = "WorldInMotion-healthcheck/0.1 (+https://github.com/)"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def fetch(url: str, headers: dict | None = None, timeout: int = 25):
    """Return (status, body_bytes, content_type). Network errors give status 0."""
    # Digitraffic answers 406 unless the client accepts gzip, as every browser does.
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            if r.headers.get("Content-Encoding", "").lower() == "gzip":
                body = gzip.decompress(body)
            return r.status, body, r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, b"", e.headers.get("Content-Type", "") if e.headers else ""
    except Exception as e:  # noqa: BLE001 — DNS, timeout, TLS: all count as "error"
        return 0, str(e).encode(), ""


def check_source(source: dict, fetcher=fetch) -> dict:
    """Check one source. Returns {"result": ok|embed_disabled|gone|error, "detail": str}."""
    kind = source.get("kind")
    if kind == "video" and source.get("youtube"):
        watch = "https://www.youtube.com/watch?v=" + source["youtube"]
        url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(watch, safe="")
        status, body, _ = fetcher(url)
        if status == 200:
            try:
                author = json.loads(body).get("author_name", "")
            except ValueError:
                return {"result": "error", "detail": "oEmbed returned invalid JSON"}
            return {"result": "ok", "detail": f"embeddable · {author}" if author else "embeddable"}
        if status in (401, 403):
            return {"result": "embed_disabled", "detail": f"oEmbed {status}: owner does not allow embedding"}
        if status == 404:
            return {"result": "gone", "detail": "oEmbed 404: video removed or private"}
        return {"result": "error", "detail": f"oEmbed status {status}"}

    if kind == "data":
        status, body, _ = fetcher(source["endpoint"], source.get("headers"))
        if status != 200:
            return {"result": "error", "detail": f"HTTP {status}"}
        try:
            data = json.loads(body)
        except ValueError:
            return {"result": "error", "detail": "response was not JSON"}
        if isinstance(data, dict) and "features" in data:
            count = len(data["features"])
        elif isinstance(data, list):
            count = len(data)
        else:
            return {"result": "error", "detail": "unexpected response shape"}
        if count == 0:
            return {"result": "error", "detail": "feed returned no records"}
        return {"result": "ok", "detail": f"{count} records"}

    if kind == "still":
        status, body, ctype = fetcher(source["endpoint"])
        if status != 200:
            return {"result": "error", "detail": f"HTTP {status}"}
        if not ctype.startswith("image/"):
            return {"result": "error", "detail": f"not an image ({ctype or 'no content type'})"}
        if len(body) < 2000:
            return {"result": "error", "detail": "image suspiciously small"}
        return {"result": "ok", "detail": f"image {len(body) // 1024} KB"}

    return {"result": "error", "detail": f"no check defined for kind {kind!r}"}


def merge(previous: dict, results: dict, now_iso: str) -> dict:
    """Combine today's results with the previous health file."""
    out = {}
    for sid, res in results.items():
        prev = previous.get(sid, {})
        failures = 0 if res["result"] == "ok" else prev.get("consecutive_failures", 0) + 1
        if res["result"] == "ok":
            state = "ok"
        elif res["result"] == "embed_disabled":
            state = "embed_disabled"
        elif failures >= FAIL_LIMIT:
            state = "unavailable"
        else:
            state = "failing"
        out[sid] = {
            "state": state,
            "result": res["result"],
            "detail": res["detail"],
            "checked": now_iso,
            "consecutive_failures": failures,
            "last_ok": now_iso if res["result"] == "ok" else prev.get("last_ok"),
        }
    return out


def report(health: dict) -> str:
    bad = {k: v for k, v in health.items() if v["state"] != "ok"}
    lines = [f"{len(health) - len(bad)} of {len(health)} sources ok"]
    for sid, v in sorted(bad.items()):
        lines.append(f"  {v['state']:<15} {sid}: {v['detail']} (failures: {v['consecutive_failures']})")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", default=str(ROOT / "data" / "registry.json"))
    ap.add_argument("--out", default=str(ROOT / "data" / "health.json"))
    ap.add_argument("--pause", type=float, default=1.0, help="seconds between YouTube requests")
    args = ap.parse_args(argv)

    registry = json.loads(pathlib.Path(args.registry).read_text(encoding="utf-8"))
    out_path = pathlib.Path(args.out)
    previous = {}
    if out_path.exists():
        try:
            previous = json.loads(out_path.read_text(encoding="utf-8")).get("sources", {})
        except ValueError:
            previous = {}

    results = {}
    for source in registry["sources"]:
        results[source["id"]] = check_source(source)
        if source.get("youtube"):
            time.sleep(args.pause)  # be polite to YouTube

    now_iso = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    health = merge(previous, results, now_iso)
    out_path.write_text(
        json.dumps({"generated": now_iso, "fail_limit": FAIL_LIMIT, "sources": health}, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(report(health))
    return 0


if __name__ == "__main__":
    sys.exit(main())
