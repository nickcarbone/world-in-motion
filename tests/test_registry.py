"""Structural checks on data/registry.json, run in CI before anything is deployed."""
import json
import pathlib
import re
import unittest
from zoneinfo import ZoneInfo

REGISTRY = json.loads((pathlib.Path(__file__).resolve().parent.parent / "data" / "registry.json").read_text(encoding="utf-8"))
SOURCES = REGISTRY["sources"]
KINDS = {"video", "still", "data"}
CATEGORIES = {"airport", "port", "rail"}
OFFICIAL = {True, False, "partner", "unconfirmed"}


class Registry(unittest.TestCase):
    def test_ids_unique(self):
        ids = [s["id"] for s in SOURCES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_youtube_ids_unique(self):
        yt = [s["youtube"] for s in SOURCES if s.get("youtube")]
        self.assertEqual(len(yt), len(set(yt)))

    def test_required_fields(self):
        for s in SOURCES:
            for field in ("id", "name", "place", "country", "tz", "lat", "lon", "category", "kind", "operator", "official"):
                self.assertIn(field, s, f"{s.get('id')} is missing {field}")

    def test_values(self):
        for s in SOURCES:
            with self.subTest(s["id"]):
                self.assertIn(s["kind"], KINDS)
                self.assertIn(s["category"], CATEGORIES)
                self.assertIn(s["official"], OFFICIAL)
                self.assertTrue(-90 <= s["lat"] <= 90 and -180 <= s["lon"] <= 180)
                self.assertRegex(s["country"], r"^[A-Z]{2}$")
                ZoneInfo(s["tz"])  # raises if the timezone is not real

    def test_kind_specific_fields(self):
        for s in SOURCES:
            with self.subTest(s["id"]):
                if s["kind"] == "video":
                    self.assertRegex(s.get("youtube", ""), r"^[A-Za-z0-9_-]{11}$")
                    self.assertIn(s.get("preview"), {"frame", "artwork"})
                else:
                    self.assertTrue(s.get("endpoint", "").startswith("https://"))
                    self.assertGreater(s.get("cadence_s", 0), 0)
                    self.assertTrue(s.get("licence"), "open data must state its licence")

    def test_collections_reference_real_sources(self):
        ids = {s["id"] for s in SOURCES}
        for key, col in REGISTRY["collections"].items():
            with self.subTest(key):
                self.assertTrue(col["title"])
                for sid in col["ids"]:
                    self.assertIn(sid, ids)

    def test_no_secrets(self):
        text = json.dumps(REGISTRY).lower()
        self.assertIsNone(re.search(r"(api[_-]?key|token|secret)\W*[:=]", text))


if __name__ == "__main__":
    unittest.main()
