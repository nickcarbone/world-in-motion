import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { curate, departureRows, freshness, hash01, isUsable, lightAt, projector, sunElevation } from '../js/logic.js';

const registry = JSON.parse(readFileSync(new URL('../data/registry.json', import.meta.url), 'utf8'));
const quietIds = registry.collections.quiet.ids;

test('freshness follows the source cadence', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(freshness(now - 30_000, now, 60), 'fresh');
  assert.equal(freshness(now - 5 * 60_000, now, 60), 'delayed');
  assert.equal(freshness(now - 30 * 60_000, now, 60), 'stale');
  // the same age is fresh for a slow source
  assert.equal(freshness(now - 30 * 60_000, now, 600), 'fresh');
});

test('freshness refuses to guess', () => {
  const now = Date.now();
  assert.equal(freshness(NaN, now, 60), 'unknown');
  assert.equal(freshness(now, now, 0), 'unknown');
  assert.equal(freshness(now + 3_600_000, now, 60), 'unknown'); // timestamp from the future
});

test('sun elevation is sensible', () => {
  // March equinox, solar noon at Greenwich on the equator: sun nearly overhead.
  assert.ok(sunElevation(0, 0, new Date('2026-03-20T12:07:00Z')) > 85);
  // Midnight UTC in London in winter: well below the horizon.
  assert.ok(sunElevation(51.5, 0, new Date('2026-12-21T00:00:00Z')) < -40);
  // Midsummer midnight in northern Greenland: the sun stays up.
  assert.equal(lightAt(76.5, -68.7, new Date('2026-06-21T04:00:00Z')), 'day');
  // Tokyo at 03:00 local is night.
  assert.equal(lightAt(35.69, 139.7, new Date('2026-10-21T18:00:00Z')), 'night');
});

test('hash01 is deterministic and in range', () => {
  assert.equal(hash01('abc'), hash01('abc'));
  assert.notEqual(hash01('abc'), hash01('abd'));
  for (const s of ['', 'x', 'air-lhr-fr24:123']) {
    const h = hash01(s);
    assert.ok(h >= 0 && h < 1);
  }
});

test('isUsable respects the health check', () => {
  const s = { id: 'a' };
  assert.equal(isUsable(s, {}), true);
  assert.equal(isUsable(s, { a: { state: 'failing' } }), true); // one failure is not enough to hide it
  assert.equal(isUsable(s, { a: { state: 'unavailable' } }), false);
  assert.equal(isUsable(s, { a: { state: 'embed_disabled' } }), false);
});

test('curation is deterministic within a slot and varied, with no duplicates', () => {
  const now = new Date('2026-10-21T18:05:00Z');
  const a = curate(registry.sources, { now, quietIds });
  const b = curate(registry.sources, { now: new Date('2026-10-21T18:09:00Z'), quietIds });
  assert.deepEqual(a.grid.map((s) => s.id), b.grid.map((s) => s.id));
  assert.equal(a.hero.id, b.hero.id);

  const all = [a.hero, ...a.grid, a.quiet].filter(Boolean).map((s) => s.id);
  assert.equal(new Set(all).size, all.length);
  assert.equal(a.grid.length, 4);
  assert.ok(quietIds.includes(a.quiet.id));
  assert.ok(!quietIds.includes(a.hero.id));

  const cats = new Set([a.hero, ...a.grid].map((s) => s.category));
  assert.deepEqual([...cats].sort(), ['airport', 'port', 'rail']);
  for (const s of [a.hero, ...a.grid]) assert.equal(s.kind, 'video');
});

test('curation favours daylight', () => {
  // At 13:00 UTC Europe and the Americas' east coast are lit; Japan and Australia are dark.
  for (const hour of ['13', '14', '15']) {
    const pick = curate(registry.sources, { now: new Date(`2026-10-21T${hour}:00:00Z`), quietIds });
    const lit = [pick.hero, ...pick.grid].filter((s) => lightAt(s.lat, s.lon, new Date(`2026-10-21T${hour}:00:00Z`)) !== 'night');
    assert.ok(lit.length >= 4, `only ${lit.length} lit at ${hour}:00`);
  }
});

test('curation rotates between slots', () => {
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const pick = curate(registry.sources, { now: new Date(Date.parse('2026-10-21T12:00:00Z') + i * 600_000), quietIds });
    seen.add(pick.hero.id);
    pick.grid.forEach((s) => seen.add(s.id));
  }
  assert.ok(seen.size >= 8, `only ${seen.size} different cameras across two hours`);
});

test('curation skips sources the health check has ruled out', () => {
  const now = new Date('2026-10-21T18:05:00Z');
  const first = curate(registry.sources, { now, quietIds });
  const health = { [first.hero.id]: { state: 'unavailable' } };
  const second = curate(registry.sources, { now, quietIds, health });
  assert.notEqual(second.hero.id, first.hero.id);
});

test('curation survives an empty or tiny registry', () => {
  const none = curate([], { quietIds });
  assert.equal(none.hero, null);
  assert.deepEqual(none.grid, []);
  const one = curate([registry.sources[0]], { quietIds });
  assert.equal(one.hero.id, registry.sources[0].id);
  assert.equal(one.grid.length, 0);
});

test('projector keeps points inside the box', () => {
  const p = projector([19.4, 59.7, 31.7, 70.1], 400, 220);
  for (const [lon, lat] of [[19.4, 59.7], [31.7, 70.1], [24.94, 60.17]]) {
    const [x, y] = p(lon, lat);
    assert.ok(x >= -0.01 && x <= 400.01 && y >= -0.01 && y <= 220.01, `${lon},${lat} -> ${x},${y}`);
  }
});

test('departure rows use only what the feed supplies', () => {
  const now = new Date('2026-10-21T18:00:00Z');
  const trains = [
    {
      trainType: 'S', trainNumber: 115, commuterLineID: '', cancelled: false,
      timeTableRows: [
        { stationShortCode: 'HKI', type: 'DEPARTURE', scheduledTime: '2026-10-21T18:14:00.000Z', commercialTrack: '10', trainStopping: true },
        { stationShortCode: 'TKU', type: 'ARRIVAL', scheduledTime: '2026-10-21T20:14:00.000Z' },
      ],
    },
    {
      trainType: 'HL', trainNumber: 8211, commuterLineID: 'A', cancelled: false,
      timeTableRows: [
        { stationShortCode: 'HKI', type: 'DEPARTURE', scheduledTime: '2026-10-21T18:03:00.000Z', liveEstimateTime: '2026-10-21T18:06:00.000Z', differenceInMinutes: 3, commercialTrack: '16', trainStopping: true },
        { stationShortCode: 'LPV', type: 'ARRIVAL', scheduledTime: '2026-10-21T18:15:00.000Z' },
      ],
    },
    {
      // left ten minutes ago: must be dropped
      trainType: 'HL', trainNumber: 9000, commuterLineID: 'P',
      timeTableRows: [
        { stationShortCode: 'HKI', type: 'DEPARTURE', scheduledTime: '2026-10-21T17:50:00.000Z', actualTime: '2026-10-21T17:50:30.000Z' },
        { stationShortCode: 'HKI', type: 'ARRIVAL', scheduledTime: '2026-10-21T18:40:00.000Z' },
      ],
    },
  ];
  const rows = departureRows(trains, 'HKI', { TKU: 'Turku asema', LPV: 'Leppävaara' }, now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].line, 'A');
  assert.equal(rows[0].destination, 'Leppävaara');
  assert.equal(rows[0].delayMin, 3);
  assert.equal(rows[1].line, 'S 115');
  assert.equal(rows[1].destination, 'Turku'); // " asema" stripped
  assert.equal(rows[1].delayMin, null); // no estimate supplied, so no delay claimed
});

test('loop services are labelled as ring lines', () => {
  const now = new Date('2026-10-21T18:00:00Z');
  const trains = [
    {
      trainType: 'HL', trainNumber: 8936, commuterLineID: 'I',
      timeTableRows: [
        { stationShortCode: 'HKI', type: 'DEPARTURE', scheduledTime: '2026-10-21T18:06:00.000Z', commercialTrack: '5' },
        { stationShortCode: 'LEN', type: 'ARRIVAL', scheduledTime: '2026-10-21T18:35:00.000Z' },
        { stationShortCode: 'HKI', type: 'ARRIVAL', scheduledTime: '2026-10-21T19:06:00.000Z' },
      ],
    },
  ];
  assert.equal(departureRows(trains, 'HKI', {}, now)[0].destination, 'Ring line');
});

test('departure rows tolerate junk input', () => {
  assert.deepEqual(departureRows(null, 'HKI', {}), []);
  assert.deepEqual(departureRows([{ timeTableRows: [] }], 'HKI', {}), []);
});
