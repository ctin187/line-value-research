import test from 'node:test';
import assert from 'node:assert/strict';
import {
  americanToImplied, americanToDecimal, decimalToAmerican, probToAmerican,
  devig, overround, vigOf, edgePct, evPct, breakEvenProb, formatAmerican, formatPoint,
} from '../shared/odds.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);

test('implied probability matches the spec formulas', () => {
  // negative odds: |odds| / (|odds| + 100)
  close(americanToImplied(-110), 110 / 210);
  close(americanToImplied(-200), 200 / 300);
  // positive odds: 100 / (odds + 100)
  close(americanToImplied(150), 100 / 250);
  close(americanToImplied(100), 0.5);
  close(americanToImplied(-100), 0.5);
});

test('implied probability rejects impossible prices', () => {
  assert.equal(americanToImplied(0), null);
  assert.equal(americanToImplied(50), null);
  assert.equal(americanToImplied(-99), null);
  assert.equal(americanToImplied(NaN), null);
  assert.equal(americanToImplied('−110'), null);
});

test('decimal conversion round-trips', () => {
  close(americanToDecimal(-110), 1 + 100 / 110);
  close(americanToDecimal(150), 2.5);
  for (const price of [-500, -250, -110, -105, 100, 120, 275, 900]) {
    assert.equal(decimalToAmerican(americanToDecimal(price)), price);
  }
});

test('probToAmerican inverts americanToImplied', () => {
  for (const price of [-300, -150, -110, 110, 200, 450]) {
    const p = americanToImplied(price);
    assert.equal(probToAmerican(p), price);
  }
});

test('a standard -110/-110 market holds about 4.5%', () => {
  const probs = [americanToImplied(-110), americanToImplied(-110)];
  close(overround(probs), 220 / 210);
  close(vigOf(probs), (220 / 210 - 1) / (220 / 210));
  assert.ok(vigOf(probs) > 0.045 && vigOf(probs) < 0.046);
});

test('multiplicative de-vig normalises to exactly 1', () => {
  const fair = devig([americanToImplied(-110), americanToImplied(-110)]);
  close(fair[0], 0.5);
  close(fair[0] + fair[1], 1);

  const skewed = devig([americanToImplied(-250), americanToImplied(200)]);
  close(skewed[0] + skewed[1], 1);
  assert.ok(skewed[0] > skewed[1], 'the favourite keeps the larger share');
});

test('additive de-vig normalises but shades toward the favourite', () => {
  const probs = [americanToImplied(-250), americanToImplied(200)];
  const mult = devig(probs, 'multiplicative');
  const add = devig(probs, 'additive');
  close(add[0] + add[1], 1, 1e-9);
  // An equal absolute deduction costs the longshot a bigger share of its own
  // probability, so the favourite keeps more than under proportional de-vig.
  assert.ok(add[0] > mult[0], 'additive leaves more probability on the favourite');
  assert.ok(add[1] < mult[1], 'and correspondingly less on the underdog');
});

test('de-vig survives a one-sided market without throwing', () => {
  assert.deepEqual(devig([null, null]), [null, null]);
  const single = devig([americanToImplied(-110), null]);
  close(single[0], 1);
});

test('edge is the probability gap in percentage points', () => {
  // The worked example from the spec: 54% belief against a 51.7% line.
  const implied = americanToImplied(-107);
  close(edgePct(0.54, implied), (0.54 - implied) * 100, 1e-9);
  close(edgePct(0.54, 0.517), 2.3, 1e-9);
  assert.equal(edgePct(null, 0.5), null);
});

test('EV weights the same edge by the price', () => {
  // Two points of probability edge is worth far more on a dog than a favourite.
  const dog = evPct(americanToImplied(200) + 0.02, 200);
  const fav = evPct(americanToImplied(-300) + 0.02, -300);
  assert.ok(dog > fav, `${dog} should exceed ${fav}`);
  close(evPct(0.5, 100), 0);
});

test('break-even probability equals implied probability', () => {
  close(breakEvenProb(-110), americanToImplied(-110));
  close(breakEvenProb(240), americanToImplied(240));
});

test('formatting matches how books display prices', () => {
  assert.equal(formatAmerican(-110), '-110');
  assert.equal(formatAmerican(150), '+150');
  assert.equal(formatAmerican(null), '--');
  assert.equal(formatPoint(-3.5), '-3.5');
  assert.equal(formatPoint(3), '+3');
  assert.equal(formatPoint(45.5, { signed: false }), '45.5');
});
