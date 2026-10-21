// Pure functions shared by the page and the tests. No DOM access here.

/** Freshness of a record, judged against the source's own expected cadence. */
export function freshness(recordTimeMs, nowMs, cadenceSec) {
  if (!Number.isFinite(recordTimeMs) || !Number.isFinite(cadenceSec) || cadenceSec <= 0) return 'unknown';
  const ageSec = (nowMs - recordTimeMs) / 1000;
  if (ageSec < -300) return 'unknown'; // record claims to be from the future: clock problem
  if (ageSec <= cadenceSec * 3) return 'fresh';
  if (ageSec <= cadenceSec * 10) return 'delayed';
  return 'stale';
}

/**
 * Approximate solar elevation in degrees (good to about half a degree,
 * plenty for deciding whether a camera is in daylight).
 */
export function sunElevation(lat, lon, date) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5; // days since 2000-01-01 12:00 UTC
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmstHours = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const hourAngle = (gmstHours * 15 + lon) * rad - ra;
  const el = Math.asin(
    Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(hourAngle)
  );
  return el / rad;
}

export function lightAt(lat, lon, date) {
  const el = sunElevation(lat, lon, date);
  if (el > 0) return 'day';
  if (el > -6) return 'twilight';
  return 'night';
}

/** Deterministic hash of a string into [0, 1). FNV-1a. */
export function hash01(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** A source can appear on the wall unless the health check has ruled it out. */
export function isUsable(source, health) {
  const h = health && health[source.id];
  if (!h) return true;
  return h.state !== 'unavailable' && h.state !== 'embed_disabled';
}

const MIN_POOL = 8; // below this many lit cameras, the best night views fill in
const PER_SLOT = 5; // how far the rotation advances each slot (hero + grid)

function quality(source, light) {
  let q = light === 'day' ? 3 : light === 'twilight' ? 1.5 : 0;
  if (source.preview === 'frame') q += 2;
  if (source.official === true) q += 1;
  else if (source.official === 'partner') q += 0.5;
  return q;
}

/** Rotate a list deterministically: shuffled once per day, advanced each slot. */
function rotation(entries, slot, salt) {
  const day = Math.floor(slot / 144);
  const order = entries
    .slice()
    .sort((a, b) => hash01(a.source.id + ':' + salt + ':' + day) - hash01(b.source.id + ':' + salt + ':' + day));
  if (!order.length) return order;
  const start = (slot * PER_SLOT) % order.length;
  return order.slice(start).concat(order.slice(0, start));
}

/**
 * Choose the cameras for the wall for this time slot.
 * Lit cameras are cycled through in a daily shuffled order; night cameras
 * join only when too few places are in daylight.
 * Returns { slot, hero, grid: [up to 4], quiet } — hero/quiet may be null.
 */
export function curate(sources, { health = {}, now = new Date(), slotMinutes = 10, quietIds = [] } = {}) {
  const slot = Math.floor(now.getTime() / (slotMinutes * 60000));
  const quiet = new Set(quietIds);
  const scored = sources
    .filter((s) => s.kind === 'video' && isUsable(s, health))
    .map((s) => {
      const light = lightAt(s.lat, s.lon, now);
      return { source: s, light, score: quality(s, light) };
    })
    .sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id));

  const used = new Set();
  const take = (entry) => {
    used.add(entry.source.id);
    return entry;
  };

  const main = scored.filter((e) => !quiet.has(e.source.id));
  let pool = main.filter((e) => e.light !== 'night');
  if (pool.length < MIN_POOL) pool = pool.concat(main.filter((e) => e.light === 'night').slice(0, MIN_POOL - pool.length));
  const mainPool = rotation(pool, slot, 'main').concat(main.filter((e) => !pool.includes(e)));

  const heroEntry =
    mainPool.find((e) => e.source.preview === 'frame' && e.source.category !== 'rail') ||
    mainPool.find((e) => e.source.preview === 'frame') ||
    mainPool[0];
  const hero = heroEntry ? take(heroEntry) : null;

  const grid = [];
  const countryCount = {};
  if (hero) countryCount[hero.source.country] = 1;
  const places = new Set(hero ? [hero.source.place] : []);
  for (const e of mainPool) {
    if (grid.length >= 4) break;
    if (used.has(e.source.id)) continue;
    if (places.has(e.source.place)) continue;
    if ((countryCount[e.source.country] || 0) >= 2) continue;
    grid.push(take(e));
    places.add(e.source.place);
    countryCount[e.source.country] = (countryCount[e.source.country] || 0) + 1;
  }

  // Make sure airports, ports and rail are all on the wall when possible.
  for (const cat of ['airport', 'port', 'rail']) {
    const onWall = [hero, ...grid].filter(Boolean);
    if (onWall.some((e) => e.source.category === cat)) continue;
    const candidate = mainPool.find((e) => e.source.category === cat && !used.has(e.source.id));
    if (!candidate || grid.length === 0) continue;
    // Replace the lowest-scoring grid entry whose category is duplicated elsewhere.
    const counts = {};
    onWall.forEach((e) => (counts[e.source.category] = (counts[e.source.category] || 0) + 1));
    let idx = -1;
    for (let i = grid.length - 1; i >= 0; i--) {
      if (counts[grid[i].source.category] > 1) {
        idx = i;
        break;
      }
    }
    if (idx === -1) continue;
    used.delete(grid[idx].source.id);
    grid[idx] = take(candidate);
  }

  const quietAll = scored.filter((e) => quiet.has(e.source.id) && !used.has(e.source.id));
  const quietLit = quietAll.filter((e) => e.light !== 'night');
  const quietEntry = rotation(quietLit.length ? quietLit : quietAll, slot, 'quiet')[0];
  return {
    slot,
    hero: hero ? hero.source : null,
    grid: grid.map((e) => e.source),
    quiet: quietEntry ? take(quietEntry).source : null,
    lights: Object.fromEntries(scored.map((e) => [e.source.id, e.light])),
  };
}

/** Project lon/lat into an SVG box, equirectangular with latitude correction. */
export function projector(bbox, width, height) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const kx = Math.cos(midLat);
  const spanX = (maxLon - minLon) * kx;
  const spanY = maxLat - minLat;
  const scale = Math.min(width / spanX, height / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  return (lon, lat) => [offX + (lon - minLon) * kx * scale, offY + (maxLat - lat) * scale];
}

/** Turn a Digitraffic live-trains response into departure rows for one station. */
export function departureRows(trains, stationCode, stationNames, now = new Date(), limit = 6) {
  const rows = [];
  for (const t of trains || []) {
    const row = (t.timeTableRows || []).find(
      (r) => r.stationShortCode === stationCode && r.type === 'DEPARTURE' && r.trainStopping !== false
    );
    if (!row) continue;
    const last = t.timeTableRows[t.timeTableRows.length - 1];
    const scheduled = Date.parse(row.scheduledTime);
    if (!Number.isFinite(scheduled)) continue;
    const estimate = row.liveEstimateTime ? Date.parse(row.liveEstimateTime) : null;
    const actual = row.actualTime ? Date.parse(row.actualTime) : null;
    if ((actual ?? estimate ?? scheduled) < now.getTime() - 60000) continue; // already gone
    const destCode = last ? last.stationShortCode : '';
    rows.push({
      scheduled,
      estimate,
      line: t.commuterLineID || `${t.trainType} ${t.trainNumber}`,
      // Loop services (Helsinki's I and P lines) end where they start.
      destination:
        destCode === stationCode ? 'Ring line' : (stationNames[destCode] || destCode || '?').replace(/ asema$/i, ''),
      track: row.commercialTrack || '',
      cancelled: Boolean(t.cancelled || row.cancelled),
      // Only report a delay when the source supplies one.
      delayMin: Number.isFinite(row.differenceInMinutes) ? row.differenceInMinutes : null,
    });
  }
  rows.sort((a, b) => a.scheduled - b.scheduled);
  return rows.slice(0, limit);
}
