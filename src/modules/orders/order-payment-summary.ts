import type { OrderPaymentDto, OrderPaymentSummary } from './contracts.js';

type Payment = Pick<OrderPaymentDto, 'kind' | 'amount'> & { occurredAt: Date };

export function minorUnits(amount: string): bigint {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(amount)) {
    throw new RangeError('Expected a decimal amount with at most two fractional digits.');
  }
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(`${whole}${fraction.padEnd(2, '0')}`);
}

function formatMinorUnits(amount: bigint): string {
  const digits = amount.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function summarizeOrderPayments(
  orderStatus: string,
  totalAmount: string,
  payments: readonly Payment[],
): OrderPaymentSummary {
  let received = 0n;
  let refunded = 0n;
  let deposits = 0n;
  let firstDeposit: Date | null = null;
  for (const payment of payments) {
    const amount = minorUnits(payment.amount);
    if (payment.kind === 'refund') {
      refunded += amount;
      continue;
    }
    received += amount;
    if (payment.kind === 'deposit') {
      deposits += amount;
      if (!firstDeposit || payment.occurredAt < firstDeposit) firstDeposit = payment.occurredAt;
    }
  }

  let status: OrderPaymentSummary['status'] = 'unpaid';
  let balanceDue = 0n;
  let refundDue = 0n;
  if (orderStatus === 'cancelled') {
    if (received > refunded) {
      refundDue = received - refunded;
      status = 'pending_refund';
    } else if (received > 0n) {
      status = 'refunded';
    }
  } else {
    const billed = totalAmount === 'NaN' ? 0n : minorUnits(totalAmount);
    if (billed <= received) {
      status = 'paid';
    } else {
      balanceDue = billed - received;
      if (received > 0n) status = 'deposited';
    }
  }

  return {
    status,
    totalReceived: formatMinorUnits(received),
    balanceDue: formatMinorUnits(balanceDue),
    refundDue: formatMinorUnits(refundDue),
    depositAmount: formatMinorUnits(deposits),
    depositDate: firstDeposit?.toISOString() ?? null,
  };
}
