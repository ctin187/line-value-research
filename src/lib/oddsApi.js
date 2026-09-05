/**
 * The Odds API v4 client.
 *
 * Quota is the thing that actually bites on the free tier, so it is a
 * first-class concern here rather than an afterthought:
 *
 *  - one request costs (number of markets x number of regions) credits, so the
 *    default spreads+totals+h2h over the us region costs 3 credits per sport
 *    per call -- roughly 55 scans of both sports on a 500-credit month;
 *  - every response carries x-requests-remaining / x-requests-used, which is
 *    recorded and surfaced in the UI;
 *  - calls stop entirely once the remaining balance reaches `quotaFloor` or the
 *    process has made `dailyCallCap` calls today.
 */
import { config, SPORTS } from '../config.js';

export class QuotaError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'QuotaError';
    Object.assign(this, detail);
  }
}

export class OddsApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'OddsApiError';
    this.status = status;
    this.body = body;
  }
}

export class OddsApiClient {
  constructor({ apiKey = config.apiKey, base = config.apiBase, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey;
    this.base = base.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.quota = {
      remaining: null,
      used: null,
      lastCost: null,
      callsToday: 0,
      day: today(),
      lastCallAt: null,
      lastError: null,
    };
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  /** Credits one odds call costs with the current market/region configuration. */
  creditCost() {
    const regions = config.regions.split(',').filter(Boolean).length || 1;
    return Math.max(1, config.markets.length * regions);
  }

  rollDay() {
    const d = today();
    if (this.quota.day !== d) {
      this.quota.day = d;
      this.quota.callsToday = 0;
    }
  }

  /**
   * Why a call would be refused right now, or null when it is allowed.
   * Checked before every request so the reason can be shown in the UI.
   */
  blockedReason() {
    this.rollDay();
    if (!this.configured) return 'No ODDS_API_KEY configured';
    if (this.quota.callsToday >= config.dailyCallCap) {
      return `Daily call cap reached (${config.dailyCallCap})`;
    }
    if (this.quota.remaining !== null && this.quota.remaining <= config.quotaFloor) {
      return `Quota floor reached (${this.quota.remaining} credits left, floor ${config.quotaFloor})`;
    }
    return null;
  }

  /** Odds for one sport slug ('nfl' | 'ncaaf'). Returns the raw API array. */
  async fetchOdds(sportSlug) {
    const sport = SPORTS[sportSlug];
    if (!sport) throw new OddsApiError(`Unknown sport '${sportSlug}'`, 400);

    const blocked = this.blockedReason();
    if (blocked) throw new QuotaError(blocked, { quota: this.quota });

    const url = new URL(`${this.base}/sports/${sport.key}/odds`);
    url.searchParams.set('apiKey', this.apiKey);
    url.searchParams.set('regions', config.regions);
    url.searchParams.set('markets', config.markets.join(','));
    url.searchParams.set('oddsFormat', config.oddsFormat);
    url.searchParams.set('dateFormat', 'iso');
    if (config.books.length) url.searchParams.set('bookmakers', config.books.join(','));

    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    this.quota.callsToday += 1;
    this.quota.lastCallAt = new Date().toISOString();
    this.readQuotaHeaders(res.headers);

    if (!res.ok) {
      const body = await safeText(res);
      this.quota.lastError = `${res.status}: ${body.slice(0, 200)}`;
      throw new OddsApiError(describeStatus(res.status, body), res.status, body);
    }

    this.quota.lastError = null;
    return res.json();
  }

  /** Sports list -- free of charge, so it is the cheapest way to verify a key. */
  async listSports() {
    if (!this.configured) throw new QuotaError('No ODDS_API_KEY configured');
    const url = new URL(`${this.base}/sports/`);
    url.searchParams.set('apiKey', this.apiKey);
    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    this.readQuotaHeaders(res.headers);
    if (!res.ok) {
      const body = await safeText(res);
      throw new OddsApiError(describeStatus(res.status, body), res.status, body);
    }
    return res.json();
  }

  readQuotaHeaders(headers) {
    if (!headers?.get) return;
    const remaining = Number(headers.get('x-requests-remaining'));
    const used = Number(headers.get('x-requests-used'));
    const last = Number(headers.get('x-requests-last'));
    if (Number.isFinite(remaining)) this.quota.remaining = remaining;
    if (Number.isFinite(used)) this.quota.used = used;
    if (Number.isFinite(last)) this.quota.lastCost = last;
  }

  snapshot() {
    this.rollDay();
    return {
      ...this.quota,
      configured: this.configured,
      creditCost: this.creditCost(),
      dailyCallCap: config.dailyCallCap,
      quotaFloor: config.quotaFloor,
      blocked: this.blockedReason(),
    };
  }
}

/** Turn an HTTP status into something a user can act on. */
function describeStatus(status, body) {
  if (status === 401) return 'Odds API rejected the key (401). Check ODDS_API_KEY in .env.';
  if (status === 422) return `Odds API rejected the request (422). Check markets/regions/bookmakers: ${body.slice(0, 160)}`;
  if (status === 429) return 'Odds API quota exhausted (429). Wait for the monthly reset or upgrade the plan.';
  if (status >= 500) return `Odds API is having problems (${status}). Try again shortly.`;
  return `Odds API request failed (${status}): ${body.slice(0, 160)}`;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
