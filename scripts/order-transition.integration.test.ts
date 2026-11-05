import './support/testEnv.js';
import test from 'node:test';
import { neonTestSkip } from './support/neonFixture.js';
import { verifyConcurrentOrderTransitions } from './support/orderTransitions.js';

test('order verification cannot overwrite a concurrent cancellation, verification or soft deletion', {
  skip: neonTestSkip, timeout: 90_000,
}, verifyConcurrentOrderTransitions);
