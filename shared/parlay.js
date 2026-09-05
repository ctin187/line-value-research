/**
 * Parlay maths and stake sizing. Pure -- shared by the server and the browser.
 *
 * Every function that combines legs assumes the legs are INDEPENDENT. That is
 * true enough for legs in different games and false for correlated legs (a team
 * moneyline plus that game's over, two props on the same player). The UI warns
 * when it detects legs from the same game; the maths here does not attempt to
 * model the correlation, because free odds feeds carry no correlation data.
 */
import { americanToDecimal, decimalToAmerican, americanToImplied, isNum } from './odds.js';

/** Combined decimal odds of a set of legs. Returns null if any leg is unusable. */
export function parlayDecimal(legs) {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  let dec = 1;
  for (const leg of legs) {
    const d = americanToDecimal(leg?.price);
    if (d === null) return null;
    dec *= d;
  }
  return dec;
}

/** Combined American price of the parlay, e.g. three -110 legs -> +596. */
export function parlayAmerican(legs) {
  const dec = parlayDecimal(legs);
  return dec === null ? null : decimalToAmerican(dec);
}

/** Total returned (stake + profit) if every leg wins. */
export function parlayPayout(legs, stake) {
  const dec = parlayDecimal(legs);
  if (dec === null || !isNum(stake)) return null;
  return dec * stake;
}

/** Profit only, i.e. payout minus stake. */
export function parlayProfit(legs, stake) {
  const payout = parlayPayout(legs, stake);
  return payout === null ? null : payout - stake;
}

/**
 * Probability the parlay cashes, using the priced (vig-inclusive) probabilities.
 * This is the book's number, so it is always pessimistic relative to fair value.
 */
export function parlayImpliedProb(legs) {
  const dec = parlayDecimal(legs);
  return dec === null ? null : 1 / dec;
}

/**
 * Probability the parlay cashes using your own per-leg estimates. Legs fall back
 * to their implied probability when no estimate exists, which keeps the number
 * honest rather than optimistic.
 */
export function parlayEstimatedProb(legs) {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  let p = 1;
  for (const leg of legs) {
    const est = isNum(leg?.estimatedProb) ? leg.estimatedProb : americanToImplied(leg?.price);
    if (!isNum(est)) return null;
    p *= est;
  }
  return p;
}

/**
 * Break-even hit rate for the parlay as a whole: win this often and you are
 * exactly flat. Equal to the parlay's implied probability.
 */
export function requiredWinRate(legs) {
  return parlayImpliedProb(legs);
}

/**
 * Break-even accuracy PER LEG, assuming every leg is hit at the same rate:
 *   (1 / parlayDecimal) ^ (1 / n)
 * A three-leg -110 parlay needs ~52.4% per leg, same as a straight bet -- the
 * parlay does not change the per-leg bar, it changes the variance.
 */
export function requiredAccuracyPerLeg(legs) {
  const dec = parlayDecimal(legs);
  if (dec === null) return null;
  return Math.pow(1 / dec, 1 / legs.length);
}

/** Expected profit per 1 unit staked, using your estimated probability. */
export function parlayEvPerUnit(legs, estimatedProb = parlayEstimatedProb(legs)) {
  const dec = parlayDecimal(legs);
  if (dec === null || !isNum(estimatedProb)) return null;
  return estimatedProb * (dec - 1) - (1 - estimatedProb);
}

/**
 * Full Kelly fraction of bankroll for a single wager:
 *   f* = (p * (dec - 1) - (1 - p)) / (dec - 1)
 * Returns 0 (never negative) when the wager has no edge -- you cannot bet the
 * other side of a parlay.
 */
export function kellyFraction(prob, decimalOdds) {
  if (!isNum(prob) || !isNum(decimalOdds) || decimalOdds <= 1) return null;
  const b = decimalOdds - 1;
  const f = (prob * b - (1 - prob)) / b;
  return Math.max(0, f);
}

/**
 * Recommended stake for a parlay.
 *
 * Full Kelly is far too aggressive for parlays: the estimates are noisy and the
 * legs are rarely as independent as the maths pretends. So the stake is a
 * fraction of Kelly (default a quarter) and is then hard-capped at a percentage
 * of bankroll (default 2% soft / 5% hard, per the risk policy in config).
 *
 * Returns the recommendation plus every intermediate number so the UI can show
 * its work rather than just an amount.
 */
export function recommendStake({
  legs,
  bankroll,
  estimatedProb = parlayEstimatedProb(legs),
  kellyMultiplier = 0.25,
  softCapPct = 0.02,
  hardCapPct = 0.05,
} = {}) {
  const dec = parlayDecimal(legs);
  if (dec === null || !isNum(bankroll) || bankroll <= 0) {
    return { stake: 0, reason: 'no-legs', kelly: null, fraction: 0 };
  }

  const kelly = kellyFraction(estimatedProb, dec);
  if (kelly === null) return { stake: 0, reason: 'no-estimate', kelly: null, fraction: 0 };

  if (kelly <= 0) {
    return {
      stake: 0,
      reason: 'no-edge',
      kelly: 0,
      fraction: 0,
      estimatedProb,
      impliedProb: 1 / dec,
      decimal: dec,
      capped: false,
    };
  }

  const scaled = kelly * kellyMultiplier;
  const capped = scaled > hardCapPct;
  const fraction = Math.min(scaled, hardCapPct);

  return {
    stake: round2(fraction * bankroll),
    fraction,
    kelly,
    kellyMultiplier,
    capped,
    overSoftCap: fraction > softCapPct,
    softCapPct,
    hardCapPct,
    estimatedProb,
    impliedProb: 1 / dec,
    decimal: dec,
    reason: capped ? 'capped-at-hard-limit' : 'kelly',
  };
}

/**
 * One call that produces every number the parlay panel displays.
 * `legs` are { id, price, estimatedProb?, gameId?, label? }.
 */
export function quoteParlay({ legs = [], stake = 0, bankroll = 0, kellyMultiplier, softCapPct, hardCapPct } = {}) {
  const usable = legs.filter((l) => americanToDecimal(l?.price) !== null);
  const dec = parlayDecimal(usable);
  const estimatedProb = parlayEstimatedProb(usable);
  const impliedProb = parlayImpliedProb(usable);

  const sizing = recommendStake({
    legs: usable,
    bankroll,
    estimatedProb,
    ...(isNum(kellyMultiplier) ? { kellyMultiplier } : {}),
    ...(isNum(softCapPct) ? { softCapPct } : {}),
    ...(isNum(hardCapPct) ? { hardCapPct } : {}),
  });

  return {
    legCount: usable.length,
    droppedLegs: legs.length - usable.length,
    decimal: dec,
    american: dec === null ? null : decimalToAmerican(dec),
    multiplier: dec,
    stake,
    payout: dec === null ? null : round2(dec * stake),
    profit: dec === null ? null : round2(dec * stake - stake),
    impliedProb,
    estimatedProb,
    requiredWinRate: impliedProb,
    requiredAccuracyPerLeg: requiredAccuracyPerLeg(usable),
    evPerUnit: parlayEvPerUnit(usable, estimatedProb),
    evOnStake: (() => {
      const ev = parlayEvPerUnit(usable, estimatedProb);
      return ev === null || !isNum(stake) ? null : round2(ev * stake);
    })(),
    correlatedGameIds: correlatedGameIds(usable),
    sizing,
  };
}

/**
 * Game ids that appear on more than one leg. Legs sharing a game are correlated,
 * which breaks the independence assumption -- and many books void such parlays
 * outright unless they are offered as an explicit same-game parlay.
 */
export function correlatedGameIds(legs) {
  const seen = new Map();
  for (const leg of legs) {
    if (!leg?.gameId) continue;
    seen.set(leg.gameId, (seen.get(leg.gameId) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

function round2(n) {
  return isNum(n) ? Math.round(n * 100) / 100 : null;
}
