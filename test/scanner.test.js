import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LineHistory } from '../src/lib/history.js';
import { AlertLog, buildAlerts, ALERT_KINDS } from '../src/lib/alerts.js';
import { OddsApiClient, QuotaError, OddsApiError } from '../src/lib/oddsApi.js';
import { DemoFeed } from '../src/lib/demoFeed.js';
import { Scanner } from '../src/scanner.js';
import { config, loadEnv } from '../src/config.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lvr-')), name);

const offer = (over = {}) => ({
  key: 'g1|spreads|pinnacle|Chiefs',
  gameId: 'g1',
  market: 'spreads',
  selection: 'Chiefs',
  book: 'pinnacle',
  bookTitle: 'Pinnacle',
  point: -3,
  price: -110,
  ...over,
});

/* ------------------------------------------------------------- history */

test('the first sample of a line becomes its opening', () => {
  const history = new LineHistory({ file: tmp('h.json') });
  assert.deepEqual(history.record([offer()]), [], 'a brand new line is not a change');

  const entry = history.get(offer().key);
  assert.equal(entry.opening.point, -3);
  assert.equal(entry.samples.length, 1);
});

test('history reports changes and leaves the opening alone', () => {
  const history = new LineHistory({ file: tmp('h.json') });
  history.record([offer()]);
  const changes = history.record([offer({ point: -3.5, price: -115 })]);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].pointDelta, -0.5);
  assert.equal(changes[0].priceDelta, -5);
  assert.equal(history.get(offer().key).opening.point, -3, 'the opening never moves');
  assert.equal(history.get(offer().key).latest.point, -3.5);
});

test('an unchanged line is not reported as a change', () => {
  const history = new LineHistory({ file: tmp('h.json') });
  history.record([offer()]);
  assert.equal(history.record([offer()]).length, 0);
  assert.equal(history.get(offer().key).samples.length, 1);
});

test('history persists across instances so openings survive a restart', () => {
  const file = tmp('h.json');
  const first = new LineHistory({ file });
  first.record([offer()]);
  first.record([offer({ point: -4 })]);
  assert.equal(first.save(), true);

  const reopened = new LineHistory({ file });
  assert.equal(reopened.get(offer().key).opening.point, -3);
  assert.equal(reopened.get(offer().key).latest.point, -4);
});

test('a corrupt history file does not stop the scanner starting', () => {
  const file = tmp('h.json');
  fs.writeFileSync(file, '{ not json at all');
  const history = new LineHistory({ file });
  assert.equal(history.size(), 0);
});

test('sample depth is bounded', () => {
  const history = new LineHistory({ file: tmp('h.json'), depth: 3 });
  for (let i = 0; i < 10; i += 1) history.record([offer({ point: -3 - i * 0.5 })]);
  assert.equal(history.get(offer().key).samples.length, 3);
});

test('pruning drops lines whose game has left the feed', () => {
  const history = new LineHistory({ file: tmp('h.json') });
  history.record([offer(), offer({ key: 'g2|spreads|pinnacle|Jets', gameId: 'g2' })]);
  assert.equal(history.prune(['g1']), 1);
  assert.equal(history.size(), 1);
});

/* --------------------------------------------------------- .env loading */

test('a .env file saved by a Windows editor still yields its key', () => {
  const file = tmp('.env');
  // UTF-8 BOM, CRLF endings, a comment and a blank line -- what Notepad writes.
  fs.writeFileSync(file, '\uFEFF# my key\r\nODDS_API_KEY=abc123\r\n\r\nPORT=4000\r\n', 'utf8');

  const parsed = loadEnv(file);
  assert.equal(parsed.ODDS_API_KEY, 'abc123', 'the BOM must not become part of the first key');
  assert.equal(parsed.PORT, '4000');
  assert.equal(Object.keys(parsed).includes('# my key'), false, 'comments are skipped');
});

test('quoted values and stray whitespace are handled', () => {
  const file = tmp('.env');
  fs.writeFileSync(file, 'A="quoted"\nB=  spaced  \nC=\n', 'utf8');
  const parsed = loadEnv(file);
  assert.equal(parsed.A, 'quoted');
  assert.equal(parsed.B, 'spaced');
  assert.equal(parsed.C, '');
});

/* -------------------------------------------------------------- alerts */

test('the alert log de-duplicates by signature inside the window', () => {
  const log = new AlertLog({ depth: 5 });
  assert.ok(log.push({ signature: 'a', message: 'first' }));
  assert.equal(log.push({ signature: 'a', message: 'again' }), null);
  assert.ok(log.push({ signature: 'b', message: 'other' }));
  assert.equal(log.list().length, 2);
  assert.equal(log.list()[0].message, 'other', 'newest first');
});

test('the alert log is a bounded ring buffer', () => {
  const log = new AlertLog({ depth: 3 });
  for (let i = 0; i < 10; i += 1) log.push({ signature: `s${i}`, message: `m${i}` });
  assert.equal(log.list(50).length, 3);
});

test('a half-point move raises a line-move alert and a smaller one does not', () => {
  const games = [{ id: 'g1', sport: 'nfl', matchup: 'Bills @ Chiefs', selections: [] }];
  const change = {
    key: 'k', offer: offer(), previous: { point: -3 }, current: { point: -3.5 },
    opening: { point: -3, ts: '2026-09-05T00:00:00.000Z' }, pointDelta: -0.5, priceDelta: 0,
  };

  const fired = buildAlerts({ changes: [change], games });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].kind, ALERT_KINDS.LINE_MOVE);
  assert.match(fired[0].message, /moved/);

  const tiny = buildAlerts({ changes: [{ ...change, pointDelta: -0.25 }], games });
  assert.equal(tiny.length, 0);
});

test('value closing and opening are both announced', () => {
  const selection = {
    selKey: 'g1|spreads|Chiefs', market: 'spreads', selection: 'Chiefs',
    bestEdgePct: 0.2, divergence: null,
    best: { price: -110, bookTitle: 'DraftKings', book: 'draftkings' },
  };
  const games = [{ id: 'g1', sport: 'nfl', matchup: 'Bills @ Chiefs', selections: [selection] }];

  const closed = buildAlerts({
    changes: [], games,
    previousBySelection: new Map([[selection.selKey, { ...selection, bestEdgePct: 3.4 }]]),
  });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].kind, ALERT_KINDS.VALUE_CLOSED);
  assert.match(closed[0].message, /Value closed/);

  const opened = buildAlerts({
    changes: [],
    games: [{ ...games[0], selections: [{ ...selection, bestEdgePct: 3.4 }] }],
    previousBySelection: new Map([[selection.selKey, selection]]),
  });
  assert.equal(opened[0].kind, ALERT_KINDS.VALUE_OPENED);
});

test('a newly seen selection does not fire a value-opened alert', () => {
  const selection = {
    selKey: 'new', market: 'spreads', selection: 'Chiefs', bestEdgePct: 5, divergence: null,
    best: { price: -110, bookTitle: 'DraftKings', book: 'draftkings' },
  };
  const alerts = buildAlerts({
    changes: [],
    games: [{ id: 'g1', sport: 'nfl', matchup: 'Bills @ Chiefs', selections: [selection] }],
    previousBySelection: new Map(),
  });
  assert.equal(alerts.length, 0, 'the first sighting is not a change');
});

/* ------------------------------------------------------------ api client */

test('quota headers are read off every response', async () => {
  const client = new OddsApiClient({
    apiKey: 'k',
    fetchImpl: async () => new Response('[]', {
      status: 200,
      headers: { 'x-requests-remaining': '412', 'x-requests-used': '88', 'x-requests-last': '3' },
    }),
  });

  await client.fetchOdds('nfl');
  const snap = client.snapshot();
  assert.equal(snap.remaining, 412);
  assert.equal(snap.used, 88);
  assert.equal(snap.lastCost, 3);
  assert.equal(snap.callsToday, 1);
});

test('the request carries the documented v4 parameters', async () => {
  let seen;
  const client = new OddsApiClient({
    apiKey: 'secret',
    fetchImpl: async (url) => { seen = new URL(url); return new Response('[]', { status: 200 }); },
  });
  await client.fetchOdds('ncaaf');

  assert.match(seen.pathname, /\/sports\/americanfootball_ncaaf\/odds$/);
  assert.equal(seen.searchParams.get('apiKey'), 'secret');
  assert.equal(seen.searchParams.get('regions'), config.regions);
  assert.equal(seen.searchParams.get('oddsFormat'), 'american');
  assert.deepEqual(seen.searchParams.get('markets').split(',').sort(), [...config.markets].sort());
});

test('http failures become messages a user can act on', async () => {
  const make = (status, body = '') => new OddsApiClient({
    apiKey: 'k', fetchImpl: async () => new Response(body, { status }),
  });

  await assert.rejects(() => make(401).fetchOdds('nfl'), (err) => {
    assert.ok(err instanceof OddsApiError);
    assert.match(err.message, /ODDS_API_KEY/);
    return true;
  });
  await assert.rejects(() => make(429).fetchOdds('nfl'), /quota exhausted/);
  await assert.rejects(() => make(422, 'bad market').fetchOdds('nfl'), /markets\/regions\/bookmakers/);
  await assert.rejects(() => make(503).fetchOdds('nfl'), /having problems/);
});

test('the quota floor blocks calls before they are made', async () => {
  let calls = 0;
  const client = new OddsApiClient({
    apiKey: 'k',
    fetchImpl: async () => {
      calls += 1;
      return new Response('[]', { status: 200, headers: { 'x-requests-remaining': '5' } });
    },
  });

  await client.fetchOdds('nfl');
  assert.equal(calls, 1);
  assert.match(client.blockedReason(), /Quota floor/);
  await assert.rejects(() => client.fetchOdds('nfl'), QuotaError);
  assert.equal(calls, 1, 'no second request was made');
});

test('a missing key blocks every call', async () => {
  const client = new OddsApiClient({ apiKey: '' });
  assert.equal(client.configured, false);
  assert.match(client.blockedReason(), /No ODDS_API_KEY/);
  await assert.rejects(() => client.fetchOdds('nfl'), QuotaError);
});

/* ---------------------------------------------------------- demo feed */

test('the demo feed emits the API shape for both sports', () => {
  const feed = new DemoFeed({ seed: 1 });
  for (const sport of ['nfl', 'ncaaf']) {
    const games = feed.fetchOdds(sport);
    assert.ok(games.length > 0);
    for (const game of games) {
      assert.ok(game.id && game.home_team && game.away_team && game.commence_time);
      assert.ok(game.bookmakers.length > 0);
      for (const bm of game.bookmakers) {
        for (const market of bm.markets) {
          assert.ok(['spreads', 'totals', 'h2h'].includes(market.key));
          for (const out of market.outcomes) {
            assert.equal(typeof out.price, 'number');
            assert.ok(out.price <= -100 || out.price >= 100, `impossible price ${out.price}`);
          }
        }
      }
    }
  }
});

test('the demo feed is deterministic for a given seed', () => {
  // Kickoff and last_update are derived from the wall clock, so compare the
  // odds themselves rather than the timestamps around them.
  const priceShape = (games) => games.map((g) => [
    g.id,
    g.bookmakers.map((b) => [b.key, b.markets.map((m) => [m.key, m.outcomes])]),
  ]);

  const a = new DemoFeed({ seed: 7 });
  const b = new DemoFeed({ seed: 7 });
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(priceShape(a.fetchOdds('nfl')), priceShape(b.fetchOdds('nfl')));
    a.advance();
    b.advance();
  }
});

test('demo lines actually drift, so movement detection has something to find', () => {
  // Books only take a step when the feed is polled, which is how the scanner
  // uses it: advance the world, then observe it.
  const feed = new DemoFeed({ seed: 3 });
  const pointOf = (games, book) => games[0].bookmakers.find((b) => b.key === book)
    ?.markets.find((m) => m.key === 'spreads').outcomes[0].point;

  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    seen.add(pointOf(feed.fetchOdds('nfl'), 'draftkings'));
    feed.advance();
  }
  assert.ok(seen.size > 1, `the line never moved across 20 polls: ${[...seen]}`);
});

/* ------------------------------------------------------------- scanner */

async function demoScanner() {
  const scanner = new Scanner({ history: new LineHistory({ file: tmp('h.json') }) });
  scanner.demo = true;
  return scanner;
}

test('a scan produces analysed games for both sports', async () => {
  const scanner = await demoScanner();
  for (const sport of ['nfl', 'ncaaf']) {
    const snapshot = await scanner.refresh(sport, { force: true });
    assert.ok(snapshot.games.length > 0);
    assert.equal(snapshot.error, null);
    for (const game of snapshot.games) {
      assert.ok(game.selections.length > 0);
      assert.ok(game.matchup.includes('@'));
    }
  }
});

test('the cache is served until the fetch interval expires', async () => {
  const scanner = await demoScanner();
  const first = await scanner.refresh('nfl');
  const second = await scanner.refresh('nfl');
  assert.equal(first.fetchedAt, second.fetchedAt, 'no second upstream call inside the window');

  const forced = await scanner.refresh('nfl', { force: true });
  assert.notEqual(forced.fetchedAt, first.fetchedAt);
});

test('concurrent refreshes share one in-flight request', async () => {
  const scanner = await demoScanner();
  const [a, b] = await Promise.all([
    scanner.refresh('nfl', { force: true }),
    scanner.refresh('nfl', { force: true }),
  ]);
  assert.equal(a.fetchedAt, b.fetchedAt);
});

test('filters narrow the board and drop emptied games', async () => {
  const scanner = await demoScanner();
  await scanner.refresh('nfl', { force: true });

  const all = scanner.view({ sport: 'nfl' });
  assert.ok(all.gameCount > 0);

  const spreadsOnly = scanner.view({ sport: 'nfl', markets: ['spreads'] });
  for (const game of spreadsOnly.games) {
    for (const sel of game.selections) assert.equal(sel.market, 'spreads');
  }

  const impossible = scanner.view({ sport: 'nfl', minEdgePct: 500 });
  assert.equal(impossible.gameCount, 0);
  assert.equal(impossible.totalGames, all.totalGames, 'the underlying board is untouched');

  const searched = scanner.view({ sport: 'nfl', search: 'chiefs' });
  assert.ok(searched.games.every((g) => g.matchup.toLowerCase().includes('chiefs')));
});

test('sorting orders the board as the control promises', async () => {
  const scanner = await demoScanner();
  for (let i = 0; i < 6; i += 1) {
    scanner.lastFetchAt.clear();
    await scanner.refresh('nfl', { force: true });
  }

  const byEdge = scanner.view({ sport: 'nfl', sort: 'edge' }).games.map((g) => g.bestEdgePct ?? -Infinity);
  for (let i = 1; i < byEdge.length; i += 1) assert.ok(byEdge[i - 1] >= byEdge[i]);

  const byTime = scanner.view({ sport: 'nfl', sort: 'time' }).games.map((g) => Date.parse(g.commenceTime));
  for (let i = 1; i < byTime.length; i += 1) assert.ok(byTime[i - 1] <= byTime[i]);

  const byMove = scanner.view({ sport: 'nfl', sort: 'movement' }).games.map((g) => Math.abs(g.maxMovePoints ?? 0));
  for (let i = 1; i < byMove.length; i += 1) assert.ok(byMove[i - 1] >= byMove[i]);
});

test('repeated scans generate line-movement alerts', async () => {
  const scanner = await demoScanner();
  for (let i = 0; i < 10; i += 1) {
    scanner.lastFetchAt.clear();
    await scanner.refresh('nfl', { force: true });
  }
  const alerts = scanner.alerts.list(50);
  assert.ok(alerts.length > 0, 'drifting demo lines must produce alerts');
  assert.ok(alerts.some((a) => a.kind === ALERT_KINDS.LINE_MOVE));
  for (const alert of alerts) {
    assert.ok(alert.message && alert.matchup && alert.ts);
  }
});

test('user estimates are validated and flow into the board', async () => {
  const scanner = await demoScanner();
  await scanner.refresh('nfl', { force: true });
  const sel = scanner.view({ sport: 'nfl' }).games[0].selections[0];

  scanner.setEstimate(sel.selKey, 0.62);
  await scanner.refresh('nfl', { force: true });
  const updated = scanner.view({ sport: 'nfl' }).games
    .flatMap((g) => g.selections).find((s) => s.selKey === sel.selKey);
  assert.equal(updated.userEstimate, 0.62);
  assert.equal(updated.fairSource, 'user');

  assert.throws(() => scanner.setEstimate(sel.selKey, 1.5), /between 0 and 1/);
  assert.throws(() => scanner.setEstimate(sel.selKey, 0), /between 0 and 1/);
  assert.equal(scanner.setEstimate(sel.selKey, null), null);
});

test('an estimate re-grades the board immediately, with no new upstream call', async () => {
  const scanner = await demoScanner();
  await scanner.refresh('nfl', { force: true });

  const before = scanner.view({ sport: 'nfl' });
  const target = before.games[0].selections[0];
  assert.notEqual(target.fairSource, 'user');
  const { fetchedAt } = before;

  scanner.setEstimate(target.selKey, 0.62);

  // No refresh() call in between: the board must already reflect the estimate.
  const after = scanner.view({ sport: 'nfl' });
  const updated = after.games.flatMap((g) => g.selections).find((s) => s.selKey === target.selKey);
  assert.equal(updated.fairProb, 0.62);
  assert.equal(updated.fairSource, 'user');
  assert.equal(updated.userEstimate, 0.62);
  assert.equal(after.fetchedAt, fetchedAt, 're-grading must not trigger a fetch');

  scanner.setEstimate(target.selKey, null);
  const cleared = scanner.view({ sport: 'nfl' })
    .games.flatMap((g) => g.selections).find((s) => s.selKey === target.selKey);
  assert.equal(cleared.userEstimate, null);
  assert.notEqual(cleared.fairSource, 'user');
});

test('re-grading does not add history samples or alerts', async () => {
  const scanner = await demoScanner();
  await scanner.refresh('nfl', { force: true });
  const historyBefore = scanner.history.size();
  const alertsBefore = scanner.alerts.list(100).length;

  const target = scanner.view({ sport: 'nfl' }).games[0].selections[0];
  scanner.setEstimate(target.selKey, 0.7);

  assert.equal(scanner.history.size(), historyBefore);
  assert.equal(scanner.alerts.list(100).length, alertsBefore);
});

test('an upstream failure serves the last good board instead of blanking', async () => {
  const scanner = new Scanner({
    history: new LineHistory({ file: tmp('h.json') }),
    client: new OddsApiClient({
      apiKey: 'k',
      fetchImpl: async () => new Response('[]', { status: 500 }),
    }),
  });
  scanner.demo = true;
  await scanner.refresh('nfl', { force: true });
  const good = scanner.view({ sport: 'nfl' });
  assert.ok(good.gameCount > 0);

  scanner.demo = false;
  await scanner.refresh('nfl', { force: true });
  const degraded = scanner.view({ sport: 'nfl' });
  assert.equal(degraded.gameCount, good.gameCount, 'the previous board is still shown');
  assert.equal(degraded.stale, true);
  assert.match(degraded.error.message, /having problems/);
});

test('an unknown sport is rejected', async () => {
  const scanner = await demoScanner();
  await assert.rejects(() => scanner.refresh('cricket'), /Unknown sport/);
});
