/**
 * Configuration: .env loading plus every tunable threshold the value engine and
 * the scanner use. Anything a user might reasonably want to change lives here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env reader. Node's own --env-file only landed in recent releases and
 * the flag name changed between them, so we parse it ourselves and stay
 * compatible with Node 20+. Real environment variables always win.
 */
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return {};
  const parsed = {};
  // Notepad and friends often save UTF-8 with a byte-order mark. Left in place
  // it makes the first key literally "\uFEFFODDS_API_KEY", so the app reports
  // no key while the user is looking straight at one. Strip it, and tolerate
  // Windows CRLF line endings while we are here.
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

loadEnv();

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const list = (v, fallback) =>
  v && String(v).trim() ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : fallback;

/** The two sports this tool scans, keyed by The Odds API sport key. */
export const SPORTS = {
  nfl: { key: 'americanfootball_nfl', label: 'NFL' },
  ncaaf: { key: 'americanfootball_ncaaf', label: 'College Football' },
};

/** Markets, in the order the UI shows them. */
export const MARKETS = {
  spreads: { key: 'spreads', label: 'Spreads' },
  totals: { key: 'totals', label: 'Totals (O/U)' },
  h2h: { key: 'h2h', label: 'Moneyline' },
};

/**
 * Book classification. "Sharp" books move first and price tighter, so their
 * de-vigged number is the best free proxy for true probability. "Public" books
 * take recreational money and can sit on a stale or shaded line.
 */
export const SHARP_BOOKS = ['pinnacle', 'lowvig', 'betonlineag', 'circasports'];
export const PUBLIC_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'espnbet'];

export const BOOK_TITLES = {
  pinnacle: 'Pinnacle',
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  betmgm: 'BetMGM',
  williamhill_us: 'Caesars',
  espnbet: 'ESPN BET',
  lowvig: 'LowVig',
  betonlineag: 'BetOnline',
  circasports: 'Circa',
};

export const config = {
  demo: bool(process.env.DEMO_MODE, false) || process.argv.includes('--demo'),
  apiKey: process.env.ODDS_API_KEY || '',
  apiBase: process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',

  regions: process.env.ODDS_REGIONS || 'us',
  markets: list(process.env.ODDS_MARKETS, ['spreads', 'totals', 'h2h']),
  oddsFormat: 'american',
  /** Only surface games kicking off inside this window. */
  lookaheadDays: num(process.env.LOOKAHEAD_DAYS, 7),
  /** Books shown in the grid, best price first. */
  books: list(process.env.BOOKMAKERS, [
    'draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'pinnacle',
  ]),

  /**
   * Refreshing, and what it costs.
   *
   * `autoRefreshMs` is the ONLY setting that spends credits without you asking.
   * It defaults to 0, meaning off: the scanner never polls on a timer, and every
   * upstream call comes from an explicit Refresh. On a ~500 credit/month free
   * plan that is the difference between paying while you read the board and
   * paying only when you ask for new numbers. Set it (say 900000 for 15 minutes)
   * if your plan can afford a schedule.
   *
   * `uiRefreshMs` is how often the browser re-reads the server's already-fetched
   * board. It costs nothing, and is skipped entirely while auto-refresh is off,
   * because with no background fetching there is nothing new to pick up.
   *
   * `fetchIntervalMs` is a floor, not a schedule: how long a fetched board is
   * served from cache before an unforced refresh is allowed to go upstream. The
   * Refresh button forces past it (the quota guards still apply).
   */
  autoRefreshMs: num(process.env.AUTO_REFRESH_MS, 0),
  uiRefreshMs: num(process.env.UI_REFRESH_MS, 60_000),
  fetchIntervalMs: num(process.env.FETCH_INTERVAL_MS, 300_000),
  /** Refuse to spend upstream credits once the remaining balance drops here. */
  quotaFloor: num(process.env.QUOTA_FLOOR, 20),
  /** Hard stop on calls per process-day, independent of what the API reports. */
  dailyCallCap: num(process.env.DAILY_CALL_CAP, 200),

  /** Value-engine thresholds. */
  thresholds: {
    /** Edge in percentage points that counts as a "high value" play. */
    highEdgePct: num(process.env.HIGH_EDGE_PCT, 2),
    /** Edge that counts as moderate value. */
    moderateEdgePct: num(process.env.MODERATE_EDGE_PCT, 1),
    /** Spread/total points of movement that trips a line-move alert. */
    lineMovePoints: num(process.env.LINE_MOVE_POINTS, 0.5),
    /** Points of sharp-vs-public disagreement that trips a divergence flag. */
    divergencePoints: num(process.env.DIVERGENCE_POINTS, 0.5),
    /** Moneyline cents of divergence that trip the same flag on h2h markets. */
    divergenceCents: num(process.env.DIVERGENCE_CENTS, 15),
    /**
     * Public-inflated-favourite test. Both conditions must hold: the price is at
     * or below `inflatedFavoritePrice` AND the implied probability is at or
     * above `inflatedFavoriteProb`. Note -120 alone only implies 54.5%, so with
     * the default 70% probability floor the flag effectively fires around -234
     * and shorter. Loosen `inflatedFavoriteProb` if you want it to fire on every
     * favourite from -120 down.
     */
    inflatedFavoritePrice: num(process.env.INFLATED_FAV_PRICE, -120),
    inflatedFavoriteProb: num(process.env.INFLATED_FAV_PROB, 0.7),
  },

  /** Bankroll / staking policy. */
  risk: {
    bankroll: num(process.env.BANKROLL, 1000),
    kellyMultiplier: num(process.env.KELLY_MULTIPLIER, 0.25),
    softCapPct: num(process.env.MAX_RISK_SOFT_PCT, 0.02),
    hardCapPct: num(process.env.MAX_RISK_HARD_PCT, 0.05),
  },

  /**
   * In-play only: how far behind the freshest quote a book may be and still
   * count toward the consensus fair price.
   *
   * Books reprice at wildly different speeds during a game. One that has not
   * updated since before the last score is still showing a pre-score number,
   * and averaging it in drags the consensus far above the true live
   * probability -- which the tool then reports as a large edge. It is not an
   * edge: it is a line that is about to move or be voided.
   *
   * This does NOT apply pre-game, where a line that has not moved in hours is
   * still the current, bettable price.
   */
  maxLiveQuoteAgeMs: num(process.env.MAX_LIVE_QUOTE_AGE_MS, 120_000),

  /** De-vig method used to turn book prices into fair probabilities. */
  devigMethod: process.env.DEVIG_METHOD === 'additive' ? 'additive' : 'multiplicative',

  /** Where line history is persisted so "opening" survives a restart. */
  historyFile: process.env.HISTORY_FILE || path.join(ROOT, 'data', 'history.json'),
  /** Snapshots kept per line before the oldest are dropped. */
  historyDepth: num(process.env.HISTORY_DEPTH, 60),
  /** Alerts kept in the ring buffer. */
  alertDepth: num(process.env.ALERT_DEPTH, 200),
};

/** Human label for a bookmaker key. */
export function bookTitle(key, fallback) {
  return BOOK_TITLES[key] || fallback || key;
}

export function isSharpBook(key) {
  return SHARP_BOOKS.includes(key);
}

export function isPublicBook(key) {
  return PUBLIC_BOOKS.includes(key);
}
