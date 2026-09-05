/**
 * Offline demo feed.
 *
 * Emits data in exactly The Odds API's response shape, so the entire pipeline --
 * normalisation, de-vigging, flagging, alerting -- runs identically whether the
 * source is the live API or this. It exists for three reasons: the app should be
 * usable before the user has a key, the value engine needs deterministic input
 * to test against, and burning free-tier credits on development is wasteful.
 *
 * Lines drift a little on every tick, so line-movement detection and the alert
 * feed have something real to chew on.
 */
import { config, bookTitle } from '../config.js';
import { americanToImplied, probToAmerican } from '../../shared/odds.js';

/** Deterministic PRNG so a given seed always replays the same session. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NFL_GAMES = [
  { away: 'Buffalo Bills', home: 'Kansas City Chiefs', spread: -2.5, total: 47.5, inHours: 3 },
  { away: 'Dallas Cowboys', home: 'Philadelphia Eagles', spread: -6.5, total: 44.5, inHours: 27 },
  { away: 'San Francisco 49ers', home: 'Seattle Seahawks', spread: 3, total: 42.5, inHours: 30 },
  { away: 'Green Bay Packers', home: 'Chicago Bears', spread: -3, total: 40.5, inHours: 51 },
  { away: 'Miami Dolphins', home: 'New York Jets', spread: -1.5, total: 39.5, inHours: 75 },
  { away: 'Baltimore Ravens', home: 'Cincinnati Bengals', spread: -1, total: 49.5, inHours: 99 },
  { away: 'Detroit Lions', home: 'Minnesota Vikings', spread: -7.5, total: 51.5, inHours: 123 },
];

const NCAAF_GAMES = [
  { away: 'Alabama Crimson Tide', home: 'Georgia Bulldogs', spread: -4.5, total: 52.5, inHours: 5 },
  { away: 'Michigan Wolverines', home: 'Ohio State Buckeyes', spread: -7, total: 45.5, inHours: 28 },
  { away: 'Texas Longhorns', home: 'Oklahoma Sooners', spread: -10.5, total: 58.5, inHours: 29 },
  { away: 'LSU Tigers', home: 'Ole Miss Rebels', spread: 2.5, total: 61.5, inHours: 53 },
  { away: 'Oregon Ducks', home: 'Washington Huskies', spread: -3.5, total: 55.5, inHours: 54 },
  { away: 'Notre Dame Fighting Irish', home: 'USC Trojans', spread: -1.5, total: 56.5, inHours: 77 },
  { away: 'Penn State Nittany Lions', home: 'Wisconsin Badgers', spread: -13.5, total: 43.5, inHours: 101 },
];

/**
 * How each book behaves, relative to the "true" line.
 *
 * `pointBias` shades the number, `vig` sets the hold, and `lag` is the fraction
 * of a drift step the book has NOT yet absorbed -- that lag is what creates the
 * stale public prices the value engine is supposed to catch.
 */
const BOOK_BEHAVIOUR = {
  pinnacle: { pointBias: 0, vig: 0.021, lag: 0 },
  draftkings: { pointBias: 0.15, vig: 0.045, lag: 0.55 },
  fanduel: { pointBias: -0.1, vig: 0.047, lag: 0.6 },
  betmgm: { pointBias: 0.2, vig: 0.048, lag: 0.75 },
  williamhill_us: { pointBias: -0.2, vig: 0.046, lag: 0.8 },
  espnbet: { pointBias: 0.25, vig: 0.05, lag: 0.85 },
};

export class DemoFeed {
  constructor({ seed = 20260905, books = config.books } = {}) {
    this.rand = mulberry32(seed);
    this.books = books.filter((b) => BOOK_BEHAVIOUR[b]).length
      ? books.filter((b) => BOOK_BEHAVIOUR[b])
      : Object.keys(BOOK_BEHAVIOUR);
    this.tick = 0;
    this.state = new Map();
    for (const [slug, defs] of [['nfl', NFL_GAMES], ['ncaaf', NCAAF_GAMES]]) {
      defs.forEach((def, idx) => {
        this.state.set(`${slug}-${idx}`, {
          ...def,
          id: `demo-${slug}-${idx}`,
          sportKey: slug === 'nfl' ? 'americanfootball_nfl' : 'americanfootball_ncaaf',
          sportTitle: slug === 'nfl' ? 'NFL' : 'NCAAF',
          slug,
          trueSpread: def.spread,
          trueTotal: def.total,
          // Where each book currently sits, filled in lazily on the first tick.
          shown: new Map(),
        });
      });
    }
  }

  /**
   * Advance the simulation. Each tick nudges the true line, and books converge
   * toward it at their own speed, which keeps a rolling supply of stale prices.
   */
  advance() {
    this.tick += 1;
    for (const g of this.state.values()) {
      if (this.rand() < 0.35) g.trueSpread = round05(g.trueSpread + pick(this.rand, [-0.5, 0.5]));
      if (this.rand() < 0.3) g.trueTotal = round05(g.trueTotal + pick(this.rand, [-0.5, 0.5]));
    }
  }

  /** Raw API-shaped payload for one sport slug. */
  fetchOdds(sportSlug) {
    const now = Date.now();
    const games = [];

    for (const g of this.state.values()) {
      if (g.slug !== sportSlug) continue;
      const commence = new Date(now + g.inHours * 3600_000).toISOString();

      const bookmakers = this.books.map((bookKey) => {
        const behaviour = BOOK_BEHAVIOUR[bookKey];
        const prev = g.shown.get(bookKey);

        // Converge on the true line at (1 - lag) per tick, then shade it.
        const targetSpread = g.trueSpread + behaviour.pointBias;
        const targetTotal = g.trueTotal + behaviour.pointBias;
        const spread = prev
          ? round05(prev.spread + (targetSpread - prev.spread) * (1 - behaviour.lag))
          : round05(targetSpread);
        const total = prev
          ? round05(prev.total + (targetTotal - prev.total) * (1 - behaviour.lag))
          : round05(targetTotal);
        g.shown.set(bookKey, { spread, total });

        const lastUpdate = new Date(now - Math.floor(this.rand() * 90_000)).toISOString();

        return {
          key: bookKey,
          title: bookTitle(bookKey),
          last_update: lastUpdate,
          markets: [
            {
              key: 'spreads',
              last_update: lastUpdate,
              outcomes: [
                { name: g.home, price: pricedAt(0.5, behaviour.vig, this.rand), point: spread },
                { name: g.away, price: pricedAt(0.5, behaviour.vig, this.rand), point: -spread },
              ],
            },
            {
              key: 'totals',
              last_update: lastUpdate,
              outcomes: [
                { name: 'Over', price: pricedAt(0.5, behaviour.vig, this.rand), point: total },
                { name: 'Under', price: pricedAt(0.5, behaviour.vig, this.rand), point: total },
              ],
            },
            {
              key: 'h2h',
              last_update: lastUpdate,
              outcomes: [
                { name: g.home, price: moneyline(spread, behaviour.vig) },
                { name: g.away, price: moneyline(-spread, behaviour.vig) },
              ],
            },
          ].filter((m) => config.markets.includes(m.key)),
        };
      });

      games.push({
        id: g.id,
        sport_key: g.sportKey,
        sport_title: g.sportTitle,
        commence_time: commence,
        home_team: g.home,
        away_team: g.away,
        bookmakers,
      });
    }

    return games;
  }
}

/** A price for a ~50/50 side at a given hold, jittered a couple of cents. */
function pricedAt(trueProb, vig, rand) {
  const jitter = (rand() - 0.5) * 0.02;
  const booked = clamp(trueProb + jitter, 0.05, 0.95) * (1 + vig);
  return roundPrice(probToAmerican(clamp(booked, 0.02, 0.97)));
}

/**
 * Moneyline implied by a spread, using the usual football rule of thumb of
 * roughly 2.5 points of spread per standard deviation-ish step, then loaded with
 * the book's hold.
 */
function moneyline(spread, vig) {
  const winProb = clamp(0.5 - spread * 0.032, 0.03, 0.97);
  return roundPrice(probToAmerican(clamp(winProb * (1 + vig), 0.02, 0.985)));
}

/** Books quote in 5-cent increments, and never inside +/-100. */
function roundPrice(price) {
  if (price === null) return -110;
  const rounded = Math.round(price / 5) * 5;
  if (rounded > -100 && rounded < 100) return rounded >= 0 ? 100 : -100;
  return rounded;
}

function round05(n) {
  return Math.round(n * 2) / 2;
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export { americanToImplied };
