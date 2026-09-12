/**
 * Approximate conversion between spread/total numbers and win probability.
 *
 * When the only reference price for a selection sits at a different number than
 * the offer you are pricing (Pinnacle -3, DraftKings -3.5), the two are not
 * directly comparable. Comparing them anyway is the single easiest way to
 * manufacture a fake edge, so this module makes the adjustment explicit and
 * every result that used it is tagged `approx: true` in the UI.
 *
 * The numbers below are the standard "cents per half point" rules of thumb for
 * American football. They are approximations, not a scoring-margin model: real
 * half-point values come from a distribution of margins, and the key numbers (3
 * and 7, where a huge share of games land) are worth far more than the rest.
 */

/** Probability shift per half point of spread, by the numbers being crossed. */
const SPREAD_HALF_POINT = [
  { at: 3, prob: 0.030 },
  { at: 7, prob: 0.022 },
  { at: 6, prob: 0.016 },
  { at: 10, prob: 0.014 },
  { at: 4, prob: 0.014 },
  { at: 14, prob: 0.012 },
];
const SPREAD_DEFAULT_HALF_POINT = 0.011;
/** Totals cross key numbers far less sharply than spreads do. */
const TOTAL_DEFAULT_HALF_POINT = 0.009;

/**
 * Value of the half point that sits between `from` and `to` (a 0.5 step).
 *
 * A key number counts when it lies anywhere in the closed interval, so both the
 * 2.5->3 step and the 3->3.5 step are charged the key-number-3 rate: moving off
 * 3 in either direction gives up (or buys) the push equity that makes 3 the
 * most valuable number on the board.
 */
function halfPointValue(market, from, to) {
  if (market === 'totals') return TOTAL_DEFAULT_HALF_POINT;
  const high = Math.max(Math.abs(from), Math.abs(to));
  const low = Math.min(Math.abs(from), Math.abs(to));
  const hit = SPREAD_HALF_POINT.find((k) => k.at >= low && k.at <= high);
  return hit ? hit.prob : SPREAD_DEFAULT_HALF_POINT;
}

/**
 * Move a probability from one number to another, walking in half-point steps so
 * key numbers are charged individually.
 *
 * `direction` is +1 when moving to `toPoint` makes the selection MORE likely to
 * win (e.g. a spread getting more generous), -1 when it makes it less likely.
 * Returns null when the two numbers are equal or the inputs are unusable.
 */
export function shiftProbability({ prob, market, fromPoint, toPoint, direction }) {
  if (typeof prob !== 'number' || !Number.isFinite(prob)) return null;
  if (typeof fromPoint !== 'number' || typeof toPoint !== 'number') return null;
  if (fromPoint === toPoint) return prob;

  const steps = Math.round(Math.abs(toPoint - fromPoint) / 0.5);
  // Beyond a couple of points the linear rule of thumb stops being trustworthy.
  if (steps === 0 || steps > 6) return null;

  let current = prob;
  let cursor = fromPoint;
  const step = toPoint > fromPoint ? 0.5 : -0.5;

  for (let i = 0; i < steps; i += 1) {
    const next = cursor + step;
    current += direction * halfPointValue(market, cursor, next);
    cursor = next;
  }

  if (current <= 0.01 || current >= 0.99) return null;
  return current;
}

/**
 * Direction of the probability change when a selection's number moves from
 * `fromPoint` to `toPoint`.
 *
 * Spreads: a bigger (more positive) number is always better for the bettor --
 * +3.5 beats +3, and -2.5 beats -3.
 * Totals: a higher number helps the Under and hurts the Over.
 */
export function shiftDirection({ market, side, fromPoint, toPoint }) {
  const rising = toPoint > fromPoint;
  if (market === 'totals') {
    if (side === 'over') return rising ? -1 : 1;
    return rising ? 1 : -1;
  }
  return rising ? 1 : -1;
}
