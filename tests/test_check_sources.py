import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import check_sources as cs  # noqa: E402


def fake(status, body=b"", ctype="application/json"):
    return lambda url, headers=None: (status, body, ctype)


VIDEO = {"id": "v", "kind": "video", "youtube": "abcdefghijk"}
DATA = {"id": "d", "kind": "data", "endpoint": "https://example.test/feed"}
STILL = {"id": "s", "kind": "still", "endpoint": "https://example.test/cam.jpg"}


class CheckSource(unittest.TestCase):
    def test_embeddable_video(self):
        r = cs.check_source(VIDEO, fake(200, json.dumps({"author_name": "Port of X"}).encode()))
        self.assertEqual(r["result"], "ok")
        self.assertIn("Port of X", r["detail"])

    def test_embedding_disabled(self):
        self.assertEqual(cs.check_source(VIDEO, fake(401))["result"], "embed_disabled")
        self.assertEqual(cs.check_source(VIDEO, fake(403))["result"], "embed_disabled")

    def test_video_gone(self):
        self.assertEqual(cs.check_source(VIDEO, fake(404))["result"], "gone")

    def test_network_error(self):
        self.assertEqual(cs.check_source(VIDEO, fake(0, b"timed out"))["result"], "error")

    def test_bad_oembed_json(self):
        self.assertEqual(cs.check_source(VIDEO, fake(200, b"<html>"))["result"], "error")

    def test_geojson_feed(self):
        body = json.dumps({"features": [{}, {}, {}]}).encode()
        r = cs.check_source(DATA, fake(200, body))
        self.assertEqual(r, {"result": "ok", "detail": "3 records"})

    def test_list_feed(self):
        self.assertEqual(cs.check_source(DATA, fake(200, b"[1,2]"))["detail"], "2 records")

    def test_empty_feed_is_an_error(self):
        self.assertEqual(cs.check_source(DATA, fake(200, b"[]"))["result"], "error")

    def test_feed_schema_change(self):
        self.assertEqual(cs.check_source(DATA, fake(200, b'{"items": []}'))["result"], "error")

    def test_feed_http_error(self):
        self.assertEqual(cs.check_source(DATA, fake(503))["detail"], "HTTP 503")

    def test_still_ok(self):
        r = cs.check_source(STILL, fake(200, b"x" * 5000, "image/jpeg"))
        self.assertEqual(r["result"], "ok")

    def test_still_not_image(self):
        r = cs.check_source(STILL, fake(200, b"x" * 5000, "text/html"))
        self.assertEqual(r["result"], "error")

    def test_unknown_kind(self):
        self.assertEqual(cs.check_source({"id": "x", "kind": "mystery"}, fake(200))["result"], "error")


class Merge(unittest.TestCase):
    NOW = "2026-10-21T12:00:00Z"

    def test_first_failure_is_failing_not_removed(self):
        h = cs.merge({}, {"a": {"result": "error", "detail": "HTTP 500"}}, self.NOW)
        self.assertEqual(h["a"]["state"], "failing")
        self.assertEqual(h["a"]["consecutive_failures"], 1)

    def test_unavailable_after_limit(self):
        prev = {"a": {"consecutive_failures": cs.FAIL_LIMIT - 1, "last_ok": "2026-10-01T00:00:00Z"}}
        h = cs.merge(prev, {"a": {"result": "error", "detail": "x"}}, self.NOW)
        self.assertEqual(h["a"]["state"], "unavailable")
        self.assertEqual(h["a"]["last_ok"], "2026-10-01T00:00:00Z")  # last good time retained

    def test_recovery_resets_count(self):
        prev = {"a": {"consecutive_failures": 5, "state": "unavailable"}}
        h = cs.merge(prev, {"a": {"result": "ok", "detail": "fine"}}, self.NOW)
        self.assertEqual(h["a"]["state"], "ok")
        self.assertEqual(h["a"]["consecutive_failures"], 0)
        self.assertEqual(h["a"]["last_ok"], self.NOW)

    def test_embed_disabled_is_immediate(self):
        h = cs.merge({}, {"a": {"result": "embed_disabled", "detail": "401"}}, self.NOW)
        self.assertEqual(h["a"]["state"], "embed_disabled")


if __name__ == "__main__":
    unittest.main()
