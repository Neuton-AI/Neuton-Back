import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { asNumber } from '../src/lib/gemini.js';

// Regression cover for N-101: the vision model frequently answers numerics as
// strings despite `responseSchema`, and the old `typeof === 'number'` check
// nulled every one of them — which the UI then rendered as $0.00 per line.
test('asNumber: real numbers pass through untouched', async () => {
  assert.equal(asNumber(3.5), 3.5);
  assert.equal(asNumber(0), 0);
  assert.equal(asNumber(-12.9), -12.9);
});

test('asNumber: non-finite numbers are null, never stored', async () => {
  assert.equal(asNumber(NaN), null);
  assert.equal(asNumber(Infinity), null);
});

test('asNumber: plain numeric strings coerce', async () => {
  assert.equal(asNumber('3.00'), 3);
  assert.equal(asNumber(' 1.50 '), 1.5);
  assert.equal(asNumber('-12.9'), -12.9);
});

test('asNumber: currency symbols and grouping commas are stripped', async () => {
  assert.equal(asNumber('₪12.90'), 12.9);
  assert.equal(asNumber('$1,290.50'), 1290.5);
  assert.equal(asNumber('ILS 7'), 7);
});

test('asNumber: the unknowable stays null', async () => {
  assert.equal(asNumber(null), null);
  assert.equal(asNumber(undefined), null);
  assert.equal(asNumber(''), null);
  assert.equal(asNumber('—'), null);
  assert.equal(asNumber('n/a'), null);
  assert.equal(asNumber({}), null);
  assert.equal(asNumber(true), null);
});
