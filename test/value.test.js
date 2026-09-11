import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGame, normalizeFeed, lineKey } from '../src/lib/normalize.js';
import {
  analyzeGame, fairProbAtBook, consensusFairProb, sharpDivergence,
  inflatedFavorite, gradeOffer, lineMovement, FLAGS,
} from '../src/lib/value.js';
import { shiftProbability, shiftDirection } from '../src/lib/lineAdjust.js';
import { americanToImplied } from '../shared/odds.js';

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);

/** Build an API-shaped game so tests exercise the real normalisation path. */
function makeGame({ id = 'g1', home = 'Chiefs', away = 'Bills', books = [] } = {}) {
  return {
    id,
    sport_key: 'americanfootball_nfl',
    sport_title: 'NFL',
    commence_time: new Date(Date.now() + 3 * 3600_000).toISOString(),
    home_team: home,
    away_team: away,
    bookmakers: books.map(({ key, spread, spreadPrices = [-110, -110], ml, total, totalPrices = [-110, -110] }) => ({
      key,
      title: key,
      last_update: new Date().toISOString(),
      markets: [
        ...(spread === undefined ? [] : [{
          key: 'spreads',
          outcomes: [
            { name: home, price: spreadPrices[0], point: spread },
            { name: away, price: spreadPrices[1], point: -spread },
          ],
        }]),
        ...(total === undefined ? [] : [{
          key: 'totals',
          outcomes: [
            { name: 'Over', price: totalPrices[0], point: total },
            { name: 'Under', price: totalPrices[1], point: total },
          ],
        }]),
        ...(ml === undefined ? [] : [{
          key: 'h2h',
          outcomes: [
            { name: home, price: ml[0] },
            { name: away, price: ml[1] },
          ],
        }]),
      ],
    })),
  };
}

test('normalisation flattens the API shape into offers', () => {
  const { game, offers } = normalizeGame(makeGame({
    books: [{ key: 'pinnacle', spread: -3, ml: [-150, 130], total: 45.5 }],
  }));

  assert.equal(game.matchup, 'Bills @ Chiefs');
  assert.equal(game.sport, 'nfl');
  assert.equal(offers.length, 6);

  const homeSpread = offers.find((o) => o.market === 'spreads' && o.selection === 'Chiefs');
  assert.equal(homeSpread.point, -3);
  assert.equal(homeSpread.side, 'home');
  assert.equal(homeSpread.book, 'pinnacle');

  const over = offers.find((o) => o.selection === 'Over');
  assert.equal(over.side, 'over');
  assert.equal(over.point, 45.5);
});

test('normalisation drops malformed rows rather than throwing', () => {
  const broken = makeGame({ books: [{ key: 'pinnacle', spread: -3 }] });
  broken.bookmakers[0].markets[0].outcomes.push({ name: 'Ghost' });
  broken.bookmakers[0].markets.push({ key: 'player_props', outcomes: [{ name: 'X', price: -110 }] });

  const { offers } = normalizeGame(broken, { markets: ['spreads', 'totals', 'h2h'] });
  assert.equal(offers.length, 2);
  assert.equal(normalizeGame({ id: 'x' }), null);
  assert.deepEqual(normalizeFeed(null).games, []);
});

test('lineKey ignores the point so a moving line keeps its identity', () => {
  const a = lineKey({ gameId: 'g1', market: 'spreads', book: 'pinnacle', selection: 'Chiefs' });
  const b = lineKey({ gameId: 'g1', market: 'spreads', book: 'pinnacle', selection: 'Chiefs' });
  assert.equal(a, b);
});

test('a book fair price is its own two-way market de-vigged', () => {
  const { game, offers } = normalizeGame(makeGame({
    books: [{ key: 'pinnacle', spread: -3, spreadPrices: [-115, -105] }],
  }));
  const home = offers.find((o) => o.selection === 'Chiefs' && o.market === 'spreads');
  const fair = fairProbAtBook(home, offers, game);

  const sum = americanToImplied(-115) + americanToImplied(-105);
  close(fair, americanToImplied(-115) / sum);
  assert.ok(fair < americanToImplied(-115), 'de-vigging must lower the booked probability');
});

test('a one-sided market has no fair price', () => {
  const { game, offers } = normalizeGame(makeGame({ books: [{ key: 'pinnacle', spread: -3 }] }));
  const orphan = offers.filter((o) => o.selection === 'Chiefs' && o.market === 'spreads');
  assert.equal(fairProbAtBook(orphan[0], orphan, game), null);
});

test('consensus excludes the book being graded so it cannot grade itself', () => {
  const { game, offers } = normalizeGame(makeGame({
    books: [
      { key: 'pinnacle', spread: -3, spreadPrices: [-105, -115] },
      { key: 'draftkings', spread: -3, spreadPrices: [-125, 105] },
    ],
  }));

  const withDk = consensusFairProb({
    offers, game, market: 'spreads', selection: 'Chiefs', point: -3, excludeBook: 'draftkings',
  });
  assert.equal(withDk.contributors.length, 1);
  assert.equal(withDk.contributors[0].book, 'pinnacle');
  assert.equal(withDk.source, 'sharp:pinnacle');
});

test('a book on a different number contributes only as an approximation', () => {
  const { game, offers } = normalizeGame(makeGame({
    books: [
      { key: 'pinnacle', spread: -2.5 },
      { key: 'draftkings', spread: -3 },
    ],
  }));

  const at3 = consensusFairProb({
    offers, game, market: 'spreads', selection: 'Chiefs', point: -3, excludeBook: 'draftkings',
  });
  assert.equal(at3.approx, true);
  // Moving a favourite from -2.5 to -3 must reduce its win probability.
  assert.ok(at3.prob < 0.5, `${at3.prob} should be below the -2.5 fair price of 0.5`);
});

test('half-point adjustment charges key numbers more than ordinary ones', () => {
  const overKeyThree = 0.55 - shiftProbability({
    prob: 0.55, market: 'spreads', fromPoint: -3, toPoint: -3.5,
    direction: shiftDirection({ market: 'spreads', side: 'home', fromPoint: -3, toPoint: -3.5 }),
  });
  const overOrdinary = 0.55 - shiftProbability({
    prob: 0.55, market: 'spreads', fromPoint: -1, toPoint: -1.5,
    direction: shiftDirection({ market: 'spreads', side: 'home', fromPoint: -1, toPoint: -1.5 }),
  });
  assert.ok(overKeyThree > overOrdinary * 2, 'crossing 3 costs much more than crossing 1');

  // A higher total helps the Under and hurts the Over.
  assert.equal(shiftDirection({ market: 'totals', side: 'under', fromPoint: 45, toPoint: 45.5 }), 1);
  assert.equal(shiftDirection({ market: 'totals', side: 'over', fromPoint: 45, toPoint: 45.5 }), -1);

  // Beyond a couple of points the linear rule of thumb is refused, not guessed.
  assert.equal(shiftProbability({ prob: 0.5, market: 'spreads', fromPoint: 0, toPoint: 7, direction: 1 }), null);
});

test('sharp/public divergence fires past the threshold and not before', () => {
  const near = normalizeGame(makeGame({
    books: [{ key: 'pinnacle', spread: -3 }, { key: 'draftkings', spread: -3.5 }],
  }));
  const halfPoint = sharpDivergence({ offers: near.offers, market: 'spreads', selection: 'Chiefs' });
  close(halfPoint.magnitude, 0.5);
  assert.equal(halfPoint.triggered, false, 'exactly 0.5 is not "more than 0.5"');

  const wide = normalizeGame(makeGame({
    books: [{ key: 'pinnacle', spread: -3 }, { key: 'draftkings', spread: -4.5 }],
  }));
  const gap = sharpDivergence({ offers: wide.offers, market: 'spreads', selection: 'Chiefs' });
  close(gap.magnitude, 1.5);
  assert.equal(gap.triggered, true);
  assert.equal(gap.sharpBook, 'pinnacle');
  assert.equal(gap.book, 'draftkings');
  assert.equal(gap.unit, 'points');
});

test('moneyline divergence is measured in cents, not points', () => {
  const { offers } = normalizeGame(makeGame({
    books: [{ key: 'pinnacle', ml: [-150, 130] }, { key: 'draftkings', ml: [-180, 155] }],
  }));
  const gap = sharpDivergence({ offers, market: 'h2h', selection: 'Chiefs' });
  assert.equal(gap.unit, 'cents');
  close(gap.magnitude, 30);
  assert.equal(gap.triggered, true);
});

test('divergence needs both a sharp and a public book to exist', () => {
  const { offers } = normalizeGame(makeGame({
    books: [{ key: 'draftkings', spread: -3 }, { key: 'fanduel', spread: -6 }],
  }));
  assert.equal(sharpDivergence({ offers, market: 'spreads', selection: 'Chiefs' }), null);
});

test('inflated favourite needs both the price and the probability floor', () => {
  // -120 alone implies only 54.5%, well under the 70% floor.
  assert.equal(inflatedFavorite({ price: -120 }), null);
  assert.equal(inflatedFavorite({ price: -200 }), null, '66.7% is still under the floor');

  const flagged = inflatedFavorite({ price: -300 });
  assert.ok(flagged, '-300 implies 75%');
  close(flagged.impliedProb, 0.75);

  assert.equal(inflatedFavorite({ price: 250 }), null, 'underdogs are never inflated favourites');
});

test('grading tiers follow the configured edge thresholds', () => {
  const offer = { price: -110, point: -3, market: 'spreads', book: 'draftkings' };
  assert.equal(gradeOffer(offer, americanToImplied(-110) + 0.03).tier, 'high');
  assert.equal(gradeOffer(offer, americanToImplied(-110) + 0.015).tier, 'moderate');
  assert.equal(gradeOffer(offer, americanToImplied(-110) + 0.005).tier, 'low');
  assert.equal(gradeOffer(offer, americanToImplied(-110) - 0.01).tier, 'negative');
  assert.equal(gradeOffer(offer, null).tier, 'none');
});

test('line movement is measured against the first snapshot seen', () => {
  const offer = { key: 'k', price: -110, point: -2.5, market: 'spreads' };
  const history = new Map([['k', {
    opening: { point: -3.5, price: -110, ts: '2026-09-05T00:00:00.000Z' },
    samples: [{}, {}],
  }]]);

  const move = lineMovement(offer, history);
  close(move.pointDelta, 1);
  assert.equal(move.movedPoints, true);
  assert.equal(move.towardUnderdog, true, 'a favourite shrinking is a move toward the dog');
  assert.equal(move.steamAgainstFavorite, true);
  assert.equal(move.openingPoint, -3.5);

  assert.equal(lineMovement(offer, new Map()), null);
  const small = lineMovement({ ...offer, point: -3.25 }, history);
  assert.equal(small.movedPoints, false, '0.25 is below the 0.5 threshold');
});

test('analyzeGame produces graded selections and the right flags', () => {
  const raw = makeGame({
    books: [
      { key: 'pinnacle', spread: -3, spreadPrices: [-105, -115], ml: [-300, 250], total: 45.5 },
      { key: 'draftkings', spread: -3, spreadPrices: [-125, 105], ml: [-320, 260], total: 45.5 },
      { key: 'fanduel', spread: -4.5, spreadPrices: [-110, -110], ml: [-330, 270], total: 47.5 },
    ],
  });
  const { game, offers } = normalizeGame(raw);
  const analyzed = analyzeGame({ game, offers, history: new Map() });

  assert.ok(analyzed.selections.length > 0);
  const homeSpread = analyzed.selections.find((s) => s.market === 'spreads' && s.selection === 'Chiefs');

  assert.equal(homeSpread.consensusPoint, -3, 'two books on -3 outvote one on -4.5');
  assert.ok(homeSpread.books.length === 3);
  assert.ok(homeSpread.best, 'a best price is always chosen');
  assert.ok(homeSpread.fairProb > 0 && homeSpread.fairProb < 1);

  // FanDuel is 1.5 points off Pinnacle, which is past the divergence threshold.
  assert.equal(homeSpread.divergence.triggered, true);
  assert.ok(homeSpread.flags.includes(FLAGS.SHARP_DIVERGENCE));

  // -300/-320/-330 are all past the inflated-favourite test on the moneyline.
  const ml = analyzed.selections.find((s) => s.market === 'h2h' && s.selection === 'Chiefs');
  assert.ok(ml.flags.includes(FLAGS.INFLATED_FAVORITE));

  // The best price is genuinely the best available: Pinnacle -105 beats DK -125.
  assert.equal(homeSpread.best.book, 'pinnacle');
});

test('in-play, a book that has not repriced is dropped from the consensus', () => {
  const now = Date.now();
  const fresh = new Date(now).toISOString();
  const stale = new Date(now - 10 * 60_000).toISOString();

  const raw = makeGame({
    books: [
      { key: 'draftkings', ml: [-250, 198] },
      { key: 'fanduel', ml: [-260, 205] },
      { key: 'pinnacle', ml: [135, -160] },  // still on a pre-score number
    ],
  });
  // Pinnacle has not updated since before the last score.
  raw.bookmakers.forEach((bm) => {
    const when = bm.key === 'pinnacle' ? stale : fresh;
    bm.last_update = when;
    bm.markets.forEach((m) => { m.last_update = when; });
  });

  const { game, offers } = normalizeGame(raw);
  const away = game.away;

  const pregame = consensusFairProb({ offers, game, market: 'h2h', selection: away, live: false });
  const inplay = consensusFairProb({ offers, game, market: 'h2h', selection: away, live: true });

  assert.equal(pregame.staleExcluded, 0, 'pre-game, an old timestamp is just an unmoved line');
  assert.equal(inplay.staleExcluded, 1, 'in-play, the lagging book is dropped');
  assert.equal(inplay.bookCount, 2);

  // The stale book carries triple weight, so leaving it in inflates the
  // consensus badly -- that is the whole bug this guards against.
  assert.ok(pregame.prob - inplay.prob > 0.1,
    `stale book inflated the fair price by ${((pregame.prob - inplay.prob) * 100).toFixed(1)} pts`);
  assert.ok(inplay.prob < 0.35, `in-play consensus should sit near the live market, got ${inplay.prob}`);
});

test('a quote with no timestamp is not trusted in-play', () => {
  const raw = makeGame({
    books: [{ key: 'draftkings', ml: [-250, 198] }, { key: 'pinnacle', ml: [135, -160] }],
  });
  raw.bookmakers[0].last_update = new Date().toISOString();
  raw.bookmakers[0].markets.forEach((m) => { m.last_update = raw.bookmakers[0].last_update; });
  raw.bookmakers[1].last_update = null;
  raw.bookmakers[1].markets.forEach((m) => { m.last_update = null; });

  const { game, offers } = normalizeGame(raw);
  const inplay = consensusFairProb({ offers, game, market: 'h2h', selection: game.away, live: true });
  assert.equal(inplay.staleExcluded, 1, 'no timestamp means no way to know it is current');
});

test('a lagging book can no longer manufacture a positive edge', () => {
  const now = Date.now();
  const raw = makeGame({
    books: [{ key: 'draftkings', ml: [-250, 198] }, { key: 'pinnacle', ml: [135, -160] }],
  });
  raw.bookmakers.forEach((bm, i) => {
    const when = new Date(now - (i === 0 ? 0 : 10 * 60_000)).toISOString();
    bm.last_update = when;
    bm.markets.forEach((m) => { m.last_update = when; });
  });

  const { game, offers } = normalizeGame(raw);
  const analyzed = analyzeGame({ game, offers, history: new Map(), live: true });
  const sel = analyzed.selections.find((x) => x.market === 'h2h' && x.selection === game.away);
  const fresh = sel.books.find((b) => b.book === 'draftkings');
  const lagging = sel.books.find((b) => b.book === 'pinnacle');

  assert.equal(sel.live, true);
  // Only one fresh book survives, and it may not grade its own price, so there
  // is no headline fair number. Saying nothing is the honest answer.
  assert.equal(sel.fairProb, null);
  assert.equal(fresh.edgePct, null, 'the fresh price has no independent reference left');

  // The lagging book is still graded -- against the fresh one -- and comes out
  // as the bad price it is. This is the case that used to run backwards and
  // report the fresh price as huge value.
  assert.ok(lagging.edgePct < 0, `lagging price should grade badly, got ${lagging.edgePct}`);
  assert.ok((sel.bestEdgePct ?? -1) < 0, 'no positive edge is reported anywhere');
});

test('a user estimate overrides the market consensus', () => {
  const { game, offers } = normalizeGame(makeGame({
    books: [{ key: 'pinnacle', spread: -3 }, { key: 'draftkings', spread: -3 }],
  }));
  const selKey = `${game.id}|spreads|Chiefs`;
  const analyzed = analyzeGame({
    game, offers, history: new Map(), userEstimates: new Map([[selKey, 0.6]]),
  });

  const sel = analyzed.selections.find((s) => s.selKey === selKey);
  close(sel.fairProb, 0.6);
  assert.equal(sel.fairSource, 'user');
  // 60% against a -110 price (52.4% implied) is a 7.6-point edge.
  close(sel.bestEdgePct, (0.6 - americanToImplied(-110)) * 100, 1e-6);
  assert.ok(sel.flags.includes(FLAGS.HIGH_VALUE));
});

test('a game with a single book yields no fair price rather than a fake edge', () => {
  const { game, offers } = normalizeGame(makeGame({ books: [{ key: 'draftkings', spread: -3 }] }));
  const analyzed = analyzeGame({ game, offers, history: new Map() });
  for (const sel of analyzed.selections) {
    assert.equal(sel.fairProb, null);
    assert.equal(sel.bestEdgePct, null);
  }
});
