import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeEmail, validatePassword } from '../src/modules/auth/normalization.js';
import { registrationInput, loginInput, emailInput, actionInput } from '../src/modules/auth/contracts.js';

test('email normalization preserves display, dots and plus suffixes with IDNA domains', () => {
  assert.deepEqual(normalizeEmail('  First.Last+Tag@BÜCHER.example  '), {
    display: 'First.Last+Tag@BÜCHER.example', normalized: 'first.last+tag@xn--bcher-kva.example',
  });
  assert.notEqual(normalizeEmail('a.b@example.com').normalized, normalizeEmail('ab@example.com').normalized);
  assert.equal(normalizeEmail('משתמש@example.com').normalized, 'משתמש@example.com');
});

test('malformed email cannot reach account persistence or mail headers', () => {
  for (const email of ['a@b@c.com', '.a@example.com', 'a..b@example.com', 'a.@example.com',
    'a\r\nBcc:b@example.com', 'a b@example.com', 'a@example.com/path', 'a@-bad.example',
    'a@example..com', 'a@localhost', 'a@127.0.0.1', '\ud800@example.com', 'a@\udfff.example',
    'a'.repeat(65) + '@example.com', 'a@' + 'b'.repeat(64) + '.com']) {
    assert.throws(() => normalizeEmail(email), { code: 'BAD_REQUEST' }, email);
  }
});

test('password policy counts Unicode code points and preserves every supplied character', () => {
  for (const password of ['  a valid password  ', '😀'.repeat(15), 'e\u0301'.repeat(8), 'x'.repeat(128)]) {
    assert.equal(validatePassword(password), password);
  }
  for (const password of ['x'.repeat(14), '😀'.repeat(14), 'x'.repeat(129), '😀'.repeat(129),
    'x'.repeat(15) + '\ud800', '\udfff' + 'x'.repeat(15)]) {
    assert.throws(() => validatePassword(password), { code: 'BAD_REQUEST' });
  }
});

test('auth inputs reject unknown authority fields and never transform a password', () => {
  const input = { email: ' A+Tag@Example.com ', password: ' a long password ', fullName: ' Alice ' };
  assert.deepEqual(registrationInput.parse(input), {
    email: { display: 'A+Tag@Example.com', normalized: 'a+tag@example.com' },
    password: input.password, fullName: 'Alice',
  });
  for (const extra of [{ role: 'owner' }, { userId: 'chosen' }, { status: 'active' }, { emailConfirmedAt: 'now' }]) {
    assert.equal(registrationInput.safeParse({ ...input, ...extra }).success, false);
  }
  assert.equal(registrationInput.safeParse({ ...input, fullName: '<script>' }).success, false);
  assert.equal(loginInput.safeParse({ email: input.email, password: input.password }).success, true);
  assert.equal(loginInput.safeParse(input).success, false);
  assert.equal(emailInput.safeParse({ email: '\ud800@example.com' }).success, false);
  assert.equal(actionInput.safeParse({ token: Buffer.alloc(32, 7).toString('base64url') }).success, true);
  assert.equal(actionInput.safeParse({ token: 'a'.repeat(43) }).success, false);
});
