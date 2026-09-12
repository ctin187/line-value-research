/**
 * Pure odds math. No Node or DOM dependencies -- this module is imported by the
 * server and served directly to the browser, so both sides use identical math.
 *
 * Probabilities are always fractions in [0, 1]. "American" odds are integers
 * such as -110 or +145. "Decimal" odds are the total return per 1 unit staked.
 */

/** True when `v` is a usable finite number. */
export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Implied probability of an American price, vig included.
 *   negative odds: |odds| / (|odds| + 100)
 *   positive odds: 100 / (odds + 100)
 * American odds between -100 and +100 exclusive do not exist; they are rejected.
 */
export function americanToImplied(odds) {
  if (!isNum(odds)) return null;
  if (odds <= -100) return Math.abs(odds) / (Math.abs(odds) + 100);
  if (odds >= 100) return 100 / (odds + 100);
  return null;
}

/** Decimal (European) odds for an American price. -110 -> 1.909, +150 -> 2.5 */
export function americanToDecimal(odds) {
  if (!isNum(odds)) return null;
  if (odds <= -100) return 1 + 100 / Math.abs(odds);
  if (odds >= 100) return 1 + odds / 100;
  return null;
}

/** Inverse of americanToDecimal. Decimal must be > 1. */
export function decimalToAmerican(dec) {
  if (!isNum(dec) || dec <= 1) return null;
  return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
}

/** Decimal odds implied by a probability (no vig). */
export function probToDecimal(p) {
  if (!isNum(p) || p <= 0 || p >= 1) return null;
  return 1 / p;
}

/** Fair American price for a probability, e.g. 0.55 -> -122. */
export function probToAmerican(p) {
  const dec = probToDecimal(p);
  return dec === null ? null : decimalToAmerican(dec);
}

/**
 * Total booked probability of a market. 1.0 means no vig; 1.048 means the book
 * has built in 4.8 points of hold across the market.
 */
export function overround(probs) {
  const usable = probs.filter(isNum);
  if (!usable.length) return null;
  return usable.reduce((a, b) => a + b, 0);
}

/** Book hold ("vig") as a fraction of the booked market, e.g. 0.0455. */
export function vigOf(probs) {
  const sum = overround(probs);
  if (sum === null || sum <= 0) return null;
  return (sum - 1) / sum;
}

/**
 * Strip the vig from a market's implied probabilities.
 *
 * `multiplicative` (a.k.a. proportional) simply normalises the probabilities so
 * they sum to 1. It is the standard quick de-vig and is unbiased enough for the
 * roughly balanced two-way markets this tool scans.
 *
 * `additive` removes an equal absolute share of the overround from each side.
 * Because the deduction is the same size everywhere, it costs a longshot a much
 * larger fraction of its probability than it costs a favourite -- so it shades
 * fair value toward favourites relative to the multiplicative method. Offered
 * for comparison via DEVIG_METHOD=additive.
 *
 * Returns an array the same length as the input; unusable entries stay null.
 */
export function devig(probs, method = 'multiplicative') {
  const usable = probs.filter(isNum);
  const sum = overround(probs);
  if (sum === null || sum <= 0) return probs.map(() => null);

  if (method === 'additive') {
    const excess = (sum - 1) / usable.length;
    return probs.map((p) => (isNum(p) ? clampProb(p - excess) : null));
  }
  return probs.map((p) => (isNum(p) ? p / sum : null));
}

/** Keep a probability inside (0, 1) so downstream division never blows up. */
export function clampProb(p) {
  if (!isNum(p)) return null;
  return Math.min(0.999999, Math.max(0.000001, p));
}

/**
 * Edge in percentage points: how much more likely you think the outcome is than
 * the price says. estimated 0.54 vs implied 0.517 -> +2.3.
 */
export function edgePct(estimatedProb, impliedProb) {
  if (!isNum(estimatedProb) || !isNum(impliedProb)) return null;
  return (estimatedProb - impliedProb) * 100;
}

/**
 * Expected value per 1 unit staked at American odds `price`, given your
 * probability estimate. +0.043 means 4.3 cents returned per unit risked.
 *
 * Note this is *not* the same number as edgePct: a 2% probability edge on a
 * +200 underdog is worth far more per unit than 2% on a -300 favourite.
 */
export function evPerUnit(estimatedProb, price) {
  const dec = americanToDecimal(price);
  if (!isNum(estimatedProb) || dec === null) return null;
  return estimatedProb * (dec - 1) - (1 - estimatedProb);
}

/** Expected value expressed as a percentage of the stake. */
export function evPct(estimatedProb, price) {
  const ev = evPerUnit(estimatedProb, price);
  return ev === null ? null : ev * 100;
}

/**
 * Break-even win rate for a price: the probability at which the bet is exactly
 * a coin flip in EV terms. Identical to the implied probability.
 */
export function breakEvenProb(price) {
  return americanToImplied(price);
}

/** Format an American price the way a book displays it. */
export function formatAmerican(odds) {
  if (!isNum(odds)) return '--';
  return odds > 0 ? `+${Math.round(odds)}` : `${Math.round(odds)}`;
}

/** Format a spread/total point with an explicit sign for spreads. */
export function formatPoint(point, { signed = true } = {}) {
  if (!isNum(point)) return '';
  const rounded = Math.round(point * 2) / 2;
  if (!signed) return `${rounded}`;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}
