'use strict';
/* ===== Музей Саши: интервальное повторение экспонатов + учёт квизов ===== */
const C = window.CATALOG;
const EXM = Object.fromEntries(C.ex.map(e => [e.id, e]));
const QZM = Object.fromEntries(C.quizzes.map(q => [q.id, q]));
const HALLM = Object.fromEntries(C.halls.map(h => [h.id, h]));

/* ---------- даты ---------- */
const dn = d => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
const dOf = s => { const [y, m, d] = s.split('-').map(Number); return dn(new Date(y, m - 1, d)); };
const TODAY = () => dn(new Date());
const ds = n => { const d = new Date(n * 864e5); return d.toISOString().slice(0, 10); };
const EXAM = dOf('2028-05-24');
const REV_START = dOf('2028-01-10'), REV_END = dOf('2028-03-20');
const SUMMER = [dOf('2027-06-01'), dOf('2027-08-31')];
const DAILY_CAP = 10;

/* ---------- ступени ---------- */
const BOX = [null,
  { n: 'Запасник', c: '#c9b48a', i: 1 },
  { n: 'Реставрация', c: '#c98a5a', i: 7 },
  { n: 'Выставка', c: '#8fae7a', i: 21 },
  { n: 'Постоянная экспозиция', c: '#5f8f9e', i: 60 },
  { n: 'Золотой зал', c: '#d9a93a', i: 120 }];
function hash(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function plan(id, days, today) {
  let d = today + days;
  if (d > REV_START && days >= 21) d = Math.min(d, REV_START + (hash(id) % (REV_END - REV_START)));
  if (d > EXAM - 10) d = EXAM - 10 - (hash(id) % 20);
  return Math.max(d, today + 1);
}

/* ---------- состояние ---------- */
const EMPTY = () => ({ v: 1, ex: {}, qz: {}, books: {}, flags: {}, pending: null, settings: { freeze: true }, created: TODAY() });
let S = EMPTY(), LOG = { days: {} };
let mode = 'local';
const SB_URL = 'https://akunilczueybkyoaiksa.supabase.co';
const SB_KEY = 'sb_publishable_FTw98SWhHvXRiRuIHdfJPg_zZ8DOPsU';
const LS = 'museum-sasha-v1';
/* семейный код: приходит в ссылке #k=… и запоминается на устройстве */
let FAMILY = null;
(function () { try { const m = location.hash.match(/k=([A-Za-z0-9_-]{16,})/); if (m) { localStorage.setItem('museum-family', m[1]); history.replaceState(null, '', location.pathname); } FAMILY = localStorage.getItem('museum-family'); } catch (e) {} })();
let dirty = false;
function lsLoad() { try { const j = JSON.parse(localStorage.getItem(LS) || 'null'); if (j && j.S) { S = Object.assign(EMPTY(), j.S); LOG = j.LOG || LOG; dirty = !!j.dirty; } } catch (e) {} }
function lsSave() { try { localStorage.setItem(LS, JSON.stringify({ S, LOG, dirty })); } catch (e) {} }
async function cloudGet() {
  const r = await fetch(SB_URL + '/rest/v1/rpc/museum_get', { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_id: FAMILY }) });
  if (!r.ok) throw new Error('get ' + r.status); return await r.json();
}
async function cloudPut(data) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/museum_put', { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_id: FAMILY, p_data: data }) });
  if (!r.ok) throw new Error('put ' + r.status);
}
/* слияние двух устройств: по каждому экспонату берём более свежую запись */
function newer(a, b, f) { if (!a) return b; if (!b) return a; return f(a) >= f(b) ? a : b; }
function mergeState(a, b) {
  if (!b) return a; if (!a) return b;
  const o = Object.assign(EMPTY(), b, a);
  o.ex = {}; new Set([...Object.keys(a.ex || {}), ...Object.keys(b.ex || {})]).forEach(k => o.ex[k] = newer((a.ex || {})[k], (b.ex || {})[k], r => (r.l || 0) * 1e4 + (r.ok || 0) + (r.bad || 0)));
  o.qz = {}; new Set([...Object.keys(a.qz || {}), ...Object.keys(b.qz || {})]).forEach(k => o.qz[k] = newer((a.qz || {})[k], (b.qz || {})[k], r => (r.n || 0) * 1e5 + (r.last || 0)));
  o.books = Object.assign({}, b.books, a.books); o.flags = Object.assign({}, b.flags, a.flags);
  o.settings = Object.assign({}, b.settings, a.settings); o.pending = a.pending || null; o.created = Math.min(a.created || 1e9, b.created || 1e9);
  return o;
}
function mergeLog(a, b) {
  const o = { days: {} }; const A = (a && a.days) || {}, B = (b && b.days) || {};
  new Set([...Object.keys(A), ...Object.keys(B)]).forEach(k => { const x = A[k] || { m: 0, n: 0, ok: 0, q: [] }, y = B[k] || { m: 0, n: 0, ok: 0, q: [] };
    o.days[k] = { m: Math.max(x.m, y.m), n: Math.max(x.n, y.n), ok: Math.max(x.ok, y.ok), q: (x.q.length >= y.q.length ? x.q : y.q) }; });
  return o;
}
let saveChain = Promise.resolve(), saveTimer = null;
function save() { dirty = true; lsSave(); clearTimeout(saveTimer); saveTimer = setTimeout(sync, 1200); }
function sync() {
  if (!FAMILY) return Promise.resolve();
  saveChain = saveChain.then(async () => {
    if (!navigator.onLine) { setSync(dirty ? 'нет связи — сохраню позже' : 'нет связи'); return; }
    try {
      const cloud = await cloudGet();
      if (cloud && cloud.S) { S = mergeState(S, cloud.S); LOG = mergeLog(LOG, cloud.LOG); }
      if (dirty || !cloud) { await cloudPut({ S, LOG, at: new Date().toISOString() }); }
      dirty = false; lsSave(); mode = 'cloud'; setSync('☁ общий прогресс');
    } catch (e) { setSync('нет связи — сохраню позже'); }
  });
  return saveChain;
}
function setSync(t) { const el = document.getElementById('sync'); if (el) el.textContent = t; }
let PACK = {};
function imgSrc(v) { if (!v) return ''; if (v.startsWith('pack:')) return PACK[v.slice(5)] || ''; return v; }
async function loadPack() {
  try { const c = localStorage.getItem('museum-img'); if (c) { PACK = JSON.parse(c); return; } } catch (e) {}
  if (!FAMILY || !navigator.onLine) return;
  try { const r = await fetch(SB_URL + '/rest/v1/rpc/museum_get', { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_id: FAMILY + '-img' }) });
    const j = await r.json(); if (j && j.imgs) { PACK = j.imgs; try { localStorage.setItem('museum-img', JSON.stringify(PACK)); } catch (e) {} } } catch (e) {}
}
function consumeResult() {
  try { const r = JSON.parse(localStorage.getItem('museum-result') || 'null'); if (!r || !QZM[r.q]) return; localStorage.removeItem('museum-result');
    if (Date.now() - r.at < 6 * 3600e3) { rateQuiz(r.q, r.rate, r.missed || []); setTimeout(() => toast('«' + QZM[r.q].title + '» записан в журнал: ' + { easy: 'легко', ok: 'с ошибками', hard: 'трудно' }[r.rate]), 300); } } catch (e) {}
}
async function initStore() {
  lsLoad(); consumeResult(); render(); loadPack();
  if (!FAMILY) { setSync('нет семейной ссылки'); return; }
  await sync(); if (!inSession && !document.querySelector('.ov')) render();
}
addEventListener('online', () => { sync().then(() => { if (!inSession) render(); }); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !inSession) sync().then(() => { if (!inSession && !document.querySelector('.ov')) render(); }); });

/* ---------- журнал ---------- */
function logDay(add) {
  const k = ds(TODAY()); const d = LOG.days[k] || (LOG.days[k] = { m: 0, n: 0, ok: 0, q: [] });
  if (add.m) d.m = Math.round((d.m + add.m) * 10) / 10;
  if (add.n) d.n += add.n; if (add.ok) d.ok += add.ok;
  if (add.q) d.q.push(add.q);
}

/* ---------- выбор на сегодня ---------- */
const summerNow = () => S.settings.freeze && TODAY() >= SUMMER[0] && TODAY() <= SUMMER[1];
function dueExhibits() {
  const t = TODAY();
  const due = Object.entries(S.ex).filter(([id, r]) => EXM[id] && r.d <= t).map(([id, r]) => ({ id, r }));
  due.sort((a, b) => (b.r.rep || 0) - (a.r.rep || 0) || a.r.d - b.r.d);
  // перемешиваем по залам (чередование)
  const byHall = {}; due.forEach(x => (byHall[EXM[x.id].h] = byHall[EXM[x.id].h] || []).push(x));
  const out = []; const lists = Object.values(byHall);
  while (out.length < due.length) for (const l of lists) if (l.length) out.push(l.shift());
  return { all: due.length, list: out.slice(0, DAILY_CAP).map(x => x.id) };
}
function quizStatus(q) {
  const r = S.qz[q.id]; const t = TODAY();
  if (!r) {
    if (q.after) { const p = S.qz[q.after]; if (!p) return { st: 'locked' }; return { st: 'new', ready: p.last < t }; }
    return { st: 'new', ready: true };
  }
  return { st: r.d <= t ? 'due' : 'done', r };
}
function nextQuizzes() {
  const t = TODAY(); const out = [];
  const branch = C.quizzes.filter(q => q.after && !S.qz[q.id] && S.qz[q.after] && S.qz[q.after].last < t);
  const rerun = C.quizzes.filter(q => S.qz[q.id] && S.qz[q.id].d <= t).sort((a, b) => S.qz[a.id].d - S.qz[b.id].d);
  const fresh = C.quizzes.filter(q => !S.qz[q.id] && !q.after).sort((a, b) => a.order - b.order);
  branch.forEach(q => out.push({ q, why: 'Ветка: на следующий день после «' + QZM[q.after].title.split('—')[0].trim() + '»' }));
  rerun.forEach(q => out.push({ q, why: S.qz[q.id].rp ? 'Ремонт: в этом зале накопились ошибки' : 'Пора пройти снова (повтор № ' + (S.qz[q.id].n + 1) + ')' }));
  fresh.forEach(q => out.push({ q, why: 'Новая экспозиция' }));
  return out;
}

/* ---------- генерация вопросов ---------- */
const norm = s => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) { const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let p = Array.from({ length: n + 1 }, (_, i) => i); for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[n]; }
function typedOk(input, keys) {
  const x = norm(input); if (!x) return false;
  const words = x.split(' ');
  return keys.some(k0 => { const k = norm(k0); if (x.includes(k)) return true;
    return words.some(w => { if (lev(w, k) <= (k.length > 5 ? 2 : 1)) return true;
      const st = Math.max(3, k.length - 2); return w.length >= 3 && Math.abs(w.length - k.length) <= 2 && w.slice(0, st) === k.slice(0, st); }); });
}
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function pickDistr(correct, pools, n = 3) {
  const out = []; const seen = new Set([correct]);
  for (const pool of pools) for (const v of shuffle(pool)) { if (out.length >= n) break; if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
  return shuffle([correct, ...out]);
}
const sameType = e => C.ex.filter(x => x.t === e.t && x.id !== e.id);
const wa = e => e.auth && e.auth !== '—' ? e.work + ' — ' + e.auth : e.work;
function question(id, box) {
  const e = EXM[id]; const F = box <= 1 ? 1 : box === 2 ? 2 : box === 3 ? 3 : box === 4 ? 4 : (Math.random() < .5 ? 3 : 4);
  const Q = { id, e, F, typed: F >= 3 };
  const others = sameType(e);
  if (e.t === 'hero') {
    Q.reveal = e.name + ' — ' + wa(e); Q.fact = e.fact || e.clue;
    if (F === 1) { Q.kind = 'Узнай книгу'; Q.prompt = 'Из какой книги этот герой?'; Q.big = e.name; Q.img = e.img;
      Q.options = pickDistr(wa(e), [others.filter(x => x.auth === e.auth && x.work !== e.work).map(wa), others.map(wa)]); Q.answer = wa(e); }
    else if (F === 2) { Q.kind = 'Различи героев'; Q.prompt = 'Кто это? ' + cap(e.clue) + (e.img ? '' : ' (' + e.work + ')'); Q.img = e.img;
      Q.options = pickDistr(e.name, [others.filter(x => x.work === e.work).map(x => x.name), others.filter(x => x.auth === e.auth).map(x => x.name), others.map(x => x.name)]); Q.answer = e.name; }
    else if (F === 4 && e.clue3) { Q.kind = 'Формат 610: три улики'; Q.prompt = 'Улики: ' + e.clue3 + '. Кто это? Напиши имя.'; Q.keys = e.key; }
    else { Q.kind = 'Вспомни сам'; Q.prompt = cap(e.clue) + (F === 3 ? ' (' + e.work + ').' : '.') + ' Кто это? Напиши имя.'; Q.img = e.img; Q.keys = e.key; }
  } else if (e.t === 'work') {
    Q.reveal = e.work + ' — ' + e.auth; Q.fact = e.plot;
    if (F === 1) { Q.kind = 'Узнай автора'; Q.prompt = 'Кто написал эту книгу?'; Q.big = e.work; Q.options = pickDistr(e.auth, [others.map(x => x.auth)]); Q.answer = e.auth; }
    else if (F === 2) { Q.kind = 'Узнай книгу'; Q.prompt = e.plot + ' Что это за книга?'; Q.options = pickDistr(e.work, [others.map(x => x.work)]); Q.answer = e.work; }
    else { Q.kind = 'Вспомни сам'; Q.prompt = e.plot + (F === 3 ? ' (' + e.work + ')' : '') + ' Кто автор? Напиши фамилию.'; Q.keys = e.key; }
  } else if (e.t === 'poem') {
    Q.reveal = e.auth + ', ' + e.title; Q.fact = e.fact; Q.lines = e.lines;
    if (F <= 2) { Q.kind = 'Узнай поэта'; Q.prompt = F === 1 ? 'Чьи это строчки? (' + e.title + ')' : 'Чьи это строчки?'; Q.options = pickDistr(e.auth, [others.map(x => x.auth)]); Q.answer = e.auth; }
    else { Q.kind = 'Вспомни сам'; Q.prompt = 'Чьи это строчки? Напиши фамилию поэта.'; Q.keys = e.key; }
  } else if (e.t === 'writer') {
    Q.reveal = e.name + ' (ключ — «' + e.mkey + '»)'; Q.fact = e.hero;
    if (F <= 2) { Q.kind = 'Узнай писателя'; Q.prompt = 'Кто написал? ' + cap(e.hero) + (F === 2 ? ' Подсказка-ключ: «' + e.mkey + '».' : ''); Q.options = pickDistr(e.name, [others.map(x => x.name)]); Q.answer = e.name; }
    else { Q.kind = 'Слово-ключ'; Q.prompt = (F === 3 ? 'Ключ — «' + e.mkey + '». ' : '') + cap(e.hero) + '. Кто автор? Напиши фамилию.'; Q.keys = e.key; }
  } else if (e.t === 'phrase') {
    Q.reveal = e.phrase + ' — ' + e.mean; Q.fact = e.fact;
    if (F === 1) { Q.kind = 'Пойми выражение'; Q.prompt = 'Что значит:'; Q.big = '«' + e.phrase + '»'; Q.sub = e.sent; Q.options = pickDistr(e.mean, [others.map(x => x.mean)]); Q.answer = e.mean; }
    else if (F === 2) { Q.kind = 'Найди выражение'; Q.prompt = 'Какое выражение значит: «' + e.mean + '»?'; Q.options = pickDistr(e.phrase, [others.map(x => x.phrase)]); Q.answer = e.phrase; }
    else if (F === 4) { Q.kind = 'Примени'; Q.prompt = 'Допиши пропущенное слово:'; Q.big = maskSent(e); Q.keys = e.key; }
    else { Q.kind = 'Вспомни слово'; Q.prompt = e.mean[0].toUpperCase() + e.mean.slice(1) + '. Допиши:'; Q.big = e.gap.replace(/\[.+?\]/, '…'); Q.keys = e.key; }
  }
  return Q;
}
function maskSent(e) {
  const st = norm(e.blank).slice(0, Math.max(3, e.blank.length - 2));
  let done = false;
  const s = e.sent.replace(/[А-Яа-яЁё\-]+/g, w => { if (!done && norm(w).startsWith(st)) { done = true; return '…'; } return w; });
  return done ? s : e.gap.replace(/\[.+?\]/, '…');
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/* ---------- запись результата ---------- */
function grade(id, ok, F) {
  const t = TODAY(); const r = S.ex[id] || { b: 1, d: t, ok: 0, bad: 0 };
  const from = r.b;
  if (ok) { r.b = Math.min(5, r.b + 1); r.ok++; r.bs = 0; r.rep = 0; r.d = plan(id, BOX[r.b].i, t); }
  else { r.b = r.b <= 2 ? 1 : r.b - 2; r.bad++; r.bs = (r.bs || 0) + 1; r.rep = 1; r.d = t + 1;
    const e = EXM[id];
    if (r.bs >= 2 && e.work && e.h === 'lit') S.flags[bookKey(e)] = t;
  }
  r.l = t; r.f = F; S.ex[id] = r;
  return { from, to: r.b };
}
function afterSession(results) {
  // ветка ремонта квиза: 3+ ошибочных экспоната одного квиза → квиз на повтор завтра
  const t = TODAY(); const bad = results.filter(x => !x.ok).map(x => x.id);
  C.quizzes.forEach(q => { if (!S.qz[q.id]) return; const n = q.ex.filter(i => bad.includes(i)).length;
    if (n >= 3 && S.qz[q.id].d > t + 1) { S.qz[q.id].d = t + 1; S.qz[q.id].rp = 1; } });
}
function rateQuiz(qid, rate, missed) {
  const t = TODAY(); const q = QZM[qid];
  const r = S.qz[qid] || { n: 0 }; r.n++; r.last = t; r.rate = rate; r.rp = 0;
  const steps = { easy: [21, 45, 90], ok: [7, 21, 45], hard: [2, 7, 21] }[rate];
  r.d = plan(qid, steps[Math.min(r.n - 1, 2)], t); S.qz[qid] = r;
  q.ex.forEach(id => { const ex = S.ex[id];
    if (missed.includes(id)) { S.ex[id] = Object.assign(ex || { ok: 0, bad: 0 }, { b: 1, d: t + 1, rep: 1, l: t, bad: ((ex && ex.bad) || 0) + 1 }); }
    else if (!ex) { S.ex[id] = { b: 1, d: t + (rate === 'easy' ? 2 : 1), ok: 0, bad: 0, l: t }; }
  });
  logDay({ q: qid }); S.pending = null; save();
}

/* ---------- отрисовка ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let view = 'home', inSession = false;
function go(v) { view = v; inSession = false; document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-current', b.dataset.v === v ? 'page' : 'false')); render(); scrollTo(0, 0); }
document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.v));
$('#logo').onclick = () => go('home');
function render() {
  $('#days').textContent = Math.max(0, EXAM - TODAY()) + ' дн.';
  const m = $('#main');
  if (view === 'home') m.innerHTML = homeHTML(); else if (view === 'halls') m.innerHTML = hallsHTML(); else if (view === 'read') m.innerHTML = readHTML(); else if (view === 'cur') m.innerHTML = curHTML();
  bind();
  if (S.pending && QZM[S.pending] && !document.querySelector('.ov')) ratePanel(S.pending);
}
function hallStats(h) {
  const ids = C.ex.filter(e => e.h === h).map(e => e.id); const c = [0, 0, 0, 0, 0, 0];
  ids.forEach(i => { const r = S.ex[i]; c[r ? r.b : 0]++; });
  return { total: ids.length, c };
}
function barHTML(st) {
  if (!st.total) return '<div class="bar"></div>';
  return '<div class="bar">' + [5, 4, 3, 2, 1].map(b => st.c[b] ? `<i style="width:${st.c[b] / st.total * 100}%;background:${BOX[b].c}" title="${BOX[b].n}: ${st.c[b]}"></i>` : '').join('') + '</div>';
}
function legendHTML() { return '<div class="legend">' + [1, 2, 3, 4, 5].map(b => `<span style="--c:${BOX[b].c}">${BOX[b].n}</span>`).join('') + '<span style="--c:#e4d6b4">ещё не знакомы</span></div>'; }
function qcardHTML(item, btnText) {
  const q = item.q;
  return `<div class="qcard"><div class="grow"><span class="tag ${q.where}">${q.where === 'la' ? 'LearningApps' : q.where === 'app' ? 'Музей' : 'Docfarm'}</span><span class="tag">${esc(HALLM[q.h].name)}</span><span class="tag">≈${q.min} мин</span>
    <div style="font-size:20px;font-weight:700;margin-top:4px">${esc(q.title)}</div><div class="muted" style="font-size:15px">${esc(item.why)} · ${esc(q.note)}</div></div>
    <button class="btn" data-open="${q.id}">${btnText || 'Открыть'}</button></div>`;
}
function homeHTML() {
  const due = dueExhibits(); const nq = nextQuizzes(); const t = TODAY();
  const gold = Object.values(S.ex).filter(r => r.b === 5).length, known = Object.keys(S.ex).length;
  const todayLog = LOG.days[ds(t)];
  let main;
  if (summerNow()) main = `<h2>Летние каникулы музея</h2><p>Залы отдыхают до 1 сентября. Если очень хочется — можно пройти экскурсию.</p><button class="btn" data-act="start">Экскурсия по желанию</button>`;
  else if (due.list.length) main = `<h2>Экскурсия дня</h2><p class="count">${due.list.length} экспонатов${due.all > due.list.length ? ' (ещё ' + (due.all - due.list.length) + ' подождут до завтра)' : ''} · около ${Math.max(3, Math.round(due.list.length * 0.6))} мин</p><button class="btn big" data-act="start">Начать экскурсию</button>`;
  else main = `<h2>${todayLog && todayLog.n ? 'Экскурсия дня пройдена!' : 'Сегодня повторять нечего'}</h2><p class="count">${known ? 'Все знакомые экспонаты в порядке. Можно открыть новую экспозицию ниже.' : 'Музей пока пустой: экспонаты появляются, когда проходишь квизы. Начни с первой экспозиции ниже.'}</p>`;
  const first = nq[0];
  return `<div class="panel"><div class="hero-row"><div class="grow">${main}</div>
      <div class="kpis" style="flex:0 1 330px"><div class="kpi"><b>${known}</b>экспонатов в музее</div><div class="kpi"><b>${gold}</b>в Золотом зале</div></div></div></div>
    ${first ? `<div class="panel"><h2>${first.why === 'Новая экспозиция' ? 'Новая экспозиция' : 'Зал на сегодня'}</h2>${qcardHTML(first)}
      ${nq.length > 1 ? `<details><summary class="muted" style="cursor:pointer">Следующие в очереди (всего ещё ${nq.length - 1})</summary>${nq.slice(1, 6).map(x => qcardHTML(x)).join('')}</details>` : ''}</div>` : ''}
    <div class="panel"><h2>Залы музея</h2>${legendHTML()}<div class="halls" style="margin-top:12px">${C.halls.map(h => { const st = hallStats(h.id); const has = st.total > 0;
      return `<button class="hall ${has ? '' : 'locked'}" ${has ? `data-hall="${h.id}"` : 'disabled'}><span class="ic">${h.icon}</span><b>${esc(h.name)}</b><span class="sub">${has ? st.total + ' экспонатов · ' + esc(h.sub) : 'Зал готовится'}</span>${has ? barHTML(st) : ''}</button>`; }).join('')}</div></div>`;
}
function hallsHTML() {
  return C.halls.map(h => { const qs = C.quizzes.filter(q => q.h === h.id); const st = hallStats(h.id);
    if (!qs.length) return `<div class="panel"><h2>${h.icon} ${esc(h.name)}</h2><p class="muted">Зал готовится: квизы появятся здесь.</p></div>`;
    return `<div class="panel" id="hall-${h.id}"><h2>${h.icon} ${esc(h.name)}</h2>${barHTML(st)}${legendHTML()}
      ${qs.map(q => { const s = quizStatus(q); const r = S.qz[q.id];
        const why = s.st === 'new' ? (q.after && !s.ready ? 'Откроется завтра — после «' + QZM[q.after].title + '»' : 'Ещё не пройден') : s.st === 'locked' ? 'Сначала — «' + QZM[q.after].title + '»' : s.st === 'due' ? 'Пора повторить · пройден ' + r.n + ' раз' : 'Пройден ' + r.n + ' раз · повтор ' + fmtIn(r.d);
        return qcardHTML({ q, why }, s.st === 'new' || s.st === 'locked' ? 'Открыть' : 'Пройти снова'); }).join('')}</div>`; }).join('');
}
function fmtIn(d) { const n = d - TODAY(); return n <= 0 ? 'сегодня' : n === 1 ? 'завтра' : 'через ' + n + ' дн.'; }
const bookKey = e => (e.work || '') + '|' + (e.auth || '');
function readHTML() {
  const books = {}; C.ex.filter(e => e.h === 'lit' && e.work && e.work !== 'русская народная сказка').forEach(e => { const k = bookKey(e); (books[k] = books[k] || { work: e.work, auth: e.auth, ex: [] }).ex.push(e.id); });
  const list = Object.entries(books).map(([k, b]) => ({ k, ...b, flag: S.flags[k], st: S.books[k] || '', bad: b.ex.reduce((s, i) => s + ((S.ex[i] && S.ex[i].bad) || 0), 0) }));
  list.sort((a, b) => (b.flag ? 1 : 0) - (a.flag ? 1 : 0) || b.bad - a.bad || a.work.localeCompare(b.work, 'ru'));
  const flagged = list.filter(b => b.flag && b.st !== 'fresh');
  return `<div class="panel"><h2>Читальный зал</h2><p class="muted">Книги, из которых в музее есть экспонаты. Если герой книги путается два раза подряд, книга поднимается наверх с пометкой «освежить» — лучше послушать её аудио, чем повторять карточки.</p>
    ${flagged.length ? `<h3 class="flag">Освежить: ${flagged.length}</h3>` : ''}
    ${list.map(b => `<div class="book"><div><b>${esc(b.work)}</b> <span class="muted">${esc(b.auth !== '—' ? b.auth : '')}</span> ${b.flag && b.st !== 'fresh' ? '<span class="flag">· освежить</span>' : ''}<div class="muted" style="font-size:13px">${b.ex.map(i => esc(EXM[i].name || EXM[i].title || '')).filter(Boolean).join(', ')}</div></div>
      <div class="seg" data-book="${esc(b.k)}">${[['', 'не знаю'], ['want', 'хочу послушать'], ['done', 'читал/слушал'], ['fresh', 'освежил']].map(([v, l]) => `<button data-st="${v}" aria-pressed="${b.st === v}">${l}</button>`).join('')}</div></div>`).join('')}</div>`;
}
function curHTML() {
  const t = TODAY(); const days = []; for (let i = 27; i >= 0; i--) { const k = ds(t - i); days.push({ k, d: LOG.days[k] || { m: 0, n: 0, ok: 0, q: [] } }); }
  const week = days.slice(-7); const wMin = week.reduce((s, x) => s + x.d.m, 0), wN = week.reduce((s, x) => s + x.d.n, 0), wOk = week.reduce((s, x) => s + x.d.ok, 0), wQ = week.reduce((s, x) => s + x.d.q.length, 0);
  const maxM = Math.max(10, ...days.map(x => x.d.m));
  const hard = Object.entries(S.ex).filter(([i, r]) => r.bad > 0 && EXM[i]).sort((a, b) => b[1].bad - a[1].bad || a[1].b - b[1].b).slice(0, 12);
  const up = []; for (let i = 1; i <= 7; i++) up.push(Object.values(S.ex).filter(r => r.d === t + i).length);
  const phase = t < SUMMER[0] ? 'Набор экспонатов (до лета 2027)' : t <= SUMMER[1] ? 'Лето: пауза' : t < REV_START ? 'Реставрация и расширение (4 класс)' : t <= REV_END ? 'Генеральная ревизия: каждый экспонат — финальное вспоминание' : 'Финиш: только смешанные задания в формате 610';
  return `<div class="panel"><h2>Кабинет куратора</h2><p class="muted">Этап: <b>${phase}</b>. До экзамена ${EXAM - t} дн. Данные: ${mode === 'cloud' ? 'общая база — одинаково на всех устройствах' : FAMILY ? 'пока только это устройство (нет связи)' : 'нет семейной ссылки — прогресс только на этом устройстве'}.</p>
    <div class="kpis"><div class="kpi"><b>${Math.round(wMin)}</b>минут за 7 дней</div><div class="kpi"><b>${wN ? Math.round(wOk / wN * 100) + '%' : '—'}</b>верных в экскурсиях (${wN})</div><div class="kpi"><b>${wQ}</b>квизов за 7 дней</div><div class="kpi"><b>${Object.keys(S.ex).length}/${C.ex.length}</b>экспонатов знакомо</div></div>
    <h3>Минуты по дням (4 недели)</h3><div class="spark">${days.map(x => `<i class="${x.d.m ? '' : 'z'}" style="height:${Math.max(3, x.d.m / maxM * 100)}%" title="${x.k}: ${x.d.m} мин, ${x.d.n} экспонатов, квизы: ${x.d.q.length}"></i>`).join('')}</div>
    <h3>Залы</h3><table><tr><th>Зал</th><th>Знакомо</th><th>Выставка и выше</th><th>Золото</th><th>Верных всего</th></tr>${C.halls.map(h => { const ids = C.ex.filter(e => e.h === h.id).map(e => e.id); if (!ids.length) return ''; const rs = ids.map(i => S.ex[i]).filter(Boolean); const ok = rs.reduce((s, r) => s + r.ok, 0), bad = rs.reduce((s, r) => s + r.bad, 0);
      return `<tr><td>${esc(h.name)}</td><td>${rs.length}/${ids.length}</td><td>${rs.filter(r => r.b >= 3).length}</td><td>${rs.filter(r => r.b === 5).length}</td><td>${ok + bad ? Math.round(ok / (ok + bad) * 100) + '%' : '—'}</td></tr>`; }).join('')}</table>
    <h3>Трудные экспонаты</h3>${hard.length ? `<table><tr><th>Экспонат</th><th>Ошибок</th><th>Ступень</th><th>Следующая встреча</th></tr>${hard.map(([i, r]) => `<tr><td>${esc(label(EXM[i]))}</td><td>${r.bad}</td><td>${BOX[r.b].n}</td><td>${fmtIn(r.d)}</td></tr>`).join('')}</table>` : '<p class="muted">Пока нет.</p>'}
    <h3>Нагрузка на неделю вперёд</h3><p>${up.map((n, i) => `<span class="tag">${['завтра', '+2', '+3', '+4', '+5', '+6', '+7'][i]}: ${n}</span>`).join(' ')}</p>
    <h3>Квизы</h3><table><tr><th>Квиз</th><th>Пройден</th><th>Оценка</th><th>Повтор</th></tr>${C.quizzes.map(q => { const r = S.qz[q.id]; return `<tr><td>${esc(q.title)}</td><td>${r ? r.n + ' раз, ' + ds(r.last) : '—'}</td><td>${r ? { easy: 'легко', ok: 'с ошибками', hard: 'трудно' }[r.rate] : ''}</td><td>${r ? fmtIn(r.d) : ''}</td></tr>`; }).join('')}</table>
    <h3>Настройки</h3><label><input type="checkbox" data-set="freeze" ${S.settings.freeze ? 'checked' : ''}> Летняя пауза 1 июня – 31 августа 2027 (интервалы замораживаются)</label></div>`;
}
function label(e) { return e.t === 'phrase' ? e.phrase : e.t === 'poem' ? e.title + ' (' + e.auth + ')' : e.t === 'work' ? e.work + ' — ' + e.auth : e.t === 'writer' ? e.name : e.name + ' — ' + e.work; }

function bind() {
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openQuiz(b.dataset.open));
  document.querySelectorAll('[data-act="start"]').forEach(b => b.onclick = startSession);
  document.querySelectorAll('[data-hall]').forEach(b => b.onclick = () => { go('halls'); const el = document.getElementById('hall-' + b.dataset.hall); if (el) el.scrollIntoView({ behavior: 'smooth' }); });
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { const k = b.parentElement.dataset.book; S.books[k] = b.dataset.st; if (b.dataset.st === 'fresh' || b.dataset.st === 'done') delete S.flags[k]; save(); render(); });
  document.querySelectorAll('[data-set]').forEach(c => c.onchange = () => { S.settings[c.dataset.set] = c.checked; save(); });
}

/* ---------- внешний квиз и самооценка ---------- */
function openQuiz(qid) {
  const q = QZM[qid];
  if (q.where === 'app') { S.pending = qid; save(); location.href = q.url; return; }
  try { window.open(q.url, '_blank', 'noopener'); } catch (e) {}
  S.pending = qid; save(); ratePanel(qid, true);
}
function ratePanel(qid, justOpened) {
  const q = QZM[qid]; let rate = null; const missed = new Set();
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = `<div class="panel" role="dialog" aria-modal="true"><h2>${justOpened ? 'Квиз открылся в новой вкладке' : 'Как прошёл квиз?'}</h2>
    <p><b>${esc(q.title)}</b><br><span class="muted">${justOpened ? 'Пройди его и возвращайся сюда — отметим, как получилось. Если вкладка не открылась: ' : 'Ссылка: '}<a href="${esc(q.url)}" target="_blank" rel="noopener">открыть квиз</a></span></p>
    <h3>Как получилось?</h3><div class="rates">${[['easy', '😀 Легко'], ['ok', '🤔 Были ошибки'], ['hard', '😓 Трудно']].map(([v, l]) => `<button data-r="${v}" aria-pressed="false">${l}</button>`).join('')}</div>
    <h3>На ком споткнулся? <span class="muted" style="font-size:15px;font-weight:400">(нажми — эти экспонаты придут на ремонт завтра)</span></h3>
    <div class="chips">${q.ex.map(i => `<button class="chip" data-x="${i}" aria-pressed="false">${esc(short(EXM[i]))}</button>`).join('')}</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px"><button class="btn" id="rsave" disabled>Записать в журнал</button><button class="btn ghost" id="rlater">Ещё не прошёл</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { rate = b.dataset.r; ov.querySelectorAll('[data-r]').forEach(x => x.setAttribute('aria-pressed', x === b)); ov.querySelector('#rsave').disabled = false; });
  ov.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { const on = !missed.has(b.dataset.x); on ? missed.add(b.dataset.x) : missed.delete(b.dataset.x); b.setAttribute('aria-pressed', on); });
  ov.querySelector('#rsave').onclick = () => { rateQuiz(qid, rate, [...missed]); ov.remove(); toast('Записано! Экспонаты «' + q.title + '» в музее.'); render(); };
  ov.querySelector('#rlater').onclick = () => { S.pending = null; save(); ov.remove(); };
}
function short(e) { return e.t === 'phrase' ? e.phrase : e.t === 'poem' ? e.title : e.t === 'work' ? e.work : e.name; }
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 3500); }

/* ---------- экскурсия ---------- */
let SES = null;
function startSession() {
  const due = dueExhibits();
  if (!due.list.length) { toast('Сегодня повторять нечего'); return; }
  SES = { ids: due.list, i: 0, res: [], t0: Date.now() }; inSession = true; showQ();
}
function showQ() {
  const id = SES.ids[SES.i]; const r = S.ex[id]; const Q = question(id, r.b); SES.Q = Q; SES.answered = false;
  const m = $('#main');
  m.innerHTML = `<div class="stage"><div class="dots">${SES.ids.map((x, k) => `<i class="${k < SES.res.length ? (SES.res[k].ok ? 'ok' : 'bad') : k === SES.i ? 'cur' : ''}"></i>`).join('')}</div>
    <div class="panel qbox"><div class="kind">${esc(HALLM[Q.e.h].icon + ' ' + HALLM[Q.e.h].name)} · ${esc(Q.kind)} · ступень «${BOX[r.b].n}»${r.rep ? ' · ремонт' : ''}</div>
    <div class="prompt">${esc(Q.prompt)}</div>${Q.big ? `<div class="big">${esc(Q.big)}</div>` : ''}${Q.sub ? `<div class="muted" style="font-style:italic">${esc(Q.sub)}</div>` : ''}
    ${imgSrc(Q.img) ? `<div><img src="${esc(imgSrc(Q.img))}" alt=""></div>` : ''}${Q.lines ? `<pre>${esc(Q.lines)}</pre>` : ''}
    ${Q.typed ? `<form class="typed" id="tf"><input id="ti" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="напиши ответ" aria-label="Ответ"><button class="btn">Проверить</button></form><div style="margin-top:8px"><button class="btn ghost small" id="idk">Не помню</button></div>`
      : `<div class="opts">${Q.options.map((o, k) => `<button class="opt" data-k="${k}">${esc(o)}</button>`).join('')}</div>`}
    <div id="fbx"></div></div></div>`;
  if (Q.typed) { const inp = $('#ti'); inp.focus(); $('#tf').onsubmit = ev => { ev.preventDefault(); if (inp.value.trim()) answer(typedOk(inp.value, Q.keys), inp.value); }; $('#idk').onclick = () => answer(false, ''); }
  else document.querySelectorAll('.opt').forEach(b => b.onclick = () => { const v = Q.options[+b.dataset.k]; document.querySelectorAll('.opt').forEach(x => { x.disabled = true; if (Q.options[+x.dataset.k] === Q.answer) x.classList.add('right'); }); if (v !== Q.answer) b.classList.add('wrong'); answer(v === Q.answer, v); });
}
function answer(ok, given) {
  if (SES.answered) return; SES.answered = true; const Q = SES.Q;
  const mv = grade(Q.id, ok, Q.F); SES.res.push({ id: Q.id, ok, mv });
  if (Q.typed) { const f = $('#tf'); f.querySelectorAll('input,button').forEach(x => x.disabled = true); $('#idk').disabled = true; }
  const moveTxt = mv.to > mv.from ? `Экспонат переезжает: ${BOX[mv.from].n} → <b style="display:inline">${BOX[mv.to].n}</b>` : mv.to < mv.from ? `Экспонат отправлен на ступень «${BOX[mv.to].n}» — завтра встретимся снова` : 'Завтра встретимся снова';
  $('#fbx').innerHTML = `<div class="fb ${ok ? 'ok' : 'bad'}"><b>${ok ? 'Верно!' : 'Правильный ответ: ' + esc(Q.reveal)}</b>${ok ? esc(Q.reveal) + '<br>' : ''}${Q.fact ? esc(Q.fact) + '<br>' : ''}<span class="muted" style="font-size:.9em">${moveTxt}</span></div>
    <div style="margin-top:14px"><button class="btn big" id="nx">${SES.i + 1 < SES.ids.length ? 'Дальше' : 'Закончить экскурсию'}</button></div>`;
  save(); const nx = $('#nx'); nx.focus(); nx.onclick = () => { SES.i++; SES.i < SES.ids.length ? showQ() : endSession(); };
}
function endSession() {
  const min = Math.min(30, (Date.now() - SES.t0) / 60000); const ok = SES.res.filter(x => x.ok).length;
  logDay({ m: min, n: SES.res.length, ok }); afterSession(SES.res); save(); inSession = false;
  const up = SES.res.filter(x => x.mv.to > x.mv.from), gold = SES.res.filter(x => x.mv.to === 5 && x.mv.from === 4);
  $('#main').innerHTML = `<div class="stage"><div class="panel" style="text-align:center"><h2>Экскурсия окончена!</h2>
    <p style="font-size:22px">Верно ${ok} из ${SES.res.length}${gold.length ? ` · <b>${gold.length}</b> в Золотом зале!` : ''}</p>
    ${up.length ? `<h3>Переехали выше</h3><div class="moves">${up.map(x => `<span class="mv">${esc(short(EXM[x.id]))}: ${BOX[x.mv.to].n}</span>`).join('')}</div>` : ''}
    ${SES.res.some(x => !x.ok) ? `<h3>На ремонт завтра</h3><div class="moves">${SES.res.filter(x => !x.ok).map(x => `<span class="mv">${esc(short(EXM[x.id]))}</span>`).join('')}</div>` : ''}
    <button class="btn big" id="home">В музей</button></div></div>`;
  $('#home').onclick = () => go('home');
}

/* ---------- старт ---------- */
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.pending && !document.querySelector('.ov') && !inSession) render(); });
initStore();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
