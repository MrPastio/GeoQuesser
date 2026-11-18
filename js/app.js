// GeoQuesser — угадай место по фото с улиц.
// Фото: открытый каталог Panoramax (STAC API, без ключа). Карта: Leaflet + тайлы CARTO/OSM.
import { REGIONS, regionExtent } from './regions.js';
import { hasWebGL, flatViewer } from './flatview.js';

const WEBGL = hasWebGL();

const API = 'https://api.panoramax.xyz/api';
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const MAX_POINTS = 5000;
const MIN_IMAGE_WIDTH = 900;
const BEST_KEY = 'gq.best';

const $ = (id) => document.getElementById(id);

// ---------- состояние ----------
const opts = { region: 'world', rounds: 5, time: 0, only360: false, move: true };
let game = null;       // { opts, rounds:[{feature, guess, dist, points}], index, seeded:[[cid,id]]|null }
let viewer = null;     // Pannellum
let guessMap = null, guessMarker = null;
let resultMap = null;
let timerId = null;
let current = null;    // текущая показанная фотография (может отличаться от стартовой при ходьбе)
let neighbors = { prev: null, next: null };
let prefetch = null;

// ---------- утилиты ----------
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === screen));
}
function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtDist(km) {
  if (km < 1) return `${Math.round(km * 1000)} м`;
  if (km < 100) return `${km.toFixed(1)} км`;
  return `${Math.round(km).toLocaleString('ru-RU')} км`;
}
function scoreFor(km, region) {
  if (km <= 0.025) return MAX_POINTS;
  return Math.round(MAX_POINTS * Math.exp(-km / regionExtent(region).scaleKm));
}
function featureLatLng(f) { const [lng, lat] = f.geometry.coordinates; return { lat, lng }; }
function storageGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function storageSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* приватный режим */ } }

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- выбор фото ----------
function imageInfo(f) {
  const io = f.properties['pers:interior_orientation'] || {};
  const [w, h] = io.sensor_array_dimensions || [0, 0];
  const is360 = io.field_of_view === 360;
  const hd = f.assets?.hd?.href, sd = f.assets?.sd?.href;
  // для 360° сначала HD (детали важны), если текстура не огромная; для обычных фото хватает SD (2048 px).
  // Производные (sd) есть не у всех снимков, поэтому второй вариант — запасной.
  const order = is360 && w <= 8192 ? [hd, sd] : [sd, hd];
  const candidates = [...new Set(order.filter((u) => u && /^https:\/\//.test(u)))];
  return { w, h, is360, fov: io.field_of_view, candidates };
}
function usable(f) {
  const info = imageInfo(f);
  return info.candidates.length > 0 && info.w >= MIN_IMAGE_WIDTH && info.h > 0;
}

// Скачиваем картинку заранее: так битые ссылки отсеиваются до показа, а панорама открывается мгновенно.
const blobUrls = new Set();
async function withImage(f) {
  if (f._img) return f;
  for (const url of imageInfo(f).candidates) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const blob = await r.blob();
      if (!blob.type.startsWith('image/')) continue;
      f._img = URL.createObjectURL(blob);
      blobUrls.add(f._img);
      return f;
    } catch { /* пробуем следующий вариант */ }
  }
  throw new Error('Снимок недоступен');
}
function releaseImages() {
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls.clear();
}
// После ответа снимки раунда больше не нужны; оставляем только заранее загруженный следующий.
// Без этого в бесконечном режиме память росла бы с каждым раундом.
function releaseImagesExceptPrefetch() {
  const keep = prefetch?.f?._img;
  blobUrls.forEach((u) => { if (u !== keep) { URL.revokeObjectURL(u); blobUrls.delete(u); } });
}

function randomIn(box, rnd) {
  const [x1, y1, x2, y2] = box;
  return [x1 + (x2 - x1) * rnd(), y1 + (y2 - y1) * rnd()];
}
function pickWeighted(boxes, rnd) {
  const total = boxes.reduce((s, b) => s + b.w, 0);
  let r = rnd() * total;
  for (const b of boxes) { if ((r -= b.w) <= 0) return b; }
  return boxes[boxes.length - 1];
}

function fmtCoord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}  ${Math.abs(lon).toFixed(4)}°${ew}`;
}

async function findLocation(o, usedCollections, onProbe = () => {}) {
  const region = REGIONS[o.region];
  const rnd = Math.random;
  for (let attempt = 0; attempt < 30; attempt++) {
    const box = pickWeighted(region.boxes, rnd);
    const [lon, lat] = randomIn(box.b, rnd);
    onProbe(lat, lon);
    const half = Math.min(0.25 * 2 ** Math.floor(attempt / 6), 4) * (o.only360 ? 2 : 1);
    const bbox = [lon - half, lat - half, lon + half, lat + half].map((v) => v.toFixed(5)).join(',');
    let url = `${API}/search?limit=60&bbox=${bbox}`;
    if (o.only360) url += `&filter=${encodeURIComponent('field_of_view=360')}`;
    let data;
    try { data = await getJSON(url); } catch { continue; }
    const pool = (data.features || []).filter((f) => usable(f) && !usedCollections.has(f.collection)
      && inBoxes(featureLatLng(f), region.boxes));
    for (let k = 0; k < 5 && pool.length; k++) {
      const f = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      try { return await withImage(f); } catch { /* битый снимок — берём другой */ }
    }
  }
  throw new Error('Не удалось найти снимок. Проверь интернет или выбери другой регион.');
}
function inBoxes({ lat, lng }, boxes) {
  return boxes.some(({ b: [x1, y1, x2, y2] }) => lng >= x1 && lng <= x2 && lat >= y1 && lat <= y2);
}

async function loadFeature(cid, id) {
  return getJSON(`${API}/collections/${encodeURIComponent(cid)}/items/${encodeURIComponent(id)}`);
}

async function locationForRound(i, onProbe) {
  if (game.seeded) {
    const [cid, id] = game.seeded[i];
    return withImage(await loadFeature(cid, id));
  }
  // не повторяем маршруты последних 50 раундов (в бесконечном режиме полный запрет со временем исчерпал бы регион)
  const used = new Set(game.rounds.filter(Boolean).slice(-50).map((r) => r.feature.collection));
  return findLocation(game.opts, used, onProbe);
}

// ---------- панорама ----------
function showPano(f) {
  current = f;
  const info = imageInfo(f);
  const az = f.properties['view:azimuth'];
  const cfg = {
    type: 'equirectangular',
    panorama: f._img,
    autoLoad: true,
    showFullscreenCtrl: false,
    compass: typeof az === 'number',
    northOffset: typeof az === 'number' ? az : 0,
    hfov: 100,
    minHfov: 20,
  };
  if (!info.is360) {
    const haov = Math.max(30, Math.min(info.fov || 70, 170));
    const vaov = haov * info.h / info.w;
    Object.assign(cfg, {
      haov, vaov, vOffset: 0,
      minYaw: -haov / 2, maxYaw: haov / 2,
      minPitch: -vaov / 2, maxPitch: vaov / 2,
      hfov: Math.min(haov, 100), maxHfov: haov,
      avoidShowingBackground: true,
    });
  } else {
    cfg.maxHfov = 120;
  }
  const yaw = viewer?.getYaw?.();
  const pitch = viewer?.getPitch?.();
  if (viewer) viewer.destroy();
  $('pano').innerHTML = '';
  if (!WEBGL) {
    viewer = flatViewer($('pano'), { src: f._img, wrap: info.is360 });
    updateNeighbors(f);
    return;
  }
  viewer = pannellum.viewer('pano', cfg);
  // при ходьбе сохраняем направление взгляда для 360°
  if (info.is360 && yaw !== undefined && game.rounds[game.index]?.walked) {
    viewer.on('load', () => { viewer.setYaw(yaw, false); viewer.setPitch(pitch, false); });
  }
  viewer.on('error', () => toast('Снимок не отобразился'));
  updateNeighbors(f);
}

async function updateNeighbors(f) {
  neighbors = { prev: null, next: null };
  setNavEnabled();
  if (!game.opts.move) return;
  const rank = f.properties['geovisio:rank_in_collection'];
  if (typeof rank !== 'number') return;
  const { lat, lng } = featureLatLng(f);
  const d = 0.004;
  const url = `${API}/search?limit=100&collections=${encodeURIComponent(f.collection)}&bbox=${[lng - d, lat - d, lng + d, lat + d].map((v) => v.toFixed(6)).join(',')}`;
  try {
    const data = await getJSON(url);
    if (current !== f) return;
    for (const n of data.features || []) {
      const r = n.properties['geovisio:rank_in_collection'];
      if (!usable(n)) continue;
      if (r === rank - 1) neighbors.prev = n;
      if (r === rank + 1) neighbors.next = n;
    }
  } catch { /* без соседей просто не ходим */ }
  setNavEnabled();
}
function setNavEnabled() {
  $('nav-btns').classList.toggle('hidden', !game?.opts.move);
  $('step-prev').disabled = !neighbors.prev;
  $('step-next').disabled = !neighbors.next;
  $('back-start').disabled = !game || current === game.rounds[game.index]?.feature;
}
async function walk(f) {
  if (!f || !game) return;
  const i = game.index;
  $('nav-btns').classList.add('busy');
  try { await withImage(f); } catch { toast('Этот снимок недоступен'); return; }
  finally { $('nav-btns').classList.remove('busy'); }
  if (!game || game.index !== i || game.rounds[i].dist !== null) return;
  game.rounds[i].walked = true;
  showPano(f);
}

// ---------- игра ----------
function setLoading(on, text = 'Ищем место', coords = '') {
  $('loading').classList.toggle('hidden', !on);
  $('loading-text').textContent = text;
  $('loading-coords').textContent = coords || ' ';
}

function initGuessMap() {
  if (!guessMap) {
    guessMap = L.map('guess-map', { worldCopyJump: true, zoomControl: true, attributionControl: false });
    L.tileLayer(TILE_URL, { subdomains: 'abcd', maxZoom: 19 }).addTo(guessMap);
    guessMap.on('click', (e) => placeGuess(e.latlng));
  }
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  const ext = regionExtent(game.opts.region);
  guessMap.fitBounds([[ext.minLat, ext.minLon], [ext.maxLat, ext.maxLon]]);
  setTimeout(() => guessMap.invalidateSize(), 50);
}
function pinIcon(kind, label = '') {
  const size = kind === 'real' ? 28 : 16;
  return L.divIcon({
    className: '',
    html: `<div class="pin-${kind}">${label ? `<i>${label}</i>` : ''}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], tooltipAnchor: [0, -size / 2],
  });
}
function placeGuess(latlng) {
  const ll = latlng.wrap();
  if (guessMarker) guessMarker.setLatLng(ll);
  else guessMarker = L.marker(ll, { icon: pinIcon('guess') }).addTo(guessMap);
  $('guess-btn').disabled = false;
  $('guess-btn').textContent = 'Угадать';
}

function startGame(o, seeded = null) {
  releaseImages();
  game = { opts: { ...o }, rounds: [], index: 0, seeded };
  if (seeded) game.opts.rounds = seeded.length;
  // rounds = 0 — бесконечный режим: раунды идут, пока игрок сам не закончит
  game.endless = game.opts.rounds === 0;
  prefetch = null;
  show('game');
  initGuessMap();
  playRound();
}

async function playRound() {
  clearInterval(timerId);
  const i = game.index;
  $('hud-round').textContent = game.endless ? `${i + 1} / ∞` : `${i + 1}/${game.opts.rounds}`;
  $('hud-score').textContent = totalScore().toLocaleString('ru-RU');
  $('guess-btn').disabled = true;
  $('guess-btn').textContent = 'Поставь метку на карте';
  $('hud-timer-wrap').classList.toggle('hidden', !game.opts.time);
  $('hud-timer-wrap').classList.remove('warn');
  setLoading(true, game.seeded ? 'Загружаем место из вызова' : 'Ищем место');
  let f;
  try {
    // координаты, которые сейчас проверяются в каталоге — настоящие, а не декорация
    const probe = (lat, lon) => { if (game?.index === i) setLoading(true, 'Ищем место', fmtCoord(lat, lon)); };
    f = await (prefetch?.i === i ? prefetch.p : locationForRound(i, probe));
  } catch (e) {
    if (!game || game.index !== i) return;
    setLoading(false);
    toast(e.message || 'Ошибка сети', 5000);
    // сыгранное не пропадает: если раунды уже были, показываем итоги по ним
    if (completedRounds().length) showFinal();
    else { game = null; show('menu'); }
    return;
  }
  prefetch = null;
  if (!game || game.index !== i) return;
  game.rounds[i] = { feature: f, guess: null, dist: null, points: 0 };
  initGuessMap();
  showPano(f);
  viewer.on('load', () => setLoading(false));
  setTimeout(() => setLoading(false), 12000);
  // заранее ищем следующее место
  if (game.endless || i + 1 < game.opts.rounds) {
    const p = locationForRound(i + 1);
    const entry = { i: i + 1, p, f: null };
    p.then((nf) => { entry.f = nf; }, () => {});
    prefetch = entry;
  }
  if (game.opts.time) startTimer(game.opts.time);
}

function startTimer(sec) {
  let left = sec;
  const draw = () => {
    $('hud-timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('hud-timer-wrap').classList.toggle('warn', left <= 10);
  };
  draw();
  timerId = setInterval(() => {
    left -= 1; draw();
    if (left <= 0) { clearInterval(timerId); submitGuess(true); }
  }, 1000);
}

function totalScore() { return game.rounds.reduce((s, r) => s + (r?.points || 0), 0); }

function submitGuess(timeout = false) {
  const r = game.rounds[game.index];
  if (!r || r.dist !== null) return;
  clearInterval(timerId);
  const real = featureLatLng(r.feature);
  if (guessMarker) {
    r.guess = guessMarker.getLatLng();
    r.dist = haversineKm(r.guess, real);
    r.points = scoreFor(r.dist, game.opts.region);
  } else {
    r.dist = Infinity; r.points = 0;
  }
  showRoundResult(r, timeout);
}

// ---------- результаты ----------
function initResultMap() {
  if (!resultMap) {
    resultMap = L.map('result-map', { worldCopyJump: true, zoomControl: false });
    L.tileLayer(TILE_URL, { subdomains: 'abcd', maxZoom: 19, attribution: TILE_ATTR }).addTo(resultMap);
    L.control.zoom({ position: 'topright' }).addTo(resultMap);
  }
  resultMap.eachLayer((l) => { if (!(l instanceof L.TileLayer)) l.remove(); });
}
function drawRound(r, n) {
  const real = featureLatLng(r.feature);
  const pts = [[real.lat, real.lng]];
  if (r.guess) {
    // рисуем линию к ближайшей «копии» мира, чтобы не тянуть её через всю карту
    const g = { lat: r.guess.lat, lng: r.guess.lng };
    if (g.lng - real.lng > 180) g.lng -= 360;
    if (real.lng - g.lng > 180) g.lng += 360;
    L.polyline([real, g], { color: '#d9411e', weight: 2, dashArray: '2 7', lineCap: 'round' }).addTo(resultMap);
    L.marker(g, { icon: pinIcon('guess') }).addTo(resultMap).bindTooltip(n ? `${n} · ваш ответ` : 'Ваш ответ', { direction: 'top' });
    pts.push([g.lat, g.lng]);
  }
  L.marker(real, { icon: pinIcon('real', n || ''), zIndexOffset: 500 }).addTo(resultMap)
    .bindTooltip(`${n ? n + ' · ' : ''}${fmtCoord(real.lat, real.lng)}`, { direction: 'top' });
  return pts;
}
// Отступы для fitBounds: метки не должны прятаться под карточкой результата.
function fitPadding(maxZoom) {
  const card = document.querySelector('.result-card');
  return { paddingTopLeft: [40, 40], paddingBottomRight: [40, card.offsetHeight + 50], maxZoom };
}
function creditHtml(f) {
  const who = f.providers?.[0]?.name || 'автор Panoramax';
  const lic = f.links?.find((l) => l.rel === 'license');
  const date = f.properties?.datetime ? new Date(f.properties.datetime).toLocaleDateString('ru-RU') : '';
  const view = `https://explore.panoramax.fr/#focus=pic&pic=${encodeURIComponent(f.id)}`;
  return `Фото: ${escapeHtml(who)}${date ? ', ' + date : ''} · ${lic ? `<a href="${lic.href}" target="_blank" rel="noopener">${escapeHtml(lic.title?.match(/\((.+)\)/)?.[1] || 'лицензия')}</a>` : 'CC BY-SA'} · <a href="${view}" target="_blank" rel="noopener">открыть в Panoramax</a>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function showRoundResult(r, timeout) {
  show('result');
  initResultMap();
  setTimeout(() => {
    resultMap.invalidateSize();
    const pts = drawRound(r);
    if (pts.length > 1) resultMap.fitBounds(pts, fitPadding(14));
    else resultMap.setView(pts[0], 6);
  }, 30);
  releaseImagesExceptPrefetch();
  $('result-title').textContent = game.endless
    ? `Раунд ${game.index + 1} · бесконечный · ${REGIONS[game.opts.region].name}`
    : `Раунд ${game.index + 1} из ${game.opts.rounds} · ${REGIONS[game.opts.region].name}`;
  setScale(r.points, MAX_POINTS);
  $('result-dist').innerHTML = r.guess
    ? `Ошибка — <b>${fmtDist(r.dist)}</b>.`
    : (timeout ? 'Время вышло, метка не поставлена.' : 'Метка не поставлена.');
  $('result-credit').innerHTML = creditHtml(r.feature);
  $('final-extra').classList.add('hidden');
  const last = !game.endless && game.index + 1 >= game.opts.rounds;
  $('next-btn').textContent = last ? 'Итоги игры' : 'Следующий раунд';
  $('next-btn').onclick = last ? showFinal : () => { game.index += 1; show('game'); playRound(); };
  $('finish-btn').classList.toggle('hidden', !game.endless);
  $('finish-btn').textContent = `Закончить · ${plural(game.index + 1, 'раунд', 'раунда', 'раундов')}, ${plural(totalScore(), 'очко', 'очка', 'очков')}`;
}

function completedRounds() { return game.rounds.filter((r) => r && r.dist !== null); }
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n.toLocaleString('ru-RU')} ${w}`;
}

// Число очков, подпись «/ максимум» и масштабная линейка.
function setScale(points, max) {
  const fmt = (n) => n.toLocaleString('ru-RU');
  animateNumber($('result-points'), points);
  $('result-max').textContent = `/ ${fmt(max)}`;
  $('scale-max').textContent = fmt(max);
  $('scale-max').previousElementSibling.textContent = fmt(max / 2);
  const bar = $('result-bar');
  bar.style.transition = 'none'; bar.style.width = '0';
  void bar.offsetWidth;
  bar.style.transition = ''; bar.style.width = `${(points / max) * 100}%`;
}

function animateNumber(el, to) {
  const t0 = performance.now(), dur = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(to * (1 - (1 - k) ** 3)).toLocaleString('ru-RU');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function challengeLink() {
  const payload = { o: { region: game.opts.region, time: game.opts.time, only360: game.opts.only360, move: game.opts.move },
    l: game.rounds.map((r) => [r.feature.collection, r.feature.id]) };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  return `${location.origin}${location.pathname}#c=${b64}`;
}
function parseChallenge(text) {
  const m = String(text).match(/#c=([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    if (!Array.isArray(p.l) || !p.l.length || !REGIONS[p.o?.region]) return null;
    return p;
  } catch { return null; }
}

function showFinal() {
  clearInterval(timerId);
  prefetch = null;
  game.rounds = completedRounds(); // в бесконечном режиме неотвеченный раунд не считается
  const n = game.rounds.length;
  const total = totalScore(), max = MAX_POINTS * n;
  $('finish-btn').classList.add('hidden');
  show('result');
  initResultMap();
  setTimeout(() => {
    resultMap.invalidateSize();
    const all = game.rounds.flatMap((r, i) => drawRound(r, i + 1));
    resultMap.fitBounds(all, fitPadding(12));
  }, 30);
  $('result-title').textContent = `Итог · ${REGIONS[game.opts.region].name} · ${game.endless ? 'бесконечный, ' : ''}${plural(n, 'раунд', 'раунда', 'раундов')}`;
  setScale(total, max);
  const answered = game.rounds.filter((r) => r.guess);
  const median = answered.length
    ? answered.map((r) => r.dist).sort((a, b) => a - b)[Math.floor((answered.length - 1) / 2)] : null;
  $('result-dist').innerHTML = median === null
    ? 'Ни одной метки за игру.'
    : `Типичная ошибка — <b>${fmtDist(median)}</b>.`;
  $('result-credit').innerHTML = '';
  $('rounds-list').innerHTML = game.rounds.map((r, i) =>
    `<tr><td class="idx">${String(i + 1).padStart(2, '0')}</td><td class="dim">${r.guess ? fmtDist(r.dist) : 'без ответа'}</td><td class="num">${r.points.toLocaleString('ru-RU')}</td></tr>`).join('');
  $('share-link').value = challengeLink();
  $('final-extra').classList.remove('hidden');
  $('next-btn').textContent = 'В меню';
  $('next-btn').onclick = () => { game = null; renderBest(); show('menu'); };
  saveBest(total, max);
}

function saveBest(total, max) {
  const best = storageGet(BEST_KEY, []);
  best.push({ s: total, m: max, r: game.opts.region, d: Date.now(), e: game.endless || undefined });
  best.sort((a, b) => b.s / b.m - a.s / a.m);
  storageSet(BEST_KEY, best.slice(0, 8));
}
function renderBest() {
  const best = storageGet(BEST_KEY, []);
  $('best').innerHTML = best.length
    ? best.map((b) => `<tr><td>${escapeHtml(REGIONS[b.r]?.name || b.r)}${b.e ? ` <span class="dim">∞ ${b.m / MAX_POINTS}</span>` : ''}</td><td class="dim">${new Date(b.d).toLocaleDateString('ru-RU')}</td><td class="num">${b.s.toLocaleString('ru-RU')} <span class="dim">/ ${b.m.toLocaleString('ru-RU')}</span></td></tr>`).join('')
    : '<tr><td class="empty">Здесь появятся твои лучшие партии.</td></tr>';
}

// ---------- меню ----------
function initMenu() {
  const reg = $('regions');
  reg.innerHTML = Object.entries(REGIONS).map(([k, r], i) =>
    `<button type="button" data-v="${k}" class="${k === opts.region ? 'on' : ''}"><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="name">${r.name}</span></button>`).join('');
  reg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    opts.region = b.dataset.v;
    reg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
  document.querySelectorAll('.seg[data-opt]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const key = group.dataset.opt, v = Number(b.dataset.v);
      opts[key] = key === 'only360' || key === 'move' ? Boolean(v) : v;
      group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  $('start').onclick = () => startGame(opts);
  $('challenge-go').onclick = () => {
    const p = parseChallenge($('challenge-input').value);
    if (!p) return toast('Ссылка на вызов не распознана');
    startGame({ ...opts, ...p.o }, p.l);
  };
  renderBest();
}

function initGameControls() {
  $('guess-btn').onclick = () => submitGuess();
  $('finish-btn').onclick = () => showFinal();
  $('quit').onclick = () => {
    if (game?.endless && completedRounds().length) {
      if (!confirm('Закончить игру? Текущий раунд не засчитается, итоги будут по сыгранным.')) return;
      if (viewer) { viewer.destroy(); viewer = null; }
      showFinal();
      return;
    }
    if (!confirm('Выйти в меню? Текущая игра пропадёт.')) return;
    clearInterval(timerId); game = null; if (viewer) { viewer.destroy(); viewer = null; } show('menu');
  };
  $('step-prev').onclick = () => walk(neighbors.prev);
  $('step-next').onclick = () => walk(neighbors.next);
  $('back-start').onclick = () => walk(game.rounds[game.index].feature);
  $('map-pin').onclick = () => { $('guess-box').classList.toggle('pinned'); $('map-pin').classList.toggle('on'); setTimeout(() => guessMap.invalidateSize(), 220); };
  $('map-size').onclick = () => {
    const big = $('guess-box').classList.toggle('big');
    $('map-size').classList.toggle('on', big);
    $('map-size').textContent = big ? 'мельче' : 'крупнее';
    setTimeout(() => guessMap.invalidateSize(), 240);
  };
  $('guess-box').addEventListener('transitionend', () => guessMap?.invalidateSize());
  $('copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText($('share-link').value); toast('Ссылка скопирована'); }
    catch { $('share-link').select(); toast('Скопируй ссылку вручную'); }
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    if ($('game').classList.contains('active') && !$('guess-btn').disabled) { e.preventDefault(); submitGuess(); }
    else if ($('result').classList.contains('active')) { e.preventDefault(); $('next-btn').click(); }
  });
}

initMenu();
initGameControls();
const fromHash = parseChallenge(location.hash);
if (fromHash) {
  history.replaceState(null, '', location.pathname);
  toast('Тебе бросили вызов! Те же места, что у друга.');
  startGame({ ...opts, ...fromHash.o }, fromHash.l);
}
