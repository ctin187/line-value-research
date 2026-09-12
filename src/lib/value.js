/**
 * The value-identification engine.
 *
 * Given the normalised offers for one game plus that game's line history, it
 * produces a per-selection view with:
 *   - a fair (no-vig) probability estimate,
 *   - the edge and EV of every book's price against that estimate,
 *   - line-movement, inflated-favourite and sharp/public-divergence flags.
 *
 * The honest part of the design: the fair probability is not magic. It is the
 * de-vigged consensus of the books, weighted towards the sharp ones, because a
 * sharp book's no-vig line is the best free estimate of true probability that
 * exists. When you have your own number, override it -- `userEstimates` wins
 * over everything and the UI labels the source.
 */
import {
  americanToImplied, americanToDecimal, devig, edgePct, evPct, isNum,
} from '../../shared/odds.js';
import { config, isSharpBook, isPublicBook } from '../config.js';
import { opposingSelection, selectionKey } from './normalize.js';
import { shiftProbability, shiftDirection } from './lineAdjust.js';

/** How much each book's opinion counts toward the consensus fair probability. */
const BOOK_WEIGHT = { pinnacle: 3, circasports: 2.5, lowvig: 2, betonlineag: 2 };
const DEFAULT_WEIGHT = 1;

/**
 * Rough worth of half a point of spread in percentage points of win probability,
 * used only to put point-based and cent-based divergences on one scale for
 * sorting. Displayed values always keep their native unit.
 */
const POINTS_TO_PROB_PCT = 2.2;

export const FLAGS = {
  LINE_MOVE: 'LINE_MOVE',
  REVERSE_LINE_MOVE: 'REVERSE_LINE_MOVE',
  INFLATED_FAVORITE: 'INFLATED_FAVORITE',
  SHARP_DIVERGENCE: 'SHARP_DIVERGENCE',
  HIGH_VALUE: 'HIGH_VALUE',
  MODERATE_VALUE: 'MODERATE_VALUE',
  NEGATIVE_VALUE: 'NEGATIVE_VALUE',
  VALUE_CLOSED: 'VALUE_CLOSED',
};

/**
 * De-vig one book's two-way market and return the fair probability of `offer`.
 * Returns null when the book only posts one side (nothing to de-vig against).
 */
export function fairProbAtBook(offer, offersInGame, game, method = config.devigMethod) {
  const opposite = opposingSelection(offer, game);
  const other = offersInGame.find(
    (o) =>
      o.book === offer.book &&
      o.market === offer.market &&
      o.selection === opposite &&
      pointsPair(offer, o),
  );
  if (!other) return null;

  const pA = americanToImplied(offer.price);
  const pB = americanToImplied(other.price);
  if (!isNum(pA) || !isNum(pB)) return null;

  const [fair] = devig([pA, pB], method);
  return fair;
}

/**
 * Two offers form a valid two-way pair when their numbers mirror each other:
 * totals share the same point, spreads are equal and opposite, moneylines have
 * no point at all.
 */
function pointsPair(a, b) {
  if (a.market === 'h2h') return true;
  if (!isNum(a.point) || !isNum(b.point)) return false;
  if (a.market === 'totals') return Math.abs(a.point - b.point) < 0.01;
  return Math.abs(a.point + b.point) < 0.01;
}

/**
 * Consensus fair probability for a selection, evaluated AT a specific number.
 *
 * Books quoting that exact number contribute directly. Books quoting a nearby
 * number contribute through the half-point approximation in lineAdjust.js, and
 * mark the result approximate. `excludeBook` keeps a book from grading its own
 * price, which would otherwise guarantee a zero edge everywhere.
 */
export function consensusFairProb({
  offers, game, market, selection, point, excludeBook = null, live = false,
  maxAgeMs = config.maxLiveQuoteAgeMs, staleBooks = null,
}) {
  const quotingThis = offers.filter((o) => o.market === market && o.selection === selection);
  const allCandidates = quotingThis.filter((o) => o.book !== excludeBook);

  // The freshness baseline comes from EVERY book quoting this selection,
  // including the one being graded. Measuring it against the post-exclusion
  // subset would let a single lagging book become its own reference and never
  // be dropped -- which is exactly the case that fabricates an edge.
  const stale = staleBooks || staleBooksFor(quotingThis, live, maxAgeMs);
  const candidates = allCandidates.filter((o) => !stale.has(o.book));
  const staleExcluded = allCandidates.length - candidates.length;

  let weighted = 0;
  let weight = 0;
  let approx = false;
  const contributors = [];

  for (const cand of candidates) {
    let fair = fairProbAtBook(cand, offers, game);
    if (!isNum(fair)) continue;

    let isApprox = false;
    if (market !== 'h2h' && isNum(point) && isNum(cand.point) && Math.abs(cand.point - point) > 0.01) {
      const shifted = shiftProbability({
        prob: fair,
        market,
        fromPoint: cand.point,
        toPoint: point,
        direction: shiftDirection({ market, side: cand.side, fromPoint: cand.point, toPoint: point }),
      });
      if (!isNum(shifted)) continue;
      fair = shifted;
      isApprox = true;
    }

    // A book quoting a different number is a weaker witness than one on the
    // exact number, so halve its say.
    const w = (BOOK_WEIGHT[cand.book] || DEFAULT_WEIGHT) * (isApprox ? 0.5 : 1);
    weighted += fair * w;
    weight += w;
    approx = approx || isApprox;
    contributors.push({ book: cand.book, fair, point: cand.point, approx: isApprox, weight: w });
  }

  if (weight === 0) return null;

  const sharpContributor = contributors.find((c) => isSharpBook(c.book) && !c.approx);
  return {
    prob: weighted / weight,
    approx,
    contributors,
    source: sharpContributor ? `sharp:${sharpContributor.book}` : 'consensus',
    bookCount: contributors.length,
    staleExcluded,
    live,
  };
}

/**
 * Which books are behind the live market for this selection.
 *
 * Returns a Set of book keys. Empty pre-game, where a timestamp hours old just
 * means the line has not moved and is still perfectly bettable. In-play it
 * means the book has not caught up with the score -- and a price like that is
 * not an opportunity, it is a line about to move or a bet about to be voided.
 */
export function staleBooksFor(offersForSelection, live, maxAgeMs = config.maxLiveQuoteAgeMs) {
  if (!live || !offersForSelection.length) return new Set();

  const stamps = offersForSelection
    .map((o) => Date.parse(o.lastUpdate))
    .filter((t) => Number.isFinite(t));
  if (!stamps.length) return new Set();

  const freshest = Math.max(...stamps);
  return new Set(
    offersForSelection
      .filter((o) => {
        const t = Date.parse(o.lastUpdate);
        return !Number.isFinite(t) || freshest - t > maxAgeMs;
      })
      .map((o) => o.book),
  );
}


/**
 * Sharp-vs-public disagreement.
 *
 * On spreads and totals the comparison is in points; on moneylines points do not
 * exist, so it compares the prices in cents. Either way, a gap wider than the
 * configured threshold means the sharp book and the public books are pricing
 * different games -- and the sharp book is usually the one to believe.
 */
export function sharpDivergence({ offers, market, selection }) {
  const rows = offers.filter((o) => o.market === market && o.selection === selection);
  const sharp = rows.filter((o) => isSharpBook(o.book));
  const pub = rows.filter((o) => isPublicBook(o.book));
  if (!sharp.length || !pub.length) return null;

  const ref = sharp[0];

  if (market === 'h2h') {
    let worst = null;
    for (const p of pub) {
      const gap = Math.abs((americanToImplied(p.price) - americanToImplied(ref.price)) * 100);
      const cents = Math.abs(centsOf(p.price) - centsOf(ref.price));
      if (!worst || cents > worst.cents) {
        worst = { book: p.book, bookTitle: p.bookTitle, cents, probGap: gap, publicPrice: p.price };
      }
    }
    if (!worst) return null;
    return {
      market,
      unit: 'cents',
      sharpBook: ref.book,
      sharpBookTitle: ref.bookTitle,
      sharpPrice: ref.price,
      ...worst,
      magnitude: worst.cents,
      // Percentage points of implied probability, so point-based and cent-based
      // disagreements can be ranked against each other in the "sort by
      // divergence" view. The UI still displays the native unit.
      normalized: worst.probGap,
      triggered: worst.cents > config.thresholds.divergenceCents,
    };
  }

  let worst = null;
  for (const p of pub) {
    if (!isNum(p.point) || !isNum(ref.point)) continue;
    const gap = Math.abs(p.point - ref.point);
    if (!worst || gap > worst.gap) {
      worst = { book: p.book, bookTitle: p.bookTitle, gap, publicPoint: p.point, publicPrice: p.price };
    }
  }
  if (!worst) return null;

  return {
    market,
    unit: 'points',
    sharpBook: ref.book,
    sharpBookTitle: ref.bookTitle,
    sharpPoint: ref.point,
    sharpPrice: ref.price,
    ...worst,
    magnitude: worst.gap,
    normalized: (worst.gap / 0.5) * POINTS_TO_PROB_PCT,
    triggered: worst.gap > config.thresholds.divergencePoints,
  };
}

/**
 * American price on a continuous "cents from even" scale, so prices either side
 * of even money can be subtracted. -110 -> -10, +110 -> +10, -200 -> -100.
 * The gap between -110 and +100 is then 10 cents, which is how books quote it.
 */
function centsOf(price) {
  if (!isNum(price)) return null;
  return price > 0 ? price - 100 : price + 100;
}

/**
 * Public-inflated-favourite test.
 *
 * Fires when a price is at or below the configured threshold AND its implied
 * probability is at or above the floor -- a favourite the public has bet into a
 * price that leaves no room, where the value (if any) is on the other side.
 */
export function inflatedFavorite(offer) {
  const { inflatedFavoritePrice, inflatedFavoriteProb } = config.thresholds;
  const implied = americanToImplied(offer.price);
  if (!isNum(implied)) return null;
  const triggered = offer.price <= inflatedFavoritePrice && implied >= inflatedFavoriteProb;
  if (!triggered) return null;
  return {
    price: offer.price,
    impliedProb: implied,
    priceThreshold: inflatedFavoritePrice,
    probThreshold: inflatedFavoriteProb,
  };
}

/**
 * Grade a single book's price for a selection against a fair probability.
 * `edgePct` is the probability gap in percentage points; `evPct` is what that
 * gap is actually worth per unit staked, which is the number that pays rent.
 */
export function gradeOffer(offer, fairProb) {
  const implied = americanToImplied(offer.price);
  const edge = edgePct(fairProb, implied);
  const ev = evPct(fairProb, offer.price);
  const { highEdgePct, moderateEdgePct } = config.thresholds;

  let tier = 'none';
  if (isNum(edge)) {
    if (edge >= highEdgePct) tier = 'high';
    else if (edge >= moderateEdgePct) tier = 'moderate';
    else if (edge < 0) tier = 'negative';
    else tier = 'low';
  }

  return {
    ...offer,
    impliedProb: implied,
    decimal: americanToDecimal(offer.price),
    fairProb: isNum(fairProb) ? fairProb : null,
    edgePct: edge,
    evPct: ev,
    tier,
  };
}

/**
 * Line movement for one book's selection, comparing the opening snapshot this
 * tool recorded to the current one.
 *
 * IMPORTANT: "opening" means the first time THIS tool saw the line, not the
 * book's true opener -- historical odds are a paid endpoint on The Odds API. A
 * scanner started on Saturday morning reports Saturday morning's number as the
 * open. The UI labels it "since first seen" for that reason.
 *
 * Reverse line movement proper needs public ticket percentages, which no free
 * feed provides. What is flagged here is the free observable half of it: the
 * number moving TOWARD the underdog / against the favourite, which is the shape
 * sharp money usually leaves behind. Treat it as a prompt to look, not proof.
 */
export function lineMovement(offer, history) {
  const entry = history?.get?.(offer.key);
  if (!entry?.opening) return null;

  const { opening } = entry;
  const pointDelta = isNum(offer.point) && isNum(opening.point) ? offer.point - opening.point : null;
  const priceDelta = offer.price - opening.price;
  const impliedDelta =
    (americanToImplied(offer.price) - americanToImplied(opening.price)) * 100;

  const threshold = config.thresholds.lineMovePoints;
  const movedPoints = isNum(pointDelta) && Math.abs(pointDelta) >= threshold;

  // Toward the underdog: a favourite's spread shrinking (-7 -> -6.5) or a dog's
  // growing. For totals, "toward the under" is the analogous downward move.
  let towardUnderdog = null;
  if (isNum(pointDelta) && pointDelta !== 0 && offer.market === 'spreads') {
    towardUnderdog = opening.point < 0 ? pointDelta > 0 : pointDelta < 0;
  }

  return {
    openingPoint: opening.point,
    openingPrice: opening.price,
    openedAt: opening.ts,
    pointDelta,
    priceDelta,
    impliedDeltaPct: impliedDelta,
    movedPoints,
    towardUnderdog,
    steamAgainstFavorite: Boolean(movedPoints && towardUnderdog),
    samples: entry.samples?.length || 0,
  };
}

/**
 * Analyse one game end to end.
 *
 * Returns the game with a `selections` array -- one entry per (market,
 * selection) pair, carrying the fair probability, every book's graded price, the
 * best available price, and the flags that fired.
 */
export function analyzeGame({ game, offers, history, userEstimates = new Map(), live = false }) {
  const bySelection = new Map();
  for (const offer of offers) {
    const key = `${offer.market}|${offer.selection}`;
    if (!bySelection.has(key)) bySelection.set(key, []);
    bySelection.get(key).push(offer);
  }

  const selections = [];

  for (const [key, rows] of bySelection) {
    const [market, selection] = key.split('|');

    // Worked out once per selection and reused, so the consensus and the
    // per-book grading can never disagree about who is behind the market.
    const staleBooks = staleBooksFor(rows, live);
    // Price at the number the majority of the market is using, so the headline
    // edge is not driven by one outlier book on a stray hook.
    const consensusPoint = modePoint(rows);

    const userEstimate = userEstimates.get(selectionKey({ gameId: game.id, market, selection }));

    const graded = rows.map((offer) => {
      let fair = null;
      let fairMeta = null;

      if (isNum(userEstimate)) {
        fair = userEstimate;
        fairMeta = { source: 'user', approx: false, bookCount: 0 };
      } else {
        const consensus = consensusFairProb({
          offers,
          game,
          market,
          selection,
          point: offer.point,
          excludeBook: offer.book,
          live,
          staleBooks,
        });
        if (consensus) {
          fair = consensus.prob;
          fairMeta = consensus;
        }
      }

      const g = gradeOffer(offer, fair);
      g.fairSource = fairMeta?.source || null;
      g.fairApprox = Boolean(fairMeta?.approx);
      g.fairBookCount = fairMeta?.bookCount ?? 0;
      g.movement = lineMovement(offer, history);
      g.inflatedFavorite = inflatedFavorite(offer);

      // A book that is itself behind the live market does not get an edge.
      // Grading its stale price against the books that HAVE repriced is how a
      // frozen line turns into a big green number -- the tool reporting that
      // you can buy a 92% favourite at 82%, when in truth that price is
      // suspended, limited to pennies, or about to vanish.
      if (staleBooks.has(offer.book)) {
        g.stale = true;
        g.edgePct = null;
        g.evPct = null;
        g.tier = 'stale';
      }
      return g;
    });

    const best = bestPrice(graded);
    const divergence = sharpDivergence({ offers, market, selection });

    // The headline fair price needs at least two independent books. With one
    // book the "consensus" is just that book's own de-vigged line, which would
    // show a confident number backed by nothing -- so it stays null, matching
    // the per-book edges (which are already null for want of a comparison).
    const rawConsensus = consensusFairProb({
      offers, game, market, selection, point: consensusPoint, live, staleBooks,
    });
    const consensusFair = (rawConsensus?.bookCount ?? 0) >= 2 ? rawConsensus : null;

    const flags = [];
    if (graded.some((g) => g.movement?.movedPoints)) flags.push(FLAGS.LINE_MOVE);
    if (graded.some((g) => g.movement?.steamAgainstFavorite)) flags.push(FLAGS.REVERSE_LINE_MOVE);
    if (graded.some((g) => g.inflatedFavorite)) flags.push(FLAGS.INFLATED_FAVORITE);
    if (divergence?.triggered) flags.push(FLAGS.SHARP_DIVERGENCE);
    if (best?.tier === 'high') flags.push(FLAGS.HIGH_VALUE);
    else if (best?.tier === 'moderate') flags.push(FLAGS.MODERATE_VALUE);
    else if (best?.tier === 'negative') flags.push(FLAGS.NEGATIVE_VALUE);

    selections.push({
      gameId: game.id,
      selKey: selectionKey({ gameId: game.id, market, selection }),
      market,
      selection,
      side: rows[0].side,
      consensusPoint,
      fairProb: isNum(userEstimate) ? userEstimate : consensusFair?.prob ?? null,
      fairSource: isNum(userEstimate) ? 'user' : consensusFair?.source ?? null,
      fairApprox: isNum(userEstimate) ? false : Boolean(consensusFair?.approx),
      fairBookCount: isNum(userEstimate) ? 0 : consensusFair?.bookCount ?? 0,
      /** Books dropped from the consensus for being behind the live market. */
      staleExcluded: consensusFair?.staleExcluded ?? 0,
      /** ...and which ones, so the board can name them instead of counting them. */
      staleBookTitles: rows.filter((o) => staleBooks.has(o.book)).map((o) => o.bookTitle),
      live,
      userEstimate: isNum(userEstimate) ? userEstimate : null,
      books: graded.sort((a, b) => (b.edgePct ?? -999) - (a.edgePct ?? -999)),
      best,
      bestEdgePct: best?.edgePct ?? null,
      bestEvPct: best?.evPct ?? null,
      divergence,
      maxMovePoints: maxAbs(graded.map((g) => g.movement?.pointDelta)),
      flags,
    });
  }

  selections.sort(
    (a, b) =>
      marketOrder(a.market) - marketOrder(b.market) ||
      (b.bestEdgePct ?? -999) - (a.bestEdgePct ?? -999),
  );

  return {
    ...game,
    live,
    selections,
    bestEdgePct: maxOf(selections.map((s) => s.bestEdgePct)),
    maxMovePoints: maxAbs(selections.map((s) => s.maxMovePoints)),
    maxDivergence: maxOf(selections.map((s) => (s.divergence?.triggered ? s.divergence.normalized : null))),
    flags: [...new Set(selections.flatMap((s) => s.flags))],
    bookCount: new Set(offers.map((o) => o.book)).size,
  };
}

/**
 * Best available price for the bettor: highest EV, tie-broken on raw price.
 * Stale in-play quotes are not candidates -- they are not prices you can take.
 */
function bestPrice(graded) {
  const bettable = graded.filter((g) => !g.stale);
  let best = null;
  for (const g of (bettable.length ? bettable : graded)) {
    if (!best) { best = g; continue; }
    const a = isNum(g.evPct) ? g.evPct : -Infinity;
    const b = isNum(best.evPct) ? best.evPct : -Infinity;
    if (a > b || (a === b && (g.decimal ?? 0) > (best.decimal ?? 0))) best = g;
  }
  return best;
}

/** The number most books are on; ties break toward the sharpest book present. */
function modePoint(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!isNum(r.point)) continue;
    counts.set(r.point, (counts.get(r.point) || 0) + (isSharpBook(r.book) ? 1.5 : 1));
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function marketOrder(market) {
  return { spreads: 0, totals: 1, h2h: 2 }[market] ?? 9;
}

function maxOf(values) {
  const usable = values.filter(isNum);
  return usable.length ? Math.max(...usable) : null;
}

function maxAbs(values) {
  const usable = values.filter(isNum);
  if (!usable.length) return null;
  return usable.reduce((acc, v) => (Math.abs(v) > Math.abs(acc) ? v : acc), 0);
}
