import { badRequest } from './errors.js';

const UNITS: Record<string, { dimension: string; factor: number }> = {
  g: { dimension: 'mass', factor: 1 },
  kg: { dimension: 'mass', factor: 1000 },
  ml: { dimension: 'volume', factor: 1 },
  l: { dimension: 'volume', factor: 1000 },
  each: { dimension: 'count', factor: 1 },
  unit: { dimension: 'count', factor: 1 },
};

/** Retain existing stock when a reviewer changes between compatible base units. */
export function convertInventoryAmount(amount: number, from: string, to: string): number {
  if (from === to || amount === 0) return amount;
  const source = UNITS[from];
  const target = UNITS[to];
  if (!source || !target || source.dimension !== target.dimension) {
    throw badRequest(`Cannot convert inventory from ${from} to ${to}`);
  }
  return amount * source.factor / target.factor;
}

/** Unweighted SMA; keep purchase samples so the oldest can leave the window. */
export function addBaseUnitCostSample(samples: number[], cost: number): number {
  samples.unshift(cost);
  samples.splice(20);
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}
