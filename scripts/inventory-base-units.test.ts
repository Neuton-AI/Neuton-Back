import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogApp } from './support/catalogApp.js';

test('inventory creation rejects missing or null base unit fields before writing', async () => {
  const harness = await buildCatalogApp();
  try {
    for (const field of ['baseUnit', 'baseUnitAmount', 'baseUnitCost']) {
      for (const value of [undefined, null]) {
        const payload: Record<string, unknown> = {
          name: 'Flour', unit: 'kg', baseUnit: 'g', baseUnitAmount: 1000, baseUnitCost: 0.123456,
        };
        if (value === undefined) delete payload[field];
        else payload[field] = value;
        const response = await harness.app.inject({ method: 'POST', url: '/api/v1/inventory', payload });
        assert.equal(response.statusCode, 400, `${field}=${String(value)}`);
        assert.equal(response.json().error.code, 'VALIDATION_ERROR');
      }
    }
  } finally { await harness.close(); }
});
