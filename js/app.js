import { curate, departureRows, freshness, lightAt, projector } from './logic.js';

const DIGITRAFFIC_HEADERS = { 'Digitraffic-User': 'WorldInMotion/0.1' };
const THUMB_REFRESH_MS = 5 * 60 * 1000; // YouTube serves live thumbnails with max-age=300
const ROTATION_MINUTES = 10;
const PREFS_KEY = 'wim:prefs';

const state = {
  registry: null,
  health: {},
  healthGenerated: null,
  view: 'wall',
  filter: 'all',
  sort: 'editorial',
  liveMode: 'hero',
  showUnavailable: false,
  slot: null,
  players: new Map(),
  timers: [],
};

// ---------- small helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function localTime(tz, date = new Date()) {
  try {
    return date.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}

function hhmm(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    for (const k of ['view', 'filter', 'sort', 'liveMode', 'showUnavailable']) if (k in p) state[k] = p[k];
  } catch {
    /* storage unavailable: defaults are fine */
  }
}

function savePrefs() {
  try {
    const { view, filter, sort, liveMode, showUnavailable } = state;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view, filter, sort, liveMode, showUnavailable }));
  } catch {
    /* ignore */
  }
}

function every(ms, fn) {
  const id = setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
  state.timers.push(id);
  return id;
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function thumbUrl(id, bust = true) {
  const t = bust ? `?t=${Math.floor(Date.now() / THUMB_REFRESH_MS)}` : '';
  return `https://i.ytimg.com/vi/${id}/maxresdefault_live.jpg${t}`;
}

function byId(id) {
  return state.registry.sources.find((s) => s.id === id);
}

const KIND_LABEL = { video: 'VIDEO', still: 'STILL', data: 'LIVE DATA' };
const CATEGORY_LABEL = { airport: 'Airport', port: 'Port & water', rail: 'Rail' };

function officialLabel(s) {
  if (s.official === true) return 'Operator’s own camera';
  if (s.official === 'partner') return 'Run with the operator';
  if (s.official === 'unconfirmed') return 'Possibly official, unconfirmed';
  return 'Independent stream';
}

// ---------- YouTube players ----------

let ytReady;
function loadYouTubeApi() {
  if (!ytReady) {
    ytReady = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => reject(new Error('YouTube player could not load'));
      document.head.appendChild(s);
    });
  }
  return ytReady;
}

const YT_ERRORS = { 2: 'bad stream id', 5: 'player error', 100: 'stream gone or private', 101: 'embedding blocked', 150: 'embedding blocked' };

/** Mount a player and keep the tile's status line honest about what it is doing. */
async function mountPlayer(host, source, { muted = true, controls = false, statusEl, onFail } = {}) {
  const setStatus = (text, cls) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = cls;
  };
  setStatus('connecting', 'pending');
  let YT;
  try {
    YT = await loadYouTubeApi();
  } catch (e) {
    setStatus('player unavailable', 'bad');
    return null;
  }
  const div = document.createElement('div');
  host.replaceChildren(div);
  let playing = false;
  const fail = (text) => {
    setStatus(text, 'bad');
    if (onFail) onFail(text);
  };
  const watchdog = setTimeout(() => {
    if (!playing) fail('not playing — stream may be offline');
  }, 25000);
  const player = new YT.Player(div, {
    host: 'https://www.youtube-nocookie.com',
    videoId: source.youtube,
    playerVars: { autoplay: 1, mute: muted ? 1 : 0, controls: controls ? 1 : 0, playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: (ev) => {
        if (muted) ev.target.mute();
        ev.target.playVideo();
      },
      onStateChange: (ev) => {
        if (ev.data === YT.PlayerState.PLAYING) {
          playing = true;
          clearTimeout(watchdog);
          setStatus('live video playing', 'good');
        } else if (ev.data === YT.PlayerState.ENDED) {
          clearTimeout(watchdog);
          fail('stream ended');
        } else if (ev.data === YT.PlayerState.BUFFERING) {
          setStatus('buffering', 'pending');
        }
      },
      onError: (ev) => {
        clearTimeout(watchdog);
        fail(`${YT_ERRORS[ev.data] || 'player error'} (YouTube code ${ev.data})`);
      },
    },
  });
  player._watchdog = watchdog;
  return player;
}

function destroyPlayers() {
  for (const p of state.players.values()) {
    try {
      clearTimeout(p._watchdog);
      p.destroy();
    } catch {
      /* already gone */
    }
  }
  state.players.clear();
}

// ---------- camera tiles ----------

function cameraTileHTML(s, role) {
  const light = lightAt(s.lat, s.lon, new Date());
  const lightLabel = { day: 'daylight', twilight: 'twilight', night: 'night' }[light];
  return `
  <figure class="tile tile--${role}" data-id="${esc(s.id)}" data-light="${light}">
    <div class="media">
      <div class="media__frame" data-media></div>
      <span class="badge badge--video">${KIND_LABEL[s.kind]}</span>
      <span class="status" data-status data-state="idle"></span>
      <button class="tile__open" type="button" aria-label="Open ${esc(s.name)}, ${esc(s.place)}"></button>
    </div>
    <figcaption>
      ${role === 'quiet' ? '<span class="cap__kicker">The quiet side</span>' : ''}
      <span class="cap__name">${esc(s.place)} · ${esc(s.name)}</span>
      <span class="cap__meta"><span class="dot dot--${light}" aria-hidden="true"></span><span data-tz="${esc(s.tz)}">${localTime(s.tz)}</span> local · ${lightLabel} · ${esc(s.operator)}</span>
    </figcaption>
  </figure>`;
}

function fillPreview(tile, s) {
  const frame = $('[data-media]', tile);
  const status = $('[data-status]', tile);
  if (s.kind === 'still') {
    const img = new Image();
    img.alt = `${s.name}, latest camera image`;
    img.decoding = 'async';
    img.src = `${s.endpoint}?t=${Math.floor(Date.now() / (s.cadence_s * 1000))}`;
    img.onload = () => {
      status.textContent = `still · checked ${hhmm(Date.now())}`;
      status.dataset.state = 'neutral';
    };
    img.onerror = () => {
      status.textContent = 'image unavailable';
      status.dataset.state = 'bad';
    };
    frame.replaceChildren(img);
    $('.badge', tile).textContent = 'STILL';
    return;
  }
  if (s.preview === 'frame') {
    const img = new Image();
    img.alt = `${s.name}: recent frame from the live stream`;
    img.decoding = 'async';
    img.src = thumbUrl(s.youtube);
    const failed = tile.dataset.videoFailed;
    img.onload = () => {
      status.textContent = failed
        ? `video unavailable: ${failed} · still ${hhmm(Date.now())}`
        : `still from stream · ${hhmm(Date.now())}`;
      status.dataset.state = failed ? 'bad' : 'neutral';
    };
    img.onerror = () => {
      if (!img.dataset.fallback) {
        img.dataset.fallback = '1'; // not every stream has a full-size live thumbnail
        img.src = thumbUrl(s.youtube).replace('maxresdefault_live', 'hqdefault_live');
        return;
      }
      frame.replaceChildren(placeholder(s));
      status.textContent = failed ? `video unavailable: ${failed}` : 'preview unavailable';
      status.dataset.state = 'bad';
    };
    frame.replaceChildren(img);
  } else {
    frame.replaceChildren(placeholder(s));
    const failed = tile.dataset.videoFailed;
    status.textContent = failed ? `video unavailable: ${failed}` : 'click to watch';
    status.dataset.state = failed ? 'bad' : 'neutral';
  }
}

function placeholder(s) {
  const el = document.createElement('div');
  el.className = 'placeholder';
  el.innerHTML = `<span class="placeholder__place">${esc(s.place)}</span><span class="placeholder__name">${esc(s.name)}</span>`;
  return el;
}

function wantsLive(role) {
  if (state.liveMode === 'off') return false;
  if (state.liveMode === 'all') return true;
  return role === 'hero';
}

async function activateTile(tile, s, role) {
  const frame = $('[data-media]', tile);
  const status = $('[data-status]', tile);
  if (s.kind === 'video' && wantsLive(role)) {
    // If the player fails, the wall falls back to a still and says why,
    // rather than leaving YouTube's error screen on display.
    const onFail = (why) => {
      const key = s.id + ':' + role;
      const p = state.players.get(key);
      if (p) {
        try {
          clearTimeout(p._watchdog);
          p.destroy();
        } catch {
          /* ignore */
        }
        state.players.delete(key);
      }
      tile.dataset.videoFailed = why;
      fillPreview(tile, s);
    };
    const p = await mountPlayer(frame, s, { muted: true, statusEl: status, onFail });
    if (p) state.players.set(s.id + ':' + role, p);
  } else {
    fillPreview(tile, s);
  }
}

// ---------- data tiles ----------

function statusLine(el, recordMs, cadence, fetchedMs, extra = '') {
  const f = freshness(recordMs, Date.now(), cadence);
  const label = { fresh: 'fresh', delayed: 'delayed', stale: 'stale', unknown: 'age unknown' }[f];
  el.dataset.state = { fresh: 'good', delayed: 'pending', stale: 'bad', unknown: 'neutral' }[f];
  const rec = Number.isFinite(recordMs) && recordMs !== fetchedMs ? `data ${hhmm(recordMs)} · ` : '';
  el.textContent = `${label} · ${rec}fetched ${hhmm(fetchedMs)}${extra ? ' · ' + extra : ''}`;
}

function failLine(el, lastGood) {
  el.dataset.state = 'bad';
  el.textContent = lastGood ? `update failed · showing ${hhmm(lastGood)} data (stale)` : 'feed unavailable';
}

function aisTile(s) {
  const tile = document.createElement('figure');
  tile.className = 'tile tile--data';
  tile.dataset.id = s.id;
  tile.innerHTML = `
    <div class="media media--data">
      <svg class="map" viewBox="0 0 400 220" role="img" aria-label="Vessel positions near Helsinki"><g data-layer></g></svg>
      <span class="badge badge--data">AIS DATA</span>
      <span class="status" data-status data-state="pending">loading</span>
      <button class="tile__open" type="button" aria-label="Open ${esc(s.name)}"></button>
    </div>
    <figcaption>
      <span class="cap__name">${esc(s.place)} · ships</span>
      <span class="cap__meta" data-count>Digitraffic · 15 km around Helsinki</span>
    </figcaption>`;
  let lastGood = null;
  const [lon0, lat0] = [s.lon, s.lat];
  const bbox = [lon0 - 0.38, lat0 - 0.12, lon0 + 0.38, lat0 + 0.12];
  const project = projector(bbox, 400, 220);
  const draw = async () => {
    const status = $('[data-status]', tile);
    try {
      const d = await getJSON(s.endpoint, s.headers);
      const feats = (d.features || []).filter((f) => f.geometry && f.geometry.coordinates);
      let newest = NaN;
      let moving = 0;
      const marks = feats
        .map((f) => {
          const [lon, lat] = f.geometry.coordinates;
          const p = f.properties || {};
          if (Number.isFinite(p.timestampExternal)) newest = Number.isFinite(newest) ? Math.max(newest, p.timestampExternal) : p.timestampExternal;
          const [x, y] = project(lon, lat);
          if (x < -10 || x > 410 || y < -10 || y > 230) return '';
          const isMoving = p.sog >= 0.5;
          if (isMoving) moving++;
          const hdg = Number.isFinite(p.cog) ? p.cog : 0;
          const tail = isMoving
            ? `<line x1="${x}" y1="${y}" x2="${x + Math.sin((hdg * Math.PI) / 180) * 9}" y2="${y - Math.cos((hdg * Math.PI) / 180) * 9}" class="ship__heading"/>`
            : '';
          return `${tail}<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isMoving ? 3.2 : 2.2}" class="${isMoving ? 'ship ship--moving' : 'ship'}"/>`;
        })
        .join('');
      $('[data-layer]', tile).innerHTML = gratLines(project, bbox) + marks;
      $('[data-count]', tile).textContent = `${feats.length} vessels · ${moving} under way · Digitraffic`;
      lastGood = Number.isFinite(newest) ? newest : Date.now();
      statusLine(status, newest, s.cadence_s, Date.now());
    } catch (e) {
      failLine(status, lastGood);
    }
  };
  return { tile, start: () => (draw(), every(s.cadence_s * 1000, draw)) };
}

function gratLines(project, [minLon, minLat, maxLon, maxLat]) {
  let out = '';
  for (let lon = Math.ceil(minLon * 10) / 10; lon <= maxLon; lon += 0.1) {
    const [x1, y1] = project(lon, minLat);
    const [x2, y2] = project(lon, maxLat);
    out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="grat"/>`;
  }
  for (let lat = Math.ceil(minLat * 20) / 20; lat <= maxLat; lat += 0.05) {
    const [x1, y1] = project(minLon, lat);
    const [x2, y2] = project(maxLon, lat);
    out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="grat"/>`;
  }
  return out;
}

let stationNamesPromise;
function stationNames() {
  if (!stationNamesPromise) {
    stationNamesPromise = getJSON('https://rata.digitraffic.fi/api/v1/metadata/stations', DIGITRAFFIC_HEADERS)
      .then((list) => Object.fromEntries(list.map((st) => [st.stationShortCode, st.stationName])))
      .catch(() => ({}));
  }
  return stationNamesPromise;
}

function boardTile(s) {
  const tile = document.createElement('figure');
  tile.className = 'tile tile--data';
  tile.dataset.id = s.id;
  tile.innerHTML = `
    <div class="media media--board">
      <table class="board">
        <caption class="sr-only">Next departures from Helsinki Central</caption>
        <thead><tr><th scope="col">Dep</th><th scope="col">Line</th><th scope="col">To</th><th scope="col">Track</th><th scope="col">Note</th></tr></thead>
        <tbody data-rows><tr><td colspan="5" class="board__empty">Loading departures…</td></tr></tbody>
      </table>
      <span class="status" data-status data-state="pending">loading</span>
      <button class="tile__open" type="button" aria-label="Open ${esc(s.name)}"></button>
    </div>
    <figcaption>
      <span class="cap__name">${esc(s.name)}</span>
      <span class="cap__meta"><span data-tz="${esc(s.tz)}">${localTime(s.tz)}</span> local · Digitraffic</span>
    </figcaption>`;
  let lastGood = null;
  const draw = async () => {
    const status = $('[data-status]', tile);
    try {
      const [trains, names] = await Promise.all([getJSON(s.endpoint, s.headers), stationNames()]);
      const rows = departureRows(trains, 'HKI', names, new Date(), 5);
      const tbody = $('[data-rows]', tile);
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="board__empty">No departures listed by the feed right now.</td></tr>`;
      } else {
        tbody.innerHTML = rows
          .map((r) => {
            const t = new Date(r.scheduled).toLocaleTimeString('en-GB', { timeZone: s.tz, hour: '2-digit', minute: '2-digit' });
            let note = '';
            if (r.cancelled) note = '<span class="note note--bad">cancelled</span>';
            else if (r.delayMin !== null && r.delayMin > 0) note = `<span class="note note--warn">+${r.delayMin} min</span>`;
            else if (r.estimate) note = '<span class="note">on time</span>';
            return `<tr><td>${t}</td><td>${esc(r.line)}</td><td>${esc(r.destination)}</td><td>${esc(r.track)}</td><td>${note}</td></tr>`;
          })
          .join('');
      }
      lastGood = Date.now();
      // The departures list has no single "generated at" time, so freshness is judged by fetch time.
      statusLine(status, lastGood, s.cadence_s, lastGood);
    } catch (e) {
      failLine(status, lastGood);
    }
  };
  return { tile, start: () => (draw(), every(s.cadence_s * 1000, draw)) };
}

function trainsMapTile(s) {
  const tile = document.createElement('figure');
  tile.className = 'tile tile--data';
  tile.dataset.id = s.id;
  tile.innerHTML = `
    <div class="media media--data">
      <svg class="map" viewBox="0 0 400 220" role="img" aria-label="Positions of trains running in Finland"><g data-layer></g></svg>
      <span class="badge badge--data">GPS DATA</span>
      <span class="status" data-status data-state="pending">loading</span>
      <button class="tile__open" type="button" aria-label="Open ${esc(s.name)}"></button>
    </div>
    <figcaption>
      <span class="cap__name">${esc(s.name)}</span>
      <span class="cap__meta" data-count>Digitraffic</span>
    </figcaption>`;
  const bbox = [19.4, 59.7, 31.7, 70.1];
  const project = projector(bbox, 400, 220);
  let lastGood = null;
  const draw = async () => {
    const status = $('[data-status]', tile);
    try {
      const list = await getJSON(s.endpoint, s.headers);
      let newest = NaN;
      let moving = 0;
      const marks = (list || [])
        .map((t) => {
          const c = t.location && t.location.coordinates;
          if (!c) return '';
          const ts = Date.parse(t.timestamp);
          if (Number.isFinite(ts)) newest = Number.isFinite(newest) ? Math.max(newest, ts) : ts;
          const [x, y] = project(c[0], c[1]);
          const isMoving = t.speed > 5;
          if (isMoving) moving++;
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isMoving ? 2.6 : 1.8}" class="${isMoving ? 'train train--moving' : 'train'}"/>`;
        })
        .join('');
      $('[data-layer]', tile).innerHTML = marks;
      $('[data-count]', tile).textContent = `${(list || []).length} trains reporting · ${moving} moving · Digitraffic`;
      lastGood = Number.isFinite(newest) ? newest : Date.now();
      statusLine(status, newest, s.cadence_s, Date.now());
    } catch (e) {
      failLine(status, lastGood);
    }
  };
  return { tile, start: () => (draw(), every(s.cadence_s * 1000, draw)) };
}

const DATA_TILES = { 'data-ais-helsinki': aisTile, 'data-rail-hki': boardTile, 'data-rail-fi-gps': trainsMapTile };

// ---------- wall ----------

function renderWall() {
  destroyPlayers();
  (state.wallTimers || []).forEach(clearInterval);
  state.wallTimers = [];
  const main = $('#wall');
  const sources = state.registry.sources;
  const pick = curate(sources, {
    health: state.health,
    now: new Date(),
    slotMinutes: ROTATION_MINUTES,
    quietIds: state.registry.collections.quiet.ids,
  });
  state.slot = pick.slot;

  const cams = [];
  if (pick.hero) cams.push([pick.hero, 'hero']);
  pick.grid.forEach((s) => cams.push([s, 'small']));

  main.innerHTML = `
    <div class="wall__cams">${cams.map(([s, role]) => cameraTileHTML(s, role)).join('')}</div>
    <div class="wall__lower" data-lower></div>`;

  const lower = $('[data-lower]', main);
  for (const id of Object.keys(DATA_TILES)) {
    const s = byId(id);
    if (!s) continue;
    const t = DATA_TILES[id](s);
    lower.appendChild(t.tile);
    state.wallTimers.push(t.start());
  }
  if (pick.quiet) {
    lower.insertAdjacentHTML('beforeend', cameraTileHTML(pick.quiet, 'quiet'));
    cams.push([pick.quiet, 'quiet']);
  }

  for (const [s, role] of cams) {
    const tile = main.querySelector(`.tile--${role}[data-id="${CSS.escape(s.id)}"]`);
    if (tile) activateTile(tile, s, role);
  }

  renderCityStrip([pick.hero, ...pick.grid, pick.quiet].filter(Boolean));
  renderSummary(pick);
}

function refreshWallPreviews() {
  document.querySelectorAll('#wall .tile').forEach((tile) => {
    const s = byId(tile.dataset.id);
    if (!s || s.kind === 'data') return;
    const role = tile.classList.contains('tile--hero') ? 'hero' : tile.classList.contains('tile--quiet') ? 'quiet' : 'small';
    if (s.kind === 'video' && wantsLive(role) && !tile.dataset.videoFailed) return; // a playing stream needs no still
    fillPreview(tile, s);
  });
}

function renderCityStrip(list) {
  const seen = new Set();
  const cities = list.filter((s) => (seen.has(s.place) ? false : seen.add(s.place)));
  $('#cities').innerHTML = cities
    .map((s) => {
      const light = lightAt(s.lat, s.lon, new Date());
      return `<li><span class="dot dot--${light}" aria-hidden="true"></span><span class="city__name">${esc(s.place)}</span><span class="city__time" data-tz="${esc(s.tz)}">${localTime(s.tz)}</span></li>`;
    })
    .join('');
}

function renderSummary(pick) {
  const all = state.registry.sources;
  const cams = all.filter((s) => s.kind !== 'data');
  const usable = all.filter((s) => {
    const h = state.health[s.id];
    return !h || (h.state !== 'unavailable' && h.state !== 'embed_disabled');
  });
  const inDaylight = cams.filter((s) => lightAt(s.lat, s.lon, new Date()) === 'day').length;
  const checked = state.healthGenerated
    ? `source check ${new Date(state.healthGenerated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
    : 'source check pending';
  $('#summary').innerHTML = `
    <span><strong>${usable.length}</strong> of ${all.length} sources reachable</span>
    <span><strong>${inDaylight}</strong> cameras in daylight</span>
    <span>${checked}</span>
    <span>next rotation <strong data-next-rotation>${nextRotation()}</strong></span>`;
}

function nextRotation() {
  const ms = ROTATION_MINUTES * 60000;
  return hhmm(Math.ceil(Date.now() / ms) * ms);
}

// ---------- index (browse) view ----------

function filteredSources() {
  let list = state.registry.sources.slice();
  if (!state.showUnavailable) {
    list = list.filter((s) => {
      const h = state.health[s.id];
      return !h || h.state !== 'unavailable';
    });
  }
  const f = state.filter;
  if (f === 'airport' || f === 'port' || f === 'rail') list = list.filter((s) => s.category === f && s.kind !== 'data');
  else if (f === 'data') list = list.filter((s) => s.kind === 'data' || s.kind === 'still');
  else if (f.startsWith('c:')) {
    const ids = new Set(state.registry.collections[f.slice(2)]?.ids || []);
    list = list.filter((s) => ids.has(s.id));
  }
  if (state.sort === 'daylight') {
    const rank = { day: 0, twilight: 1, night: 2 };
    const now = new Date();
    list.sort((a, b) => rank[lightAt(a.lat, a.lon, now)] - rank[lightAt(b.lat, b.lon, now)]);
  }
  return list;
}

function renderFilters() {
  const base = [
    ['all', 'Everything'],
    ['airport', 'Airports'],
    ['port', 'Ports & water'],
    ['rail', 'Rail'],
    ['data', 'Data & stills'],
  ];
  const cols = Object.entries(state.registry.collections).map(([k, c]) => ['c:' + k, c.title]);
  $('#filters').innerHTML =
    base.map(([v, l]) => chip(v, l)).join('') + '<span class="chips__rule" aria-hidden="true"></span>' + cols.map(([v, l]) => chip(v, l)).join('');
}

function chip(value, label) {
  return `<button type="button" class="chip" data-filter="${esc(value)}" aria-pressed="${state.filter === value}">${esc(label)}</button>`;
}

function renderIndex() {
  destroyPlayers();
  renderFilters();
  const list = filteredSources();
  const now = new Date();
  $('#index-count').textContent = `${list.length} ${list.length === 1 ? 'source' : 'sources'}`;
  $('#index-list').innerHTML = list
    .map((s) => {
      const light = lightAt(s.lat, s.lon, now);
      const h = state.health[s.id];
      const healthNote = h && h.state !== 'ok' ? `<span class="note note--bad">${esc(h.state.replace('_', ' '))}</span>` : '';
      const thumb =
        s.kind === 'video' && s.preview === 'frame'
          ? `<img loading="lazy" decoding="async" alt="" data-yt="${esc(s.youtube)}" src="${thumbUrl(s.youtube)}">`
          : s.kind === 'still'
            ? `<img loading="lazy" decoding="async" alt="" src="${esc(s.endpoint)}">`
            : `<div class="placeholder placeholder--small"><span class="placeholder__place">${esc(s.place)}</span></div>`;
      return `
      <li>
        <button type="button" class="card" data-open="${esc(s.id)}">
          <span class="card__thumb">${thumb}<span class="badge badge--${s.kind === 'data' ? 'data' : 'video'}">${KIND_LABEL[s.kind]}</span></span>
          <span class="card__name">${esc(s.name)}</span>
          <span class="card__place">${esc(s.place)}, ${esc(s.country)}</span>
          <span class="card__meta"><span class="dot dot--${light}" aria-hidden="true"></span><span data-tz="${esc(s.tz)}">${localTime(s.tz)}</span> local · ${esc(CATEGORY_LABEL[s.category] || s.category)}</span>
          <span class="card__meta">${esc(officialLabel(s))} ${healthNote}</span>
        </button>
      </li>`;
    })
    .join('');
}

// ---------- detail dialog ----------

async function openDetail(id) {
  const s = byId(id);
  if (!s) return;
  const dlg = $('#detail');
  const h = state.health[s.id];
  const original =
    s.youtube ? `https://www.youtube.com/watch?v=${s.youtube}` : s.endpoint;
  dlg.innerHTML = `
    <form method="dialog" class="detail">
      <div class="detail__media" data-media></div>
      <div class="detail__side">
        <p class="detail__kicker">${esc(CATEGORY_LABEL[s.category] || s.category)} · ${KIND_LABEL[s.kind]}</p>
        <h2 class="detail__title">${esc(s.name)}</h2>
        <p class="detail__place">${esc(s.place)}, ${esc(s.country)} · <span data-tz="${esc(s.tz)}">${localTime(s.tz)}</span> local</p>
        <p class="status status--inline" data-status data-state="idle"></p>
        <dl class="detail__facts">
          <dt>Operator</dt><dd>${esc(s.operator)}</dd>
          <dt>Standing</dt><dd>${esc(officialLabel(s))}</dd>
          ${s.licence ? `<dt>Licence</dt><dd>${esc(s.licence)}</dd>` : ''}
          ${s.cadence_s ? `<dt>Refresh</dt><dd>about every ${s.cadence_s >= 60 ? Math.round(s.cadence_s / 60) + ' min' : s.cadence_s + ' s'}</dd>` : ''}
          <dt>Last check</dt><dd>${h ? `${esc(h.state.replace('_', ' '))} · ${esc(new Date(h.checked).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${h.detail ? ' · ' + esc(h.detail) : ''}` : 'not yet checked by the daily job'}</dd>
          <dt>Verified</dt><dd>${esc(state.registry.generated)}, by hand</dd>
          ${s.notes ? `<dt>Notes</dt><dd>${esc(s.notes)}</dd>` : ''}
        </dl>
        <p class="detail__links"><a href="${esc(original)}" target="_blank" rel="noopener">Open the original</a></p>
        <button class="detail__close" value="close" aria-label="Close">Close</button>
      </div>
    </form>`;
  dlg.showModal();
  const media = $('[data-media]', dlg);
  const status = $('[data-status]', dlg);
  if (s.kind === 'video') {
    const p = await mountPlayer(media, s, { muted: false, controls: true, statusEl: status });
    if (p) state.players.set(s.id + ':detail', p);
  } else if (s.kind === 'still') {
    media.innerHTML = `<img alt="${esc(s.name)}, latest camera image" src="${esc(s.endpoint)}?t=${Date.now()}">`;
    status.textContent = 'still image, refreshed by the source about every 10 minutes';
    status.dataset.state = 'neutral';
  } else if (DATA_TILES[s.id]) {
    const t = DATA_TILES[s.id](s);
    t.tile.classList.add('tile--detail');
    media.replaceChildren(t.tile);
    const timer = t.start();
    dlg.addEventListener('close', () => clearInterval(timer), { once: true });
    status.textContent = '';
  }
}

function closeDetail() {
  const dlg = $('#detail');
  for (const [k, p] of state.players) {
    if (k.endsWith(':detail')) {
      try {
        clearTimeout(p._watchdog);
        p.destroy();
      } catch {
        /* ignore */
      }
      state.players.delete(k);
    }
  }
  dlg.innerHTML = '';
}

// ---------- view switching, controls, clocks ----------

function setView(view) {
  state.view = view;
  savePrefs();
  document.body.dataset.view = view;
  $('#view-wall').setAttribute('aria-pressed', String(view === 'wall'));
  $('#view-index').setAttribute('aria-pressed', String(view === 'index'));
  state.timers.forEach(clearInterval);
  state.timers = [];
  if (view === 'wall') {
    renderWall();
    every(THUMB_REFRESH_MS, refreshWallPreviews);
    every(30000, () => {
      const slot = Math.floor(Date.now() / (ROTATION_MINUTES * 60000));
      if (slot !== state.slot) renderWall();
    });
  } else {
    $('#wall').innerHTML = '';
    renderIndex();
  }
  every(15000, tickClocks);
}

function tickClocks() {
  const now = new Date();
  $('#utc').textContent = localTime('UTC', now);
  $('#utc-date').textContent = now.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  document.querySelectorAll('[data-tz]').forEach((el) => (el.textContent = localTime(el.dataset.tz, now)));
  const nr = $('[data-next-rotation]');
  if (nr) nr.textContent = nextRotation();
}

function bindControls() {
  $('#view-wall').addEventListener('click', () => setView('wall'));
  $('#view-index').addEventListener('click', () => setView('index'));

  const live = $('#live-mode');
  live.value = state.liveMode;
  live.addEventListener('change', () => {
    state.liveMode = live.value;
    savePrefs();
    if (state.view === 'wall') setView('wall');
  });

  const sort = $('#sort');
  sort.value = state.sort;
  sort.addEventListener('change', () => {
    state.sort = sort.value;
    savePrefs();
    renderIndex();
  });

  const unavailable = $('#show-unavailable');
  unavailable.checked = state.showUnavailable;
  unavailable.addEventListener('change', () => {
    state.showUnavailable = unavailable.checked;
    savePrefs();
    renderIndex();
  });

  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    savePrefs();
    renderIndex();
  });

  document.addEventListener('click', (e) => {
    const open = e.target.closest('.tile__open, [data-open]');
    if (!open) return;
    const id = open.dataset.open || open.closest('.tile')?.dataset.id;
    if (id) openDetail(id);
  });

  // Index thumbnails: fall back to the smaller live thumbnail, then to nothing.
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.dataset.yt) return;
      if (!img.dataset.fallback) {
        img.dataset.fallback = '1';
        img.src = `https://i.ytimg.com/vi/${img.dataset.yt}/hqdefault_live.jpg`;
      } else {
        img.remove();
      }
    },
    true
  );

  $('#detail').addEventListener('close', closeDetail);
  $('#detail').addEventListener('click', (e) => {
    if (e.target === $('#detail')) $('#detail').close(); // click on the backdrop
  });
}

function takedownLink() {
  // On GitHub Pages the owner and repo can be read from the address.
  const host = location.hostname;
  const m = host.match(/^([^.]+)\.github\.io$/i);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  const a = $('#takedown');
  if (m && repo) {
    a.href = `https://github.com/${m[1]}/${repo}/issues/new?template=takedown.md&title=${encodeURIComponent('Removal request: ')}`;
  } else if (m) {
    a.href = `https://github.com/${m[1]}/${m[1]}.github.io/issues/new?template=takedown.md`;
  } else {
    a.removeAttribute('href');
    a.textContent = 'open an issue on this site’s GitHub repository';
  }
}

async function main() {
  loadPrefs();
  try {
    state.registry = await getJSON('data/registry.json');
  } catch (e) {
    $('#wall').innerHTML = `<p class="fatal">The source registry could not be loaded (${esc(e.message)}).</p>`;
    return;
  }
  try {
    const h = await getJSON('data/health.json');
    state.health = h.sources || {};
    state.healthGenerated = h.generated || null;
  } catch {
    /* no health file yet: every source is treated as usable */
  }
  bindControls();
  takedownLink();
  tickClocks();
  setView(state.view);
}

main();
