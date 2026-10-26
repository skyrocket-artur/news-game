'use strict';
/* =========================================================================
   SKYROCKET · НОВОСТНОЙ ТРЕЙДЕР — логика и интерфейс
   Параметры адреса: ?seed=N — повторяемая игра (тот же набор новостей и графики),
                     ?fast=1 — быстрые анимации (для тестов).
   ========================================================================= */

const CONFIG = {
  startBalance: 100000,
  rounds: 11,                          // новостей в одной игре (из пула NEWS)
  quota: { trap: 2, priced: 2, tricky: 2 }, // сколько «подвохов» каждого типа в игре, остальное — обычные
  groupMax: { cb: 2 },                 // по умолчанию — не больше 1 новости из группы
  assetMax: 2,                         // один инструмент — не больше двух раз за игру
  leverage: 2,                         // позиция = доля депозита × плечо
  sizes: [0.25, 0.5, 1],
  marginCall: 0.5,                     // баланс ниже 50% от стартового — игра окончена
  passBalance: 110000,                 // условие прохождения: баланс не меньше...
  passCorrect: 7,                      // ...и не меньше 7 верных решений
  animMs: 3600,                        // длительность «торгового дня» на графике
  closeTime: '18:50',
  // Ссылки финала
  passUrl: 'https://t.me/YunusovArtur_bot?start=news_pass',
  shareBotUrl: 'https://t.me/YunusovArtur_bot?start=news_share',
  nextUrl: 'https://t.me/YunusovArtur_bot?start=speculant',
  skyUrl: 'https://t.me/YunusovArtur_bot?start=skyrocket_news',
  shareText: 'Моё звание в игре «Новостной трейдер» — «{title}», результат {pct}. Сможешь лучше отличить новость от шума?',
};

const app = document.getElementById('app');
const QS = new URLSearchParams(location.search);
const URL_SEED = /^\d{1,9}$/.test(QS.get('seed') || '') ? +QS.get('seed') : null;
const FAST = QS.get('fast') === '1';
const ANIM_MS = FAST ? 300 : CONFIG.animMs;
const tg = (window.Telegram && window.Telegram.WebApp) || null;
let G = null;

const ROCKET = '<svg class="rocket" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 2.5c2.9 2.1 4.4 5.4 4.4 9.2v4.1H7.6v-4.1c0-3.8 1.5-7.1 4.4-9.2z"/><circle cx="12" cy="9.6" r="1.7"/>'
  + '<path d="M7.6 12.4 4.8 15.3v3.2l2.8-1.4M16.4 12.4l2.8 2.9v3.2l-2.8-1.4"/><path d="M10.3 18.2 12 21.5l1.7-3.3"/></svg>';
const BRAND = `<span class="brand">${ROCKET}SKYROCKET <span>· НОВОСТНОЙ ТРЕЙДЕР</span></span>`;

/* ---------- утилиты ---------- */
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fmtR = v => nf0.format(Math.round(v)) + ' ₽';
const fmtRs = v => (Math.round(v) > 0 ? '+' : Math.round(v) < 0 ? '−' : '') + nf0.format(Math.abs(Math.round(v))) + ' ₽';
const fmtPct = (v, d = 1) => { const r = +v.toFixed(d); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(d).replace('.', ',') + '%'; };
const cls = v => v > 0.0001 ? 'up' : v < -0.0001 ? 'dn' : '';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, a, b, c) => { const n10 = n % 10, n100 = n % 100; return n10 === 1 && n100 !== 11 ? a : n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20) ? b : c; };
const DIR = { buy: { t: 'Купить', s: 1 }, short: { t: 'Продать (шорт)', s: -1 }, hold: { t: 'Не трогать', s: 0 } };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const store = {
  get() { try { return JSON.parse(localStorage.getItem('newsTrader') || '{}'); } catch (e) { return {}; } },
  set(v) { try { localStorage.setItem('newsTrader', JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
};
function show(html) { if (G) cancelAnimationFrame(G.raf); app.innerHTML = html; window.scrollTo(0, 0); }

/* =========================================================================
   НАБОР НОВОСТЕЙ И ГРАФИКИ
   ========================================================================= */
function pickNews(rnd) {
  const picked = [], groups = {}, assets = {};
  const ok = n => {
    const gm = n.group ? (CONFIG.groupMax[n.group] || 1) : Infinity;
    return (groups[n.group] || 0) < gm && (assets[n.a] || 0) < CONFIG.assetMax;
  };
  const take = n => { picked.push(n); if (n.group) groups[n.group] = (groups[n.group] || 0) + 1; assets[n.a] = (assets[n.a] || 0) + 1; };
  const quota = Object.assign({}, CONFIG.quota);
  quota.normal = CONFIG.rounds - Object.values(CONFIG.quota).reduce((s, x) => s + x, 0);
  for (const kind of ['trap', 'priced', 'tricky', 'normal']) {
    let need = quota[kind];
    for (const n of shuffle(NEWS.filter(x => x.kind === kind), rnd)) { if (need <= 0) break; if (ok(n)) { take(n); need--; } }
  }
  // если ограничения не дали набрать нужное число — добираем любыми подходящими
  for (const n of shuffle(NEWS, rnd)) { if (picked.length >= CONFIG.rounds) break; if (!picked.includes(n) && ok(n)) take(n); }

  // первая новость — обычная (разминка), дальше — вперемешку, без двух ловушек подряд
  const first = picked.find(n => n.kind === 'normal') || picked[0];
  const rest = shuffle(picked.filter(n => n !== first), rnd);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < rest.length; i++) {
      if (rest[i].kind !== 'normal' && rest[i - 1].kind === rest[i].kind) {
        const j = rest.findIndex((x, k) => k > i && x.kind !== rest[i].kind && (k + 1 >= rest.length || rest[k + 1].kind !== rest[i].kind));
        if (j > 0) [rest[i], rest[j]] = [rest[j], rest[i]];
      }
    }
  }
  return [first, ...rest];
}

/* Внутридневной путь цены: плавная линия по опорным точкам + шум, который равен нулю в начале и в конце */
function buildPath(n, rnd, N = 90) {
  const kp = n.path;
  const base = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    let k = 0; while (k < kp.length - 2 && t > kp[k + 1][0]) k++;
    const [t0, v0] = kp[k], [t1, v1] = kp[k + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
    const e = (1 - Math.cos(Math.PI * u)) / 2;
    base.push(v0 + (v1 - v0) * e);
  }
  const amp = 0.06 * Math.max(...kp.map(p => Math.abs(p[1]))) + 0.18;
  let w = 0; const walk = [0];
  for (let i = 1; i < N; i++) { w += (rnd() - 0.5) * 2; walk.push(w); }
  const end = walk[N - 1];
  const br = walk.map((x, i) => x - end * i / (N - 1));
  const mx = Math.max(...br.map(Math.abs)) || 1;
  return base.map((v, i) => {
    if (i === 0) return 0;
    if (i === N - 1) return n.move;
    return v + (br[i] / mx) * amp + (rnd() - 0.5) * amp * 0.5;
  });
}

function timeAt(start, frac) {
  const [h0, m0] = start.split(':').map(Number), [h1, m1] = CONFIG.closeTime.split(':').map(Number);
  const a = h0 * 60 + m0, b = h1 * 60 + m1, m = Math.round(a + (b - a) * frac);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* =========================================================================
   НОВАЯ ИГРА
   ========================================================================= */
function newGame() {
  const seed = URL_SEED != null ? URL_SEED : 1 + Math.floor(Math.random() * 999999);
  const rnd = mulberry32(seed);
  const news = pickNews(rnd);
  G = {
    seed, ri: -1, bal: CONFIG.startBalance, peak: CONFIG.startBalance,
    rounds: news.map(n => ({ n, pts: buildPath(n, rnd) })),
    log: [], sel: { dir: null, size: 0.5 }, phase: 'decide', over: false, raf: 0,
  };
}

/* =========================================================================
   ЭКРАНЫ
   ========================================================================= */
function scrIntro() {
  const tape = TAPE.map(([t, v]) => `<span><b>${t}</b><em class="${cls(v)}" style="font-style:normal">${v > 0 ? '▲' : '▼'} ${fmtPct(v)}</em></span>`).join('');
  const st = store.get();
  show(`
  <div class="tape" aria-hidden="true"><div class="tape-in">${tape}${tape}</div></div>
  <div class="intro">
    <div class="top-r" style="margin-bottom:14px">${BRAND}<span class="live"><i class="dot"></i>LIVE</span></div>
    <div class="levels" aria-label="Уровень игры"><span>1 · Инвест-старт</span><span class="on">2 · Новостной трейдер</span><span>3 · Спекулянт</span></div>
    <h1 class="hero-t">Новостной<br><em>трейдер</em></h1>
    <p class="lead">Рынок двигают новости. Но не каждая новость двигает рынок так, как кажется. ${CONFIG.rounds} заголовков — и на каждый одно решение.</p>
    <div class="rules">
      <div class="rule"><i>01</i><div>На счёте <b>${fmtR(CONFIG.startBalance)}</b> виртуальных. Читаешь новость и выбираешь: <b>купить</b>, <b>продать в шорт</b> или <b>не трогать</b>.</div></div>
      <div class="rule"><i>02</i><div>Выбираешь размер позиции: 25%, 50% или 100% счёта. Плечо — ×${CONFIG.leverage}: прибыль и убыток удваиваются.</div></div>
      <div class="rule"><i>03</i><div>Смотришь, как рынок отреагировал за день, и разбираешь <b>почему</b>. Осторожно: среди новостей есть слухи, фейки и то, что уже в цене.</div></div>
      <div class="rule"><i>04</i><div>Если счёт упадёт ниже <b>${fmtR(CONFIG.startBalance * CONFIG.marginCall)}</b> — маржин-колл, игра окончена.</div></div>
    </div>
    <div class="goal"><div class="k">УСЛОВИЕ ПРОХОЖДЕНИЯ</div>Закончить с балансом от <b>${fmtR(CONFIG.passBalance)}</b> и принять не меньше <b>${CONFIG.passCorrect} верных решений</b> из ${CONFIG.rounds}.</div>
    ${st.plays ? `<p class="foot-note">Сыграно игр: ${st.plays}${st.best ? ` · лучший результат: ${fmtPct(st.best)}` : ''}</p>` : ''}
    <p class="foot-note">Все компании и новости вымышлены. Не является инвестиционной рекомендацией.</p>
    <div class="sticky"><div class="sticky-in"><button class="btn primary" data-act="start">Начать торговый день →</button></div></div>
  </div>`);
}

function topBar() {
  const correct = G.log.filter(x => x.correct).length;
  const done = G.log.length;
  const chg = G.bal / CONFIG.startBalance - 1;
  return `<div class="top">
    <div class="top-r">${BRAND}<span class="live"><i class="dot${G.bal < CONFIG.startBalance * 0.65 ? ' red' : ''}"></i>LIVE</span></div>
    <div class="top-r"><span class="bal" id="bal">${fmtR(G.bal)}<small class="${cls(chg)}">${fmtPct(chg * 100)}</small></span>
      <span class="stat">новость <b>${Math.min(G.ri + 1, CONFIG.rounds)}/${CONFIG.rounds}</b> · верно <b id="ok">${correct}</b>${done ? `/${done}` : ''}</span></div>
    <div class="prog"><i style="width:${(done / CONFIG.rounds) * 100}%"></i></div>
  </div>`;
}

function cur() { return G.rounds[G.ri]; }

function renderRound() {
  const R = cur(), n = R.n, a = ASSETS[n.a], s = SRC[n.src];
  show(`
  ${topBar()}
  <div class="scr">
    <div class="card news${n.src === 'rumor' ? ' rum' : ''}">
      <div class="meta"><span class="badge ${s.cls}">${s.label}</span><span>${esc(n.who)}</span><span>${n.time} МСК</span></div>
      <h2>${esc(n.h)}</h2>
      <p>${esc(n.lead)}</p>
    </div>
    <div class="asset"><span class="tk">${a.tk}</span><div><div class="nm">${esc(a.name)}</div><div class="sc">${esc(a.sector)}</div></div></div>
    <div class="card chartcard">
      <div class="chead"><span>${a.tk}</span><span class="chg" id="chg">0,0%</span><span class="tm" id="tm">${n.time} → ${CONFIG.closeTime}</span></div>
      <canvas id="chart"></canvas>
      <div class="chips" id="chips"></div>
    </div>
    <div id="panel">${panelDecide()}</div>
    <div id="after"></div>
    <div class="sticky"><div class="sticky-in" id="cta">${ctaDecide()}</div></div>
  </div>`);
  drawChart(0);
}

function panelDecide() {
  const s = G.sel, d = s.dir;
  const pos = G.bal * s.size * CONFIG.leverage;
  return `<div class="card">
    <div class="lbl">Твоё решение</div>
    <div class="seg dir">
      <button class="buy${d === 'buy' ? ' on' : ''}" data-act="dir" data-v="buy">Купить<small>▲ на рост</small></button>
      <button class="short${d === 'short' ? ' on' : ''}" data-act="dir" data-v="short">Продать<small>▼ шорт</small></button>
      <button class="hold${d === 'hold' ? ' on' : ''}" data-act="dir" data-v="hold">Не трогать<small>○ пропуск</small></button>
    </div>
    <div class="grp${d === 'hold' ? ' off' : ''}">
      <div class="lbl">Размер позиции</div>
      <div class="seg size">${CONFIG.sizes.map(v => `<button class="${s.size === v ? 'on' : ''}" data-act="size" data-v="${v}">${v * 100}%</button>`).join('')}</div>
      <div class="calc">Позиция <b>${fmtR(pos)}</b> (${s.size * 100}% счёта × плечо ${CONFIG.leverage}).<br>Каждый 1% движения цены — <b>${fmtR(pos / 100)}</b>.</div>
    </div>
  </div>`;
}
function ctaDecide() {
  const d = G.sel.dir;
  const t = d === null ? 'Выбери решение' : d === 'hold' ? 'Пропустить и смотреть рынок' : `${d === 'buy' ? 'Купить' : 'Продать в шорт'} · ${G.sel.size * 100}%`;
  return `<button class="btn primary" data-act="confirm"${d === null ? ' disabled' : ''}>${t}</button>`;
}

/* ---------- реакция рынка ---------- */
function confirm() {
  if (G.phase !== 'decide' || G.sel.dir === null) return;
  G.phase = 'live';
  const R = cur(), d = G.sel.dir;
  R.dir = d; R.size = d === 'hold' ? 0 : G.sel.size;
  R.pos = G.bal * R.size * CONFIG.leverage;
  document.getElementById('panel').innerHTML = `<div class="card">
    <div class="lbl">${d === 'hold' ? 'Ты не в позиции — просто смотришь' : `Позиция открыта: ${DIR[d].t.toLowerCase()} · ${R.size * 100}%`}</div>
    <div class="livebox"><span class="pnl" id="pnl">0 ₽</span><span class="pos">${d === 'hold' ? 'без риска' : `${fmtR(R.pos)}<br>с плечом ×${CONFIG.leverage}`}</span></div>
    <div class="lprog"><i id="lp"></i></div>
  </div>`;
  document.getElementById('cta').innerHTML = '<button class="btn ghost" disabled>Идёт торговый день…</button>';
  const t0 = performance.now();
  const step = now => {
    const f = Math.min(1, (now - t0) / ANIM_MS);
    drawChart(f);
    const v = valueAt(R.pts, f);
    const pnl = R.pos * DIR[d].s * v / 100;
    const el = document.getElementById('pnl');
    if (!el) return;
    el.textContent = d === 'hold' ? '0 ₽' : fmtRs(pnl);
    el.className = 'pnl ' + (d === 'hold' ? '' : cls(pnl));
    document.getElementById('lp').style.width = (f * 100) + '%';
    if (f < 1) G.raf = requestAnimationFrame(step); else finishRound();
  };
  G.raf = requestAnimationFrame(step);
}

function valueAt(pts, f) {
  const x = f * (pts.length - 1), i = Math.floor(x), u = x - i;
  return i >= pts.length - 1 ? pts[pts.length - 1] : pts[i] + (pts[i + 1] - pts[i]) * u;
}

function finishRound() {
  const R = cur(), n = R.n, d = R.dir;
  const pnl = d === 'hold' ? 0 : R.pos * DIR[d].s * n.move / 100;
  const before = G.bal;
  G.bal = Math.max(0, G.bal + pnl);
  G.peak = Math.max(G.peak, G.bal);
  const correct = n.right.includes(d);
  G.log.push({ id: n.id, kind: n.kind, h: n.h, dir: d, size: R.size, pnl, ret: pnl / before, correct, right: n.right });
  G.phase = 'result';
  if (G.bal < CONFIG.startBalance * CONFIG.marginCall) G.over = true;

  let vcls, vtxt;
  if (correct) { vcls = 'up'; vtxt = '✓ ВЕРНОЕ РЕШЕНИЕ'; }
  else if (pnl > 0) { vcls = 'am'; vtxt = '≈ ПОВЕЗЛО, НО РЕШЕНИЕ НЕВЕРНОЕ'; }
  else { vcls = 'dn'; vtxt = '✕ ОШИБКА'; }
  const rightTxt = n.right.map(x => DIR[x].t.toLowerCase()).join(' или ');

  const panel = document.getElementById('panel');
  panel.innerHTML = `<div class="card reveal" id="res">
    <div class="verdict ${vcls}">${vtxt}</div>
    <div class="res-row"><span>Рынок за день</span><b class="${cls(n.move)}">${fmtPct(n.move)}</b></div>
    <div class="res-row"><span>Твоё решение</span><b>${DIR[d].t}${d === 'hold' ? '' : ` · ${R.size * 100}%`}</b></div>
    <div class="res-row"><span>Результат</span><b class="${cls(pnl)}">${d === 'hold' ? '0 ₽' : `${fmtRs(pnl)} (${fmtPct(pnl / before * 100)})`}</b></div>
    ${correct ? '' : `<div class="res-row"><span>Верно было</span><b class="up">${rightTxt}</b></div>`}
  </div>`;
  document.getElementById('after').innerHTML = `<div class="card why reveal"><div class="k">РАЗБОР</div><h3>Почему рынок так отреагировал</h3><p>${esc(n.why)}</p></div>`;
  const last = G.ri >= CONFIG.rounds - 1;
  const btn = G.over ? '<button class="btn gold" data-act="next">Маржин-колл — к итогам</button>'
    : `<button class="btn primary" data-act="next">${last ? 'Итоги игры →' : 'Следующая новость →'}</button>`;
  document.getElementById('cta').innerHTML = btn;
  // обновить верхнюю панель
  const top = document.querySelector('.top');
  if (top) top.outerHTML = topBar();
  setTimeout(() => { const r = document.getElementById('res'); if (r) r.scrollIntoView({ behavior: FAST ? 'auto' : 'smooth', block: 'start' }); }, FAST ? 0 : 250);
}

/* ---------- график ---------- */
function drawChart(f) {
  const cv = document.getElementById('chart');
  if (!cv) return;
  const R = cur(), n = R.n, pts = R.pts;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const padR = 44, padT = 8, padB = 18, w = W - padR, h = H - padT - padB;
  const ext = Math.max(...pts.map(Math.abs));
  const yMax = f <= 0 ? 5 : Math.max(2, Math.ceil(ext * 1.15)); // до решения шкала нейтральная, чтобы не подсказывать размах
  const y = v => padT + h / 2 - (v / yMax) * (h / 2);
  const x = i => (i / (pts.length - 1)) * (w - 4) + 2;
  const mono = getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace';

  // сетка и подписи
  c.font = `500 10px ${mono}`; c.textBaseline = 'middle';
  for (const v of [yMax, yMax / 2, 0, -yMax / 2, -yMax]) {
    c.strokeStyle = v === 0 ? 'rgba(232,238,243,.28)' : 'rgba(125,139,153,.12)';
    c.setLineDash(v === 0 ? [4, 4] : []);
    c.beginPath(); c.moveTo(0, y(v)); c.lineTo(w, y(v)); c.stroke();
    c.fillStyle = '#7D8B99';
    c.fillText((v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(Math.abs(v) < 10 && v % 1 ? 1 : 0).replace('.', ',') + '%', w + 6, y(v));
  }
  c.setLineDash([]);
  c.textBaseline = 'alphabetic'; c.fillStyle = '#4c5a68';
  c.fillText(n.time, 2, H - 4);
  const ct = CONFIG.closeTime; c.fillText(ct, w - c.measureText(ct).width - 2, H - 4);

  if (f <= 0) {
    c.fillStyle = '#7D8B99'; c.font = `500 12px ${mono}`; c.textAlign = 'center';
    c.fillText('реакция рынка — после твоего решения', w / 2, y(0) - 12);
    c.textAlign = 'left';
    c.fillStyle = '#E8EEF3'; c.beginPath(); c.arc(x(0), y(0), 3.5, 0, Math.PI * 2); c.fill();
    return;
  }

  // события
  const chips = document.getElementById('chips');
  (n.ev || []).forEach(([t, label], k) => {
    if (f < t) return;
    const xi = x(t * (pts.length - 1));
    c.strokeStyle = 'rgba(245,196,81,.55)'; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(xi, padT); c.lineTo(xi, padT + h); c.stroke(); c.setLineDash([]);
    if (chips && !chips.querySelector(`[data-ev="${k}"]`)) chips.insertAdjacentHTML('beforeend', `<span class="chip" data-ev="${k}">${timeAt(n.time, t)} · ${esc(label)}</span>`);
  });

  const last = f * (pts.length - 1), iEnd = Math.floor(last);
  const vNow = valueAt(pts, f);
  const col = vNow >= 0 ? '#00D68F' : '#FF4D6A';
  c.beginPath();
  for (let i = 0; i <= iEnd; i++) { i ? c.lineTo(x(i), y(pts[i])) : c.moveTo(x(i), y(pts[i])); }
  c.lineTo(x(last), y(vNow));
  c.save();
  c.lineWidth = 2; c.strokeStyle = col; c.lineJoin = 'round'; c.shadowColor = col; c.shadowBlur = 8; c.stroke();
  c.restore();
  c.lineTo(x(last), y(0)); c.lineTo(x(0), y(0)); c.closePath();
  const gr = c.createLinearGradient(0, padT, 0, padT + h);
  if (vNow >= 0) { gr.addColorStop(0, 'rgba(0,214,143,.25)'); gr.addColorStop(0.5, 'rgba(0,214,143,0)'); }
  else { gr.addColorStop(0.5, 'rgba(255,77,106,0)'); gr.addColorStop(1, 'rgba(255,77,106,.25)'); }
  c.fillStyle = gr; c.fill();
  c.fillStyle = col; c.beginPath(); c.arc(x(last), y(vNow), 3.5, 0, Math.PI * 2); c.fill();

  const chg = document.getElementById('chg');
  if (chg) { chg.textContent = fmtPct(vNow); chg.className = 'chg ' + cls(vNow); }
  const tm = document.getElementById('tm');
  if (tm) tm.textContent = f >= 1 ? `закрытие ${CONFIG.closeTime}` : timeAt(n.time, f);
}

/* =========================================================================
   ФИНАЛ
   ========================================================================= */
function scrEnd() {
  const L = G.log, played = L.length;
  const correct = L.filter(x => x.correct).length;
  const ret = G.bal / CONFIG.startBalance - 1;
  const success = !G.over && G.bal >= CONFIG.passBalance && correct >= CONFIG.passCorrect;
  const trades = L.filter(x => x.dir !== 'hold');
  const holds = L.filter(x => x.dir === 'hold').length;
  const avgSize = trades.length ? trades.reduce((s, x) => s + x.size, 0) / trades.length : 0;
  const traps = L.filter(x => x.kind === 'trap' || x.kind === 'priced');
  const trapsOk = traps.filter(x => x.correct).length;
  const fooled = L.filter(x => (x.kind === 'trap' && x.dir !== 'hold') || (x.kind === 'priced' && x.dir === 'buy')).length;

  let tid;
  if (G.over) tid = 'allin';
  else if (success && trapsOk === traps.length && correct >= 9) tid = 'lines';
  else if (success && avgSize <= 0.55) tid = 'cold';
  else if (success) tid = 'surfer';
  else if (fooled >= 2) tid = 'panic';
  else if (holds >= 6) tid = 'watcher';
  else tid = 'headlines';
  const T = TITLES[tid];
  G.result = { tid, ret, success };

  const st = store.get();
  st.plays = (st.plays || 0) + 1;
  st.best = Math.max(st.best == null ? -100 : st.best, +(ret * 100).toFixed(1));
  if (success) st.passed = true;
  store.set(st);

  const best = trades.length ? trades.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worst = trades.length ? trades.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;
  const share = shareUrl(T.t, ret);
  const rows = L.map(x => `<div class="lr"><span class="ic ${x.correct ? 'up' : 'dn'}">${x.correct ? '✓' : '✕'}</span><span class="t">${esc(x.h)}</span>
    <span class="p ${cls(x.pnl)}">${x.dir === 'hold' ? 'пропуск' : fmtRs(x.pnl)}</span></div>`).join('');

  show(`
  <div class="scr end">
    <div class="top-r">${BRAND}<span class="live"><i class="dot${success ? '' : ' red'}"></i>ИТОГИ</span></div>
    ${G.over ? '<div class="mc" style="margin-top:14px">МАРЖИН-КОЛЛ · ИГРА ОКОНЧЕНА</div>' : ''}
    <div class="glyph ${T.col}">${T.glyph}</div>
    <div class="end-k">ТВОЁ ЗВАНИЕ</div>
    <h1 class="end-t ${T.col}">${T.t}</h1>
    <div class="end-res"><b class="${cls(ret)}">${fmtPct(ret * 100)}</b><span>${fmtR(G.bal)} из ${fmtR(CONFIG.startBalance)} · ${played} ${plural(played, 'новость', 'новости', 'новостей')}</span></div>
    <div class="card"><p>${T.x}</p>
      <div class="checks">
        <div class="check"><span>Баланс от ${fmtR(CONFIG.passBalance)}</span><b class="${G.bal >= CONFIG.passBalance && !G.over ? 'up' : 'dn'}">${G.bal >= CONFIG.passBalance && !G.over ? '✓' : '✕'} ${fmtR(G.bal)}</b></div>
        <div class="check"><span>Верных решений от ${CONFIG.passCorrect}</span><b class="${correct >= CONFIG.passCorrect ? 'up' : 'dn'}">${correct >= CONFIG.passCorrect ? '✓' : '✕'} ${correct} из ${played}</b></div>
      </div>
    </div>
    ${success ? `
    <div class="card pass" id="pass">
      <div class="k up">УСПЕШНОЕ ПРОХОЖДЕНИЕ</div>
      <h3>Ты прошёл игру. Открыт финальный уровень (7 из 7) — «Спекулянт: Точка Б»</h3>
      <p>Путь трейдера от первого депозита до первых денег или ликвидации на реальных котировках 2018–2026. Самая сложная игра в лестнице.</p>
      <a class="btn primary" id="passBtn" href="${CONFIG.passUrl}" target="_blank" rel="noopener" data-tg>Играть в финальный уровень 🎮</a>
      <a class="btn ghost" id="skyBtn" href="${CONFIG.skyUrl}" target="_blank" rel="noopener" data-tg>Узнать про закрытый канал 🔒</a>
      <button class="btn ghost" data-act="again">Сыграть ещё раз</button>
    </div>` : `
    <div class="card fail" id="fail">
      <h3>Почти. Пройди игру, и откроется финальный уровень — «Спекулянт: Точка Б»</h3>
      <button class="btn gold" data-act="again">Попробовать ещё раз</button>
      <a class="btn ghost" id="nextBtn" href="${CONFIG.nextUrl}" target="_blank" rel="noopener" data-tg>Всё равно перейти к финалу</a>
      <a class="btn ghost" id="skyBtn" href="${CONFIG.skyUrl}" target="_blank" rel="noopener" data-tg>Узнать про закрытый канал 🔒</a>
    </div>`}
    <div class="card"><div class="k">СТАТИСТИКА</div>
      <div class="kv">
        <div><span>сделок / пропусков</span><b>${trades.length} / ${holds}</b></div>
        <div><span>слухи и «уже в цене»</span><b>${trapsOk} из ${traps.length}</b></div>
        <div><span>лучшая сделка</span><b class="${best ? cls(best.pnl) : ''}">${best ? fmtRs(best.pnl) : '—'}</b></div>
        <div><span>худшая сделка</span><b class="${worst ? cls(worst.pnl) : ''}">${worst ? fmtRs(worst.pnl) : '—'}</b></div>
      </div>
    </div>
    <div class="card"><div class="k">ТВОИ РЕШЕНИЯ</div><div class="log">${rows}</div></div>
    <p class="disc">Все компании и новости в игре вымышлены.<br>Не является инвестиционной рекомендацией.</p>
    <p class="seed">партия №${G.seed}</p>
    <div class="sticky"><div class="sticky-in">
      <a class="btn ghost" id="shareBtn" href="${share}" target="_blank" rel="noopener" data-tg>Брось вызов другу</a>
    </div></div>
  </div>`);
}

function shareUrl(title, ret) {
  const text = CONFIG.shareText.replace('{title}', title).replace('{pct}', fmtPct(ret * 100));
  return `https://t.me/share/url?url=${encodeURIComponent(CONFIG.shareBotUrl)}&text=${encodeURIComponent(text)}`;
}

/* =========================================================================
   ДЕЙСТВИЯ
   ========================================================================= */
function nextRound() {
  if (G.over || G.ri >= CONFIG.rounds - 1) return scrEnd();
  G.ri++;
  G.sel.dir = null;
  G.phase = 'decide';
  renderRound();
}

const ACT = {
  start: () => { newGame(); nextRound(); },
  dir: b => {
    if (G.phase !== 'decide') return;
    G.sel.dir = b.dataset.v;
    document.getElementById('panel').innerHTML = panelDecide();
    document.getElementById('cta').innerHTML = ctaDecide();
  },
  size: b => {
    if (G.phase !== 'decide' || G.sel.dir === 'hold') return;
    G.sel.size = +b.dataset.v;
    document.getElementById('panel').innerHTML = panelDecide();
    document.getElementById('cta').innerHTML = ctaDecide();
  },
  confirm: () => confirm(),
  next: () => { if (G.phase === 'result') nextRound(); },
  again: () => { newGame(); nextRound(); },
};

document.addEventListener('click', e => {
  const a = e.target.closest('a[data-tg]');
  if (a && tg && tg.initData && typeof tg.openTelegramLink === 'function') {
    try { e.preventDefault(); tg.openTelegramLink(a.href); } catch (err) { window.open(a.href, '_blank'); }
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const f = ACT[b.dataset.act];
  if (f) f(b);
});

let rz;
window.addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => {
    if (!G || !document.getElementById('chart')) return;
    const cv = document.getElementById('chart'); cv.width = 0;
    drawChart(G.phase === 'decide' ? 0 : 1);
  }, 120);
});

(function init() {
  if (tg) {
    try {
      tg.ready(); tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor('#0A0F14');
      if (tg.setBackgroundColor) tg.setBackgroundColor('#0A0F14');
    } catch (e) { /* не в Telegram */ }
  }
  scrIntro();
})();
