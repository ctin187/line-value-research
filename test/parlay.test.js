import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parlayDecimal, parlayAmerican, parlayPayout, parlayProfit, parlayImpliedProb,
  parlayEstimatedProb, requiredWinRate, requiredAccuracyPerLeg, kellyFraction,
  recommendStake, quoteParlay, correlatedGameIds,
} from '../shared/parlay.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);

const threeStandardLegs = [{ price: -110 }, { price: -110 }, { price: -110 }];

test('three -110 legs make the familiar +596 parlay', () => {
  close(parlayDecimal(threeStandardLegs), Math.pow(1 + 100 / 110, 3));
  assert.equal(parlayAmerican(threeStandardLegs), 596);
});

test('payout and profit follow the multiplier', () => {
  const dec = parlayDecimal(threeStandardLegs);
  close(parlayPayout(threeStandardLegs, 100), dec * 100);
  close(parlayProfit(threeStandardLegs, 100), dec * 100 - 100);
});

test('an unusable price invalidates the whole parlay', () => {
  assert.equal(parlayDecimal([{ price: -110 }, { price: 0 }]), null);
  assert.equal(parlayDecimal([]), null);
  assert.equal(parlayDecimal(null), null);
});

test('required accuracy per leg is the straight-bet break-even', () => {
  // Parlaying does not change the per-leg bar -- only the variance.
  close(requiredAccuracyPerLeg(threeStandardLegs), 110 / 210, 1e-12);
  close(requiredWinRate(threeStandardLegs), parlayImpliedProb(threeStandardLegs));
  close(requiredWinRate(threeStandardLegs), Math.pow(110 / 210, 3), 1e-12);
});

test('legs without an estimate fall back to their implied probability', () => {
  close(parlayEstimatedProb(threeStandardLegs), Math.pow(110 / 210, 3), 1e-12);
  const withEstimates = threeStandardLegs.map((l) => ({ ...l, estimatedProb: 0.55 }));
  close(parlayEstimatedProb(withEstimates), 0.55 ** 3, 1e-12);
});

test('kelly is zero when there is no edge and never negative', () => {
  const dec = parlayDecimal(threeStandardLegs);
  assert.equal(kellyFraction(0.05, dec), 0);
  assert.ok(kellyFraction(0.25, dec) > 0);
  // The textbook single-bet case: 60% at even money is a 20% full-Kelly bet.
  close(kellyFraction(0.6, 2), 0.2, 1e-12);
});

test('stake sizing is fractional Kelly, hard-capped at the risk limit', () => {
  const legs = threeStandardLegs.map((l) => ({ ...l, estimatedProb: 0.58 }));
  const sized = recommendStake({ legs, bankroll: 1000 });
  assert.ok(sized.stake > 0);
  assert.ok(sized.fraction <= 0.05 + 1e-12, 'never exceeds the 5% hard cap');
  // Stakes are rounded to the cent, so compare at that resolution.
  close(sized.stake, sized.fraction * 1000, 0.005);

  // A monster edge must still be capped rather than betting the roll.
  const greedy = recommendStake({
    legs: [{ price: 200, estimatedProb: 0.9 }],
    bankroll: 1000,
  });
  assert.equal(greedy.capped, true);
  close(greedy.fraction, 0.05);
  close(greedy.stake, 50);
});

test('no edge means no stake', () => {
  const legs = threeStandardLegs.map((l) => ({ ...l, estimatedProb: 0.45 }));
  const sized = recommendStake({ legs, bankroll: 1000 });
  assert.equal(sized.stake, 0);
  assert.equal(sized.reason, 'no-edge');
});

test('quoteParlay reports every number the panel shows', () => {
  const legs = [
    { id: 'a', price: -110, estimatedProb: 0.55, gameId: 'g1' },
    { id: 'b', price: 145, estimatedProb: 0.45, gameId: 'g2' },
  ];
  const q = quoteParlay({ legs, stake: 50, bankroll: 2000 });

  assert.equal(q.legCount, 2);
  assert.equal(q.droppedLegs, 0);
  close(q.decimal, (1 + 100 / 110) * 2.45, 1e-12);
  close(q.payout, Math.round(q.decimal * 50 * 100) / 100, 1e-9);
  close(q.estimatedProb, 0.55 * 0.45, 1e-12);
  close(q.impliedProb, 1 / q.decimal, 1e-12);
  assert.ok(q.evPerUnit > 0, 'this pair of estimates is +EV');
  assert.deepEqual(q.correlatedGameIds, []);
  assert.ok(q.sizing.stake > 0);
});

test('quoteParlay drops unusable legs instead of returning nulls', () => {
  const q = quoteParlay({ legs: [{ price: -110 }, { price: 42 }], stake: 10, bankroll: 100 });
  assert.equal(q.legCount, 1);
  assert.equal(q.droppedLegs, 1);
  assert.ok(Number.isFinite(q.decimal));
});

test('legs from the same game are reported as correlated', () => {
  const legs = [
    { price: -110, gameId: 'g1' },
    { price: -110, gameId: 'g1' },
    { price: -110, gameId: 'g2' },
  ];
  assert.deepEqual(correlatedGameIds(legs), ['g1']);
  assert.deepEqual(quoteParlay({ legs, stake: 10, bankroll: 100 }).correlatedGameIds, ['g1']);
});

test('an empty slip produces a zero quote rather than throwing', () => {
  const q = quoteParlay({ legs: [], stake: 10, bankroll: 100 });
  assert.equal(q.legCount, 0);
  assert.equal(q.decimal, null);
  assert.equal(q.sizing.stake, 0);
});
