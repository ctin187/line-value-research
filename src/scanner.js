/**
 * The scanner: owns the current view of the world.
 *
 * Responsibilities, in order:
 *   1. pull odds (live API or demo feed) no more often than the fetch interval,
 *   2. normalise them and record every line into history,
 *   3. run the value engine over each game,
 *   4. diff against the previous scan to raise alerts,
 *   5. serve filtered/sorted views of the result.
 *
 * Everything the HTTP layer needs is a method on this class, so the server stays
 * a thin translation of HTTP into these calls.
 */
import { EventEmitter } from 'node:events';
import { config, SPORTS } from './config.js';
import { normalizeFeed } from './lib/normalize.js';
import { analyzeGame } from './lib/value.js';
import { LineHistory } from './lib/history.js';
import { AlertLog, buildAlerts } from './lib/alerts.js';
import { OddsApiClient, QuotaError } from './lib/oddsApi.js';
import { DemoFeed } from './lib/demoFeed.js';

export class Scanner extends EventEmitter {
  constructor({ client, demoFeed, history, alerts } = {}) {
    super();
    this.demo = config.demo || !config.apiKey;
    this.client = client || new OddsApiClient();
    this.demoFeed = demoFeed || new DemoFeed();
    this.history = history || new LineHistory();
    this.alerts = alerts || new AlertLog();

    /** sport slug -> { games, offers, fetchedAt, source, error } */
    this.snapshots = new Map();
    /** selKey -> previous selection, for alert diffing. */
    this.previousBySelection = new Map();
    /** selKey -> user probability estimate (0..1). */
    this.userEstimates = new Map();

    this.lastFetchAt = new Map();
    this.inFlight = new Map();
    this.timer = null;
  }

  get mode() {
    return this.demo ? 'demo' : 'live';
  }

  /** True when this sport's cached snapshot is younger than the fetch interval. */
  isFresh(sport) {
    const last = this.lastFetchAt.get(sport);
    return Boolean(last && Date.now() - last < config.fetchIntervalMs);
  }

  /**
   * Refresh one sport. Returns the snapshot.
   *
   * `force` skips the fetch-interval check but never the quota guard -- a user
   * mashing refresh should not be able to spend a month of credits in a minute.
   * Concurrent calls for the same sport share one in-flight request.
   */
  async refresh(sport, { force = false } = {}) {
    if (!SPORTS[sport]) throw new Error(`Unknown sport '${sport}'`);
    if (!force && this.isFresh(sport) && this.snapshots.has(sport)) {
      return this.snapshots.get(sport);
    }
    if (this.inFlight.has(sport)) return this.inFlight.get(sport);

    const task = this.#doRefresh(sport).finally(() => this.inFlight.delete(sport));
    this.inFlight.set(sport, task);
    return task;
  }

  async #doRefresh(sport) {
    let raw;
    let source = this.mode;
    let error = null;

    try {
      if (this.demo) {
        this.demoFeed.advance();
        raw = this.demoFeed.fetchOdds(sport);
      } else {
        raw = await this.client.fetchOdds(sport);
      }
    } catch (err) {
      error = err instanceof QuotaError ? { kind: 'quota', message: err.message } : { kind: 'api', message: err.message };
      const previous = this.snapshots.get(sport);
      if (previous) {
        // Serve the last good data rather than blanking the screen; the UI shows
        // the error banner and the age of what it is displaying.
        const stale = { ...previous, error, stale: true };
        this.snapshots.set(sport, stale);
        this.emit('update', stale);
        return stale;
      }
      const empty = { sport, games: [], offers: [], fetchedAt: new Date().toISOString(), source, error, stale: false };
      this.snapshots.set(sport, empty);
      this.emit('update', empty);
      return empty;
    }

    this.lastFetchAt.set(sport, Date.now());
    const fetchedAt = new Date().toISOString();

    const { games: rawGames, offers } = normalizeFeed(raw, {
      books: config.books,
      markets: config.markets,
    });

    const horizon = Date.now() + config.lookaheadDays * 86_400_000;
    const gamesInWindow = rawGames.filter((g) => {
      const t = Date.parse(g.commenceTime);
      return Number.isFinite(t) ? t <= horizon : true;
    });
    const keep = new Set(gamesInWindow.map((g) => g.id));
    const offersInWindow = offers.filter((o) => keep.has(o.gameId));

    const changes = this.history.record(offersInWindow, fetchedAt);

    const analyzed = this.#analyze(gamesInWindow, offersInWindow);

    const newAlerts = buildAlerts({
      changes,
      games: analyzed,
      previousBySelection: this.previousBySelection,
    });

    const emitted = [];
    for (const alert of newAlerts) {
      const stored = this.alerts.push(alert);
      if (stored) emitted.push(stored);
    }

    for (const game of analyzed) {
      for (const sel of game.selections) this.previousBySelection.set(sel.selKey, sel);
    }

    this.history.save();

    const snapshot = {
      sport,
      games: analyzed,
      // The raw inputs are kept so the board can be re-analysed after an
      // estimate changes without spending another upstream credit.
      rawGames: gamesInWindow,
      offers: offersInWindow,
      offerCount: offersInWindow.length,
      fetchedAt,
      source,
      error: null,
      stale: false,
      changeCount: changes.length,
    };
    this.snapshots.set(sport, snapshot);

    this.emit('update', snapshot);
    if (emitted.length) this.emit('alerts', emitted);
    return snapshot;
  }

  /** Run the value engine over a set of games and their offers. */
  #analyze(games, offers) {
    const byGame = new Map();
    for (const offer of offers) {
      if (!byGame.has(offer.gameId)) byGame.set(offer.gameId, []);
      byGame.get(offer.gameId).push(offer);
    }

    return games
      .map((game) =>
        analyzeGame({
          game,
          offers: byGame.get(game.id) || [],
          history: this.history,
          userEstimates: this.userEstimates,
        }),
      )
      .map((game) => ({ ...game, live: Date.parse(game.commenceTime) <= Date.now() }))
      .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));
  }

  /**
   * Re-grade the stored board against the current estimates. Costs nothing --
   * no upstream call, no new history samples, no alerts -- and is what makes an
   * estimate the user just typed show up immediately instead of at the next scan.
   */
  reanalyze(sport = null) {
    const sports = sport ? [sport] : [...this.snapshots.keys()];
    for (const key of sports) {
      const snapshot = this.snapshots.get(key);
      if (!snapshot?.rawGames) continue;
      const games = this.#analyze(snapshot.rawGames, snapshot.offers);
      this.snapshots.set(key, { ...snapshot, games });
      for (const game of games) {
        for (const sel of game.selections) this.previousBySelection.set(sel.selKey, sel);
      }
    }
    return this;
  }

  /** Refresh every sport, sequentially so quota is spent predictably. */
  async refreshAll(opts) {
    const results = [];
    for (const sport of Object.keys(SPORTS)) {
      results.push(await this.refresh(sport, opts));
    }
    return results;
  }

  /**
   * Begin background polling, if any is configured.
   *
   * Deliberately does NOT fetch on boot. Starting the app is not the same as
   * asking for fresh odds -- restarting it a few times while setting things up
   * should not quietly cost a chunk of a monthly allowance. The first fetch for
   * a sport happens when the board is actually opened or Refresh is pressed.
   *
   * With `autoRefreshMs` at its default of 0 no timer is created at all, so the
   * scanner only ever calls upstream because someone asked it to.
   */
  start() {
    this.stop();
    if (config.autoRefreshMs > 0) {
      this.timer = setInterval(() => {
        this.refreshAll().catch((err) => this.emit('error', err));
      }, config.autoRefreshMs);
      this.timer.unref?.();
    }
    return this;
  }

  /** True when the scanner is polling on a schedule rather than on demand. */
  get autoRefreshing() {
    return config.autoRefreshMs > 0;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Record (or clear, with null) your own probability for a selection, then
   * re-grade the board so the change is visible straight away.
   */
  setEstimate(selKey, probability) {
    if (probability === null || probability === undefined) {
      this.userEstimates.delete(selKey);
      this.reanalyze();
      return null;
    }
    const p = Number(probability);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) {
      throw new Error('Estimate must be a probability strictly between 0 and 1');
    }
    this.userEstimates.set(selKey, p);
    this.reanalyze();
    return p;
  }

  estimates() {
    return Object.fromEntries(this.userEstimates);
  }

  /**
   * The filtered, sorted view the UI renders.
   *
   * Filtering happens at the selection level and games with nothing left are
   * dropped, so "high value only" genuinely reduces the board instead of leaving
   * empty cards behind.
   */
  view({
    sport = 'nfl',
    markets = null,
    minEdgePct = null,
    highValueOnly = false,
    sort = 'edge',
    books = null,
    liveOnly = false,
    search = '',
  } = {}) {
    const snapshot = this.snapshots.get(sport) || { sport, games: [], fetchedAt: null, source: this.mode };
    const threshold = highValueOnly
      ? Math.max(config.thresholds.highEdgePct, minEdgePct ?? -Infinity)
      : minEdgePct;
    const needle = search.trim().toLowerCase();

    const games = snapshot.games
      .filter((g) => (liveOnly ? g.live : true))
      .filter((g) => (needle ? g.matchup.toLowerCase().includes(needle) : true))
      .map((game) => {
        let selections = game.selections;
        if (markets?.length) selections = selections.filter((s) => markets.includes(s.market));
        if (books?.length) {
          selections = selections
            .map((s) => ({ ...s, books: s.books.filter((b) => books.includes(b.book)) }))
            .filter((s) => s.books.length);
        }
        if (Number.isFinite(threshold)) {
          selections = selections.filter((s) => (s.bestEdgePct ?? -Infinity) >= threshold);
        }
        return {
          ...game,
          selections,
          bestEdgePct: max(selections.map((s) => s.bestEdgePct)),
          maxMovePoints: maxAbs(selections.map((s) => s.maxMovePoints)),
          maxDivergence: max(selections.map((s) => (s.divergence?.triggered ? s.divergence.normalized : null))),
        };
      })
      .filter((g) => g.selections.length > 0);

    sortGames(games, sort);

    return {
      sport,
      mode: this.mode,
      games,
      gameCount: games.length,
      totalGames: snapshot.games.length,
      fetchedAt: snapshot.fetchedAt,
      stale: Boolean(snapshot.stale),
      error: snapshot.error || null,
      quota: this.client.snapshot(),
      thresholds: config.thresholds,
      risk: config.risk,
      uiRefreshMs: config.uiRefreshMs,
      autoRefreshMs: config.autoRefreshMs,
      fetchIntervalMs: config.fetchIntervalMs,
      nextFetchInMs: Math.max(0, config.fetchIntervalMs - (Date.now() - (this.lastFetchAt.get(sport) || 0))),
      alerts: this.alerts.list(25),
      estimates: this.estimates(),
    };
  }
}

/** Sort orders offered in the UI's "Sort by" control. */
function sortGames(games, sort) {
  const cmp = {
    edge: (a, b) => (b.bestEdgePct ?? -Infinity) - (a.bestEdgePct ?? -Infinity),
    movement: (a, b) => Math.abs(b.maxMovePoints ?? 0) - Math.abs(a.maxMovePoints ?? 0),
    divergence: (a, b) => (b.maxDivergence ?? -Infinity) - (a.maxDivergence ?? -Infinity),
    time: (a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime),
  }[sort];
  games.sort(cmp || ((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime)));
  return games;
}

function max(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return usable.length ? Math.max(...usable) : null;
}

function maxAbs(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!usable.length) return null;
  return usable.reduce((acc, v) => (Math.abs(v) > Math.abs(acc) ? v : acc), 0);
}
