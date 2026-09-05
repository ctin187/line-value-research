/**
 * Front end. Renders the board, keeps the parlay slip, and drives the refresh
 * cycle. All parlay maths comes from /shared/parlay.js -- the same module the
 * server imports, so the slip can never disagree with the API.
 */
import {
  formatAmerican, formatPoint, americanToImplied,
} from '/shared/odds.js';
import { quoteParlay } from '/shared/parlay.js';

/** Slider position that means "no edge filter at all". */
const MIN_EDGE_OFF = -3;

const state = {
  config: null,
  view: null,
  sport: 'nfl',
  markets: new Set(['spreads', 'totals', 'h2h']),
  books: new Set(),
  minEdge: MIN_EDGE_OFF,
  highValueOnly: false,
  liveOnly: false,
  autoRefresh: false,
  /** Sports we have already asked upstream for, so a failure is not retried in a loop. */
  fetchAttempted: new Set(),
  sort: 'edge',
  search: '',
  legs: loadLegs(),
  /** selKey -> text the user is part-way through typing into a probability box. */
  estimateDrafts: new Map(),
  seenAlertIds: new Set(),
  loading: false,
  nextRefreshAt: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ------------------------------------------------------------------ boot */

init().catch((err) => showBanner(`Could not start: ${err.message}`, 'error'));

async function init() {
  state.config = await fetchJson('/api/config');
  state.books = new Set(state.config.books.map((b) => b.key));
  $('#high-threshold').textContent = state.config.thresholds.highEdgePct;
  $('#bankroll').value = state.config.risk.bankroll;

  state.autoRefresh = state.config.autoRefreshMs > 0;
  $('#auto-refresh').checked = state.autoRefresh;

  renderModeBadge();
  renderBookFilters();
  wireControls();
  openEventStream();

  await refresh();
  // The server no longer fetches on boot, so an unseen sport has an empty
  // board until something asks. Opening it is that ask -- one call, one sport.
  await fetchIfNeverFetched();
  startTimers();
}

function renderModeBadge() {
  const badge = $('#mode-badge');
  const demo = state.config.mode === 'demo';
  badge.textContent = demo ? 'DEMO DATA' : 'LIVE';
  badge.className = `badge ${demo ? 'badge-demo' : 'badge-live'}`;
  badge.title = demo
    ? 'No ODDS_API_KEY set — lines are simulated. Add a key in .env for live odds.'
    : 'Live odds from The Odds API';
  if (demo) {
    showBanner(
      'Demo mode: these lines are simulated, not real markets. Add ODDS_API_KEY to .env and restart for live odds.',
      'warn',
    );
  }
}

function renderBookFilters() {
  const box = $('#book-filters');
  box.replaceChildren();
  for (const book of state.config.books) {
    const label = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = true;
    input.dataset.book = book.key;
    input.addEventListener('change', () => {
      if (input.checked) state.books.add(book.key);
      else state.books.delete(book.key);
      render();
    });
    label.append(input, el('span', null, book.title));
    if (book.sharp) label.append(el('span', 'book-tag sharp', 'sharp'));
    else if (book.public) label.append(el('span', 'book-tag public', 'public'));
    box.append(label);
  }
}

function wireControls() {
  document.querySelectorAll('[data-sport]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-sport]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      state.sport = btn.dataset.sport;
      refresh().then(fetchIfNeverFetched);
    });
  });

  document.querySelectorAll('[data-market]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) state.markets.add(box.dataset.market);
      else state.markets.delete(box.dataset.market);
      refresh();
    });
  });

  const edge = $('#min-edge');
  edge.addEventListener('input', () => {
    state.minEdge = Number(edge.value);
    $('#edge-value').textContent =
      state.minEdge <= MIN_EDGE_OFF ? 'any' : `${state.minEdge.toFixed(1)}%`;
    debounceRefresh();
  });

  $('#high-value-only').addEventListener('change', (e) => {
    state.highValueOnly = e.target.checked;
    refresh();
  });
  $('#live-only').addEventListener('change', (e) => {
    state.liveOnly = e.target.checked;
    refresh();
  });
  $('#auto-refresh').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    if (state.autoRefresh) scheduleNext();
    else renderRefreshHint();
  });
  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    refresh();
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    debounceRefresh();
  });

  $('#refresh').addEventListener('click', () => forceRefresh());
  $('#clear-parlay').addEventListener('click', () => {
    state.legs = [];
    saveLegs();
    render();
  });
  $('#use-suggested').addEventListener('click', () => {
    const quote = currentQuote();
    if (quote?.sizing?.stake > 0) {
      $('#stake').value = quote.sizing.stake;
      renderParlay();
    }
  });
  $('#stake').addEventListener('input', renderParlay);
  $('#bankroll').addEventListener('input', renderParlay);
  $('#copy-parlay').addEventListener('click', copySlip);
}

/* --------------------------------------------------------------- data */

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function queryString() {
  const params = new URLSearchParams({ sport: state.sport, sort: state.sort });
  if (state.markets.size) params.set('markets', [...state.markets].join(','));
  if (state.minEdge > MIN_EDGE_OFF) params.set('minEdge', String(state.minEdge));
  if (state.highValueOnly) params.set('highValueOnly', '1');
  if (state.liveOnly) params.set('liveOnly', '1');
  if (state.search.trim()) params.set('q', state.search.trim());
  return params.toString();
}

/** Re-read the server's cached board. Costs no upstream credits. */
/** Set when a refresh is asked for while one is already running. */
let refreshQueued = false;

async function refresh({ auto = false } = {}) {
  if (auto && isEditing()) {
    scheduleNext();
    return;
  }
  if (state.loading) {
    // Never drop the request: an estimate the user just committed would
    // otherwise sit un-rendered until the next poll a minute later.
    refreshQueued = true;
    return;
  }
  state.loading = true;
  try {
    state.view = await fetchJson(`/api/state?${queryString()}`);
    clearBanner();
    if (state.view.error) {
      showBanner(`${state.view.error.message}${state.view.stale ? ' — showing the last good data.' : ''}`, 'error');
    } else if (state.config.mode === 'demo') {
      renderModeBadge();
    }
    render();
    scheduleNext();
  } catch (err) {
    showBanner(`Could not load the board: ${err.message}`, 'error');
  } finally {
    state.loading = false;
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  }
}

/**
 * Fetch this sport once if it has never been fetched. Guarded by a per-sport
 * flag so a refusal (quota exhausted, bad key) is not retried on every render.
 */
async function fetchIfNeverFetched() {
  if (state.view?.fetchedAt) return;
  if (state.fetchAttempted.has(state.sport)) return;
  state.fetchAttempted.add(state.sport);
  await forceRefresh();
}

/** Ask the server to hit the upstream API now. This does spend credits. */
async function forceRefresh() {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    state.view = await fetchJson(`/api/refresh?${queryString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sport: state.sport }),
    });
    clearBanner();
    render();
    scheduleNext();
  } catch (err) {
    showBanner(err.message, 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
}

let debounceTimer = null;
function debounceRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refresh, 250);
}

function startTimers() {
  setInterval(() => {
    if (!state.autoRefresh) {
      renderRefreshHint();
      return;
    }
    if (!state.nextRefreshAt) return;
    const left = Math.max(0, state.nextRefreshAt - Date.now());
    $('#countdown').textContent = `next in ${Math.ceil(left / 1000)}s`;
    if (left === 0) refresh({ auto: true });
  }, 1000);
}

function scheduleNext() {
  if (!state.autoRefresh) {
    state.nextRefreshAt = null;
    return;
  }
  const interval = state.view?.uiRefreshMs || state.config.uiRefreshMs || 60_000;
  state.nextRefreshAt = Date.now() + interval;
}

/**
 * With auto-refresh off there is no countdown to show, so the slot says what
 * pressing Refresh will cost instead. A ticking clock next to a credit balance
 * reads like the clock is spending them; this says plainly that nothing is.
 */
function renderRefreshHint() {
  const quota = state.view?.quota;
  const el = $('#countdown');
  if (!quota?.configured) {
    el.textContent = 'manual · demo feed';
    el.title = 'Simulated data. Refresh costs nothing.';
    return;
  }
  const n = quota.creditCost;
  el.textContent = `manual · refresh costs ~${n} credit${n === 1 ? '' : 's'}`;
  el.title = 'Nothing is fetched on a timer. Only Refresh spends credits.';
}

/**
 * Server-sent events push alerts and completed upstream fetches straight to the
 * page, so a line move shows up without waiting for the next poll.
 */
function openEventStream() {
  const source = new EventSource('/api/events');
  source.addEventListener('alerts', (evt) => {
    const alerts = JSON.parse(evt.data);
    if (state.view) state.view.alerts = [...alerts, ...state.view.alerts].slice(0, 25);
    renderAlerts();
  });
  source.addEventListener('update', (evt) => {
    const info = JSON.parse(evt.data);
    if (info.sport === state.sport) refresh({ auto: true });
  });
  source.onerror = () => { /* EventSource reconnects on its own */ };
}

/* ------------------------------------------------------------- render */

function render() {
  renderBoard();
  renderAlerts();
  renderParlay();
  renderStatus();
}

/**
 * A refresh rebuilds the board, which would blow away whatever the user is
 * typing into a probability box. Auto-refreshes therefore wait; an explicit
 * refresh still goes through, because the user asked for it.
 */
function isEditing() {
  const active = document.activeElement;
  return Boolean(active && active.closest?.('.panel-center') && active.matches('input'));
}

function renderStatus() {
  const view = state.view;
  if (!view) return;
  $('#game-count').textContent = view.gameCount;
  $('#fetched-at').textContent = view.fetchedAt
    ? `updated ${timeAgo(view.fetchedAt)}${view.stale ? ' (stale)' : ''}`
    : '';

  if (!state.autoRefresh) renderRefreshHint();

  const q = view.quota;
  const quotaEl = $('#quota');
  if (!q?.configured) {
    quotaEl.textContent = 'demo feed';
    quotaEl.className = 'quota';
  } else if (q.remaining === null) {
    quotaEl.textContent = `${q.callsToday}/${q.dailyCallCap} calls today`;
    quotaEl.className = 'quota';
  } else {
    quotaEl.textContent = `${q.remaining} credits left · ${q.callsToday}/${q.dailyCallCap} calls today`;
    quotaEl.className = `quota ${q.remaining < q.quotaFloor * 3 ? 'critical' : q.remaining < 100 ? 'low' : ''}`;
    quotaEl.title = `Each refresh costs ~${q.creditCost} credits per sport`;
  }
}

function renderBoard() {
  const box = $('#games');
  // Remember which probability box had focus so rebuilding the board does not
  // yank the cursor out from under someone mid-edit.
  const focused = document.activeElement?.closest?.('.selection');
  const focusedKey = focused?.dataset.selKey;

  box.replaceChildren();
  const games = (state.view?.games || []).filter(gameHasVisibleBook);

  if (!games.length) {
    box.append(el('p', 'empty', emptyMessage()));
    return;
  }
  for (const game of games) box.append(renderGame(game));

  if (focusedKey) {
    const restored = box.querySelector(`.selection[data-sel-key="${CSS.escape(focusedKey)}"] .est-input`);
    if (restored) {
      restored.focus();
      try {
        // Number inputs reject selection APIs in some browsers; the focus alone
        // is the part that matters, so a rejection here is not worth surfacing.
        const end = restored.value.length;
        restored.setSelectionRange(end, end);
      } catch { /* not supported on this input type */ }
    }
  }
}

function emptyMessage() {
  if (state.highValueOnly) return `No selection currently clears the ${state.config.thresholds.highEdgePct}% edge threshold. Lower the filter or wait for the next refresh.`;
  if (state.minEdge > MIN_EDGE_OFF) return `No selection is above a ${state.minEdge.toFixed(1)}% edge right now.`;
  if (state.liveOnly) return 'No games are in progress right now.';
  if (state.search.trim()) return `Nothing matches “${state.search.trim()}”.`;
  return 'No games in the next 7 days for this sport.';
}

function gameHasVisibleBook(game) {
  return game.selections.some((s) => s.books.some((b) => state.books.has(b.book)));
}

function renderGame(game) {
  const card = el('div', 'game');

  const head = el('div', 'game-head');
  head.append(el('span', 'game-matchup', game.matchup));
  head.append(el('span', 'game-time', game.live ? 'IN PROGRESS' : formatKickoff(game.commenceTime)));

  const flags = el('div', 'game-flags');
  if (game.live) flags.append(el('span', 'flag flag-live', 'LIVE'));
  if (game.flags.includes('REVERSE_LINE_MOVE')) flags.append(flagChip('flag-rlm', 'SHARP MOVE', 'Line moved toward the underdog since first seen — the shape sharp money leaves. Not proof: public ticket counts are not in the free feed.'));
  else if (game.flags.includes('LINE_MOVE')) flags.append(flagChip('flag-move', `MOVED ${Math.abs(game.maxMovePoints ?? 0).toFixed(1)}`, 'A book moved this number by at least the alert threshold since first seen.'));
  if (game.flags.includes('SHARP_DIVERGENCE')) flags.append(flagChip('flag-sharp', 'SHARP/PUBLIC', 'A sharp book and a public book disagree by more than the threshold.'));
  if (game.flags.includes('INFLATED_FAVORITE')) flags.append(flagChip('flag-inflated', 'INFLATED FAV', 'A heavy favourite priced past the configured threshold — little room left on that side.'));
  if (game.flags.includes('HIGH_VALUE')) flags.append(flagChip('flag-value', `+${(game.bestEdgePct ?? 0).toFixed(1)}%`, 'Best available edge on this game.'));
  head.append(flags);
  card.append(head);

  let lastMarket = null;
  for (const sel of game.selections) {
    const visible = sel.books.filter((b) => state.books.has(b.book));
    if (!visible.length) continue;
    if (sel.market !== lastMarket) {
      card.append(el('div', 'market-label', marketLabel(sel.market)));
      lastMarket = sel.market;
    }
    card.append(renderSelection(game, sel, visible));
  }
  return card;
}

function flagChip(cls, text, title) {
  const chip = el('span', `flag ${cls}`, text);
  chip.title = title;
  return chip;
}

function renderSelection(game, sel, visibleBooks) {
  const row = el('div', 'selection');
  // Stable hooks for tests and for anyone scripting against the page.
  row.dataset.selKey = sel.selKey;
  row.dataset.market = sel.market;

  const head = el('div', 'sel-head');
  head.append(el('span', 'sel-name', sel.selection));
  if (sel.consensusPoint !== null && sel.market !== 'h2h') {
    head.append(el('span', 'sel-point', formatPoint(sel.consensusPoint, { signed: sel.market !== 'totals' })));
  }

  const fair = el('span', `sel-fair${sel.fairSource === 'user' ? ' user' : ''}${sel.fairApprox ? ' approx' : ''}`);
  // An "approx" prefix is added in CSS when the fair price leaned on a
  // half-point conversion, so the number never claims more precision than it has.
  fair.textContent = sel.fairProb !== null ? `fair ${(sel.fairProb * 100).toFixed(1)}%` : 'no fair price';
  fair.title = fairTooltip(sel);
  head.append(fair);
  row.append(head);

  const meta = el('div', 'sel-meta');
  const move = visibleBooks.map((b) => b.movement).find((m) => m?.movedPoints);
  if (move) {
    const up = (move.pointDelta ?? 0) > 0;
    const chunk = el('span', up ? 'move-up' : 'move-down',
      `${up ? '↑' : '↓'} ${Math.abs(move.pointDelta).toFixed(1)} pts vs ${formatPoint(move.openingPoint, { signed: sel.market !== 'totals' })} first seen`);
    chunk.title = `First seen ${formatKickoff(move.openedAt)} — this tool's own opener, not the book's.`;
    meta.append(chunk);
  }
  if (sel.divergence?.triggered) {
    const d = sel.divergence;
    const gap = d.unit === 'points' ? `${d.magnitude.toFixed(1)} pts` : `${Math.round(d.magnitude)} cents`;
    meta.append(el('span', 'diverge', `◆ ${d.sharpBookTitle} vs ${d.bookTitle}: ${gap}`));
  }
  const inflated = visibleBooks.find((b) => b.inflatedFavorite);
  if (inflated) {
    meta.append(el('span', null,
      `inflated favourite at ${inflated.bookTitle} (${formatAmerican(inflated.price)} = ${(inflated.impliedProb * 100).toFixed(1)}%)`));
  }
  if (meta.childNodes.length) row.append(meta);

  const books = el('div', 'books');
  for (const book of visibleBooks) books.append(renderBook(game, sel, book));
  row.append(books);

  row.append(renderEstimateControl(sel));
  return row;
}

function fairTooltip(sel) {
  if (sel.fairSource === 'user') return 'Your own estimate — overrides the market consensus.';
  const base = sel.fairSource?.startsWith('sharp:')
    ? `De-vigged consensus, anchored on ${sel.fairSource.split(':')[1]}.`
    : 'De-vigged consensus of the books quoting this selection.';
  return sel.fairApprox
    ? `${base} Some books quote a different number, so their contribution is a half-point approximation.`
    : base;
}

function renderBook(game, sel, book) {
  const node = el('div', `book tier-${book.tier}${isSharpBook(book.book) ? ' is-sharp' : ''}`);

  const name = el('span', 'book-name');
  name.textContent = book.bookTitle;
  if (isSharpBook(book.book)) {
    const mark = el('span', 'sharp-mark', ' ◆');
    mark.title = 'Sharp book';
    name.append(mark);
  }
  node.append(name);

  const priceText = sel.market === 'h2h' || book.point === null
    ? formatAmerican(book.price)
    : `${formatPoint(book.point, { signed: sel.market !== 'totals' })} ${formatAmerican(book.price)}`;
  node.append(el('span', 'book-price', priceText));

  const edge = el('span', `book-edge edge-${book.tier}`);
  edge.textContent = book.edgePct === null ? '—' : `${book.edgePct >= 0 ? '+' : ''}${book.edgePct.toFixed(1)}%`;
  edge.title = book.edgePct === null
    ? 'No independent fair price for this selection yet — only this book quotes it.'
    : [
      `Edge ${book.edgePct.toFixed(2)} pts of probability · EV ${book.evPct.toFixed(2)}% per unit staked`,
      `Implied ${(book.impliedProb * 100).toFixed(1)}% vs fair ${(book.fairProb * 100).toFixed(1)}%`,
      // Worth spelling out: this fair price is not the one in the row header.
      // A book cannot grade its own price, so its edge is measured against the
      // other books only -- which is why the two numbers differ.
      book.fairSource === 'user'
        ? 'Fair price is your own estimate.'
        : `Fair price from the other ${book.fairBookCount} book(s), excluding ${book.bookTitle}.`,
      book.fairApprox ? 'Includes a half-point conversion from a nearby number.' : null,
    ].filter(Boolean).join('\n');
  node.append(edge);

  const legId = `${book.key}|${book.point ?? ''}`;
  const added = state.legs.some((l) => l.id === legId);
  const add = el('button', `add-leg${added ? ' added' : ''}`, added ? '✓' : '+');
  add.title = added ? 'Remove from parlay' : 'Add to parlay';
  add.addEventListener('click', () => toggleLeg({ game, sel, book, legId }));
  node.append(add);

  return node;
}

function renderEstimateControl(sel) {
  const box = el('div', 'sel-actions');
  box.append(el('span', 'est-label', 'Your probability %'));

  const input = el('input', 'est-input');
  input.type = 'number';
  input.min = '1';
  input.max = '99';
  input.step = '0.5';
  input.placeholder = sel.fairProb !== null ? (sel.fairProb * 100).toFixed(1) : '';

  // A draft the user has typed but not committed outranks the stored value, so
  // a refresh landing mid-keystroke cannot swallow what they were entering.
  const draft = state.estimateDrafts.get(sel.selKey);
  if (draft !== undefined) input.value = draft;
  else if (sel.userEstimate !== null) input.value = (sel.userEstimate * 100).toFixed(1);

  input.title = 'Override the market consensus with your own number. Edge and EV recompute against it.';
  input.addEventListener('input', () => state.estimateDrafts.set(sel.selKey, input.value));
  input.addEventListener('change', async () => {
    const pct = Number(input.value);
    state.estimateDrafts.delete(sel.selKey);
    try {
      await fetchJson('/api/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selKey: sel.selKey,
          probability: input.value === '' ? null : pct / 100,
        }),
      });
      await refresh();
    } catch (err) {
      showBanner(err.message, 'warn');
    }
  });
  box.append(input);

  if (sel.userEstimate !== null) {
    const clear = el('button', 'est-clear', 'clear');
    clear.addEventListener('click', async () => {
      state.estimateDrafts.delete(sel.selKey);
      await fetchJson('/api/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selKey: sel.selKey, probability: null }),
      });
      refresh();
    });
    box.append(clear);
  }
  return box;
}

function isSharpBook(key) {
  return state.config.books.find((b) => b.key === key)?.sharp === true;
}

function renderAlerts() {
  const list = $('#alert-list');
  const alerts = state.view?.alerts || [];
  $('#alert-count').textContent = alerts.length;
  list.replaceChildren();

  if (!alerts.length) {
    list.append(el('li', 'empty', 'No alerts yet.'));
    return;
  }
  for (const alert of alerts.slice(0, 25)) {
    const fresh = !state.seenAlertIds.has(alert.id);
    state.seenAlertIds.add(alert.id);
    const item = el('li', `alert-item kind-${alert.kind}${fresh ? ' fresh' : ''}`);
    item.append(el('div', null, alert.message));
    item.append(el('div', 'alert-meta', `${alert.matchup} · ${timeAgo(alert.ts)}`));
    list.append(item);
  }
}

/* ------------------------------------------------------------- parlay */

function toggleLeg({ game, sel, book, legId }) {
  const existing = state.legs.findIndex((l) => l.id === legId);
  if (existing >= 0) state.legs.splice(existing, 1);
  else {
    state.legs.push({
      id: legId,
      gameId: game.id,
      matchup: game.matchup,
      market: sel.market,
      selection: sel.selection,
      point: book.point,
      price: book.price,
      book: book.book,
      bookTitle: book.bookTitle,
      estimatedProb: book.fairProb,
      edgePct: book.edgePct,
    });
  }
  saveLegs();
  render();
}

function currentQuote() {
  if (!state.legs.length) return null;
  return quoteParlay({
    legs: state.legs,
    stake: Number($('#stake').value) || 0,
    bankroll: Number($('#bankroll').value) || 0,
    kellyMultiplier: state.config.risk.kellyMultiplier,
    softCapPct: state.config.risk.softCapPct,
    hardCapPct: state.config.risk.hardCapPct,
  });
}

function renderParlay() {
  const list = $('#parlay-legs');
  list.replaceChildren();
  $('#leg-count').textContent = state.legs.length;

  $('#copy-parlay').disabled = state.legs.length === 0;

  if (!state.legs.length) {
    const empty = el('li', 'empty');
    empty.innerHTML = 'Click <b>+</b> on any price to add a leg.';
    list.append(empty);
    $('#parlay-stats').replaceChildren();
    // The sizing box carries its own border and background, so an emptied one
    // would sit there as a stray rectangle. Hide it rather than blank it.
    $('#sizing').replaceChildren();
    $('#sizing').hidden = true;
    $('#correlation-warning').hidden = true;
    resetCopyUi();
    return;
  }

  for (const leg of state.legs) {
    const item = el('li', 'leg');
    const body = el('div', 'leg-body');
    body.append(el('div', 'leg-title', leg.selection));
    const pointText = leg.point === null || leg.market === 'h2h'
      ? marketLabel(leg.market)
      : `${marketLabel(leg.market)} ${formatPoint(leg.point, { signed: leg.market !== 'totals' })}`;
    body.append(el('div', 'leg-sub', `${pointText} · ${leg.bookTitle} · ${leg.matchup}`));
    item.append(body);
    item.append(el('span', 'leg-price', formatAmerican(leg.price)));

    const remove = el('button', 'leg-remove', '×');
    remove.title = 'Remove leg';
    remove.addEventListener('click', () => {
      state.legs = state.legs.filter((l) => l.id !== leg.id);
      saveLegs();
      render();
    });
    item.append(remove);
    list.append(item);
  }

  const quote = currentQuote();
  renderParlayStats(quote);
  $('#sizing').hidden = false;
  renderSizing(quote);

  const warn = $('#correlation-warning');
  if (quote.correlatedGameIds.length) {
    warn.hidden = false;
    warn.textContent =
      'Two or more legs are from the same game. The payout maths below assumes independent legs, '
      + 'so it will overstate a correlated parlay — and most books void these unless offered as a same-game parlay.';
  } else {
    warn.hidden = true;
  }
}

function renderParlayStats(q) {
  const stats = $('#parlay-stats');
  stats.replaceChildren();

  const row = (label, value, cls) => {
    stats.append(el('dt', null, label));
    stats.append(el('dd', cls, value));
  };
  const sep = () => stats.append(el('div', 'row-sep'));

  row('Legs', String(q.legCount));
  row('Parlay odds', formatAmerican(q.american));
  row('Multiplier', `${q.decimal.toFixed(3)}×`);
  sep();
  row('Stake', money(q.stake));
  row('Payout', money(q.payout));
  row('Profit', money(q.profit), 'pos');
  sep();
  row('Break-even win rate', pct(q.requiredWinRate));
  row('Required accuracy / leg', pct(q.requiredAccuracyPerLeg));
  row('Your estimated win rate', pct(q.estimatedProb),
    q.estimatedProb > q.requiredWinRate ? 'pos' : 'neg');
  sep();
  row('Expected value', `${q.evPerUnit >= 0 ? '+' : ''}${(q.evPerUnit * 100).toFixed(2)}%`,
    q.evPerUnit >= 0 ? 'pos' : 'neg');
  row('EV on this stake', money(q.evOnStake), q.evOnStake >= 0 ? 'pos' : 'neg');
}

function renderSizing(q) {
  const box = $('#sizing');
  box.replaceChildren();
  const s = q.sizing;

  const head = el('div', 'sizing-head');
  head.append(el('span', null, 'Suggested stake'));
  head.append(el('span', `sizing-amount${s.stake > 0 ? '' : ' zero'}`, money(s.stake)));
  box.append(head);

  let note;
  if (s.reason === 'no-edge') {
    note = 'No edge at these prices — your estimated win rate is below the break-even rate, so Kelly says stake nothing.';
  } else if (s.reason === 'capped-at-hard-limit') {
    note = `Quarter-Kelly wants ${(s.kelly * s.kellyMultiplier * 100).toFixed(1)}% of bankroll; `
      + `capped at the ${(s.hardCapPct * 100).toFixed(0)}% hard limit. Parlay estimates are noisy — the cap is the point.`;
  } else {
    note = `${(s.kellyMultiplier * 100).toFixed(0)}% of full Kelly `
      + `(full Kelly would be ${(s.kelly * 100).toFixed(1)}% of bankroll) = `
      + `${(s.fraction * 100).toFixed(2)}% of bankroll.`;
    if (s.overSoftCap) note += ` Above the ${(s.softCapPct * 100).toFixed(0)}% soft limit — size down if the estimates are shaky.`;
  }
  box.append(el('div', 'sizing-note', note));
}

/**
 * Plain-text rendering of the slip, for taking to whichever book you actually
 * bet at. This tool deliberately does not place bets -- no sportsbook exposes a
 * public bet-placement API, and a button that pretended to would be a lie -- so
 * handing you the slip is the honest terminal action.
 */
function slipText(quote) {
  const lines = [];
  const stamp = new Date().toLocaleString();

  lines.push(`PARLAY - ${quote.legCount} leg${quote.legCount === 1 ? '' : 's'} - `
    + `${formatAmerican(quote.american)} (${quote.decimal.toFixed(3)}x)`);
  lines.push('');

  state.legs.forEach((leg, i) => {
    const line = leg.point === null || leg.market === 'h2h'
      ? marketLabel(leg.market)
      : `${marketLabel(leg.market)} ${formatPoint(leg.point, { signed: leg.market !== 'totals' })}`;
    lines.push(`${i + 1}. ${leg.selection} - ${line} ${formatAmerican(leg.price)} at ${leg.bookTitle}`);
    lines.push(`   ${leg.matchup}`);
  });

  lines.push('');
  lines.push(`Stake ${money(quote.stake)} -> payout ${money(quote.payout)} (profit ${money(quote.profit)})`);
  lines.push(`Break-even win rate ${pct(quote.requiredWinRate)} `
    + `| required accuracy per leg ${pct(quote.requiredAccuracyPerLeg)}`);
  lines.push(`Your estimated win rate ${pct(quote.estimatedProb)} `
    + `| EV ${quote.evPerUnit >= 0 ? '+' : ''}${(quote.evPerUnit * 100).toFixed(2)}% (${money(quote.evOnStake)})`);
  lines.push(`Suggested stake ${money(quote.sizing.stake)} `
    + `(${(quote.sizing.kellyMultiplier ?? 0.25) * 100}% Kelly, capped at `
    + `${((quote.sizing.hardCapPct ?? 0.05) * 100).toFixed(0)}% of bankroll)`);

  if (quote.correlatedGameIds.length) {
    lines.push('');
    lines.push('WARNING: legs share a game. The payout maths above assumes independent');
    lines.push('legs, so it overstates this parlay, and many books void such tickets.');
  }

  lines.push('');
  lines.push(`Generated ${stamp} by Line Value Research${state.config.mode === 'demo' ? ' (DEMO DATA - simulated lines)' : ''}.`);
  lines.push('Research only. No bet was placed and nothing here is advice.');

  return lines.join('\n');
}

/**
 * Put the copy controls back to their resting state. Clearing the text alone is
 * not enough: the status paragraph keeps its `warn` class, and selecting the
 * fallback textarea leaves a selection range that the browser goes on painting
 * after the textarea is hidden.
 */
function resetCopyUi() {
  const status = $('#copy-status');
  status.textContent = '';
  status.className = 'copy-status';

  const fallback = $('#copy-fallback');
  if (!fallback.hidden) {
    fallback.hidden = true;
    fallback.open = false;
    window.getSelection()?.removeAllRanges();
  }
  clearTimeout(copySlip.timer);
}

async function copySlip() {
  const quote = currentQuote();
  if (!quote || quote.legCount === 0) return;

  const text = slipText(quote);
  const status = $('#copy-status');
  const fallback = $('#copy-fallback');
  $('#copy-text').value = text;

  try {
    // Only available on secure origins, which localhost counts as -- but a page
    // served over plain http from another host will land in the catch below.
    await navigator.clipboard.writeText(text);
    status.className = 'copy-status';
    status.textContent = `Copied ${quote.legCount}-leg slip to the clipboard.`;
    fallback.hidden = true;
  } catch {
    status.className = 'copy-status warn';
    status.textContent = 'Clipboard unavailable here — the slip is below, ready to select.';
    fallback.hidden = false;
    fallback.open = true;
    $('#copy-text').select();
  }

  clearTimeout(copySlip.timer);
  copySlip.timer = setTimeout(resetCopyUi, 6000);
}

/* --------------------------------------------------------- utilities */

function marketLabel(market) {
  return { spreads: 'Spread', totals: 'Total', h2h: 'Moneyline' }[market] || market;
}

function money(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function pct(p) {
  return typeof p === 'number' && Number.isFinite(p) ? `${(p * 100).toFixed(1)}%` : '—';
}

function formatKickoff(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function showBanner(message, kind = 'error') {
  const banner = $('#banner');
  banner.textContent = message;
  banner.className = `banner ${kind === 'error' ? '' : kind}`;
  banner.hidden = false;
}

function clearBanner() {
  if (state.config?.mode === 'demo') return; // the demo notice is permanent
  $('#banner').hidden = true;
}

function loadLegs() {
  try {
    return JSON.parse(localStorage.getItem('lvr.legs') || '[]');
  } catch {
    return [];
  }
}

function saveLegs() {
  try {
    localStorage.setItem('lvr.legs', JSON.stringify(state.legs));
  } catch { /* private browsing — the slip just will not persist */ }
}

export { state };
