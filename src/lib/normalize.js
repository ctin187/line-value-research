/**
 * Turns The Odds API's nested game -> bookmaker -> market -> outcome shape into
 * a flat list of "offers", which is the unit everything downstream works on.
 *
 * An offer is one selection, at one book, at one price:
 *   { gameId, market, selection, side, point, price, book, ... }
 *
 * `lineKey` deliberately EXCLUDES the point, because tracking movement means
 * following the same selection at the same book as its number changes.
 */
import { SPORTS, bookTitle } from '../config.js';

/** Stable identity for a selection at a book, independent of its current number. */
export function lineKey({ gameId, market, book, selection }) {
  return `${gameId}|${market}|${book}|${selection}`;
}

/** Identity for a selection across all books -- used to group the market. */
export function selectionKey({ gameId, market, selection }) {
  return `${gameId}|${market}|${selection}`;
}

/** Which side of the market a selection sits on. */
function sideOf(market, name, game) {
  if (market === 'totals') return name.toLowerCase() === 'over' ? 'over' : 'under';
  if (name === game.home_team) return 'home';
  if (name === game.away_team) return 'away';
  return 'other';
}

/**
 * Normalise a single game from the API into { game, offers }.
 * Unknown books, unknown markets and malformed outcomes are dropped quietly --
 * a feed that adds a new market should not crash the scanner.
 */
export function normalizeGame(raw, { books = null, markets = null, sportLabel = null } = {}) {
  if (!raw?.id || !raw.home_team || !raw.away_team) return null;

  const game = {
    id: raw.id,
    sportKey: raw.sport_key,
    sport: sportKeyToSlug(raw.sport_key),
    sportTitle: sportLabel || raw.sport_title || raw.sport_key,
    commenceTime: raw.commence_time,
    home: raw.home_team,
    away: raw.away_team,
    matchup: `${raw.away_team} @ ${raw.home_team}`,
  };

  const offers = [];
  for (const bm of raw.bookmakers || []) {
    if (books && !books.includes(bm.key)) continue;
    for (const mk of bm.markets || []) {
      if (markets && !markets.includes(mk.key)) continue;
      for (const out of mk.outcomes || []) {
        if (typeof out?.price !== 'number' || !out?.name) continue;
        offers.push({
          gameId: game.id,
          sport: game.sport,
          market: mk.key,
          selection: out.name,
          side: sideOf(mk.key, out.name, raw),
          point: typeof out.point === 'number' ? out.point : null,
          price: out.price,
          book: bm.key,
          bookTitle: bookTitle(bm.key, bm.title),
          lastUpdate: mk.last_update || bm.last_update || null,
          key: lineKey({ gameId: game.id, market: mk.key, book: bm.key, selection: out.name }),
          selKey: selectionKey({ gameId: game.id, market: mk.key, selection: out.name }),
        });
      }
    }
  }

  return { game, offers };
}

/** Normalise a full API response. */
export function normalizeFeed(rawGames, opts = {}) {
  const games = [];
  const offers = [];
  for (const raw of rawGames || []) {
    const norm = normalizeGame(raw, opts);
    if (!norm) continue;
    games.push(norm.game);
    offers.push(...norm.offers);
  }
  return { games, offers };
}

/** 'americanfootball_nfl' -> 'nfl'. Falls back to the raw key. */
export function sportKeyToSlug(sportKey) {
  for (const [slug, def] of Object.entries(SPORTS)) {
    if (def.key === sportKey) return slug;
  }
  return sportKey;
}

/**
 * The opposite selection inside the same game+market, which is what de-vigging
 * needs. Totals pair over/under; spreads and moneylines pair the two teams.
 */
export function opposingSelection(offer, game) {
  if (offer.market === 'totals') return offer.side === 'over' ? 'Under' : 'Over';
  return offer.selection === game.home ? game.away : game.home;
}
