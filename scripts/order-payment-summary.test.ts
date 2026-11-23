import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeOrderPayments } from '../src/modules/orders/order-payment-summary.js';

const deposit = { kind: 'deposit', amount: '50.10', occurredAt: new Date('2026-11-20T08:00:00Z') } as const;
const secondDeposit = { kind: 'deposit', amount: '0.20', occurredAt: new Date('2026-11-19T08:00:00Z') } as const;
const payment = { kind: 'payment', amount: '149.70', occurredAt: new Date('2026-11-21T08:00:00Z') } as const;

test('payment totals stay exact and the earliest deposit date is preserved when the billed total changes', () => {
  const history = [deposit, payment, secondDeposit];
  assert.deepEqual(summarizeOrderPayments('processing', '200.00', history), {
    status: 'paid', totalReceived: '200.00', balanceDue: '0.00', refundDue: '0.00',
    depositAmount: '50.30', depositDate: '2026-11-19T08:00:00.000Z',
  });
  const raised = summarizeOrderPayments('processing', '240.01', history);
  assert.equal(raised.status, 'deposited');
  assert.equal(raised.balanceDue, '40.01');
  assert.equal(raised.totalReceived, '200.00');
  const lowered = summarizeOrderPayments('processing', '199.00', history);
  assert.equal(lowered.status, 'paid');
  assert.equal(lowered.balanceDue, '0.00');
  assert.equal(lowered.totalReceived, '200.00');
});

test('legacy orders have no inferred deposits and active zero totals are paid', () => {
  assert.deepEqual(summarizeOrderPayments('delivered', '25.60', []), {
    status: 'unpaid', totalReceived: '0.00', balanceDue: '25.60', refundDue: '0.00',
    depositAmount: '0.00', depositDate: null,
  });
  assert.equal(summarizeOrderPayments('processing', '0.00', []).status, 'paid');
  assert.equal(summarizeOrderPayments('cancelled', '0.00', []).status, 'unpaid');
});

test('cancellation owes the full amount received until it has been refunded', () => {
  const cancelled = summarizeOrderPayments('cancelled', '240.00', [deposit]);
  assert.equal(cancelled.status, 'pending_refund');
  assert.equal(cancelled.balanceDue, '0.00');
  assert.equal(cancelled.refundDue, '50.10');
  const refund = { ...deposit, kind: 'refund' } as const;
  const refunded = summarizeOrderPayments('cancelled', '240.00', [deposit, refund]);
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refundDue, '0.00');
  assert.equal(refunded.totalReceived, '50.10');
});

test('payment summaries reject a three-decimal billed total', () => {
  assert.throws(() => summarizeOrderPayments('processing', '0.123', []), RangeError);
});

test('payment summaries reject three-decimal entries in payment history', () => {
  const excessivePrecision = { ...deposit, amount: '1.234' };
  assert.throws(() => summarizeOrderPayments('cancelled', '240.00', [excessivePrecision]), RangeError);
});
