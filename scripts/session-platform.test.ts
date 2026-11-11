import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { platformFromUserAgent } from '../src/modules/identity/session-platform.js';

test('session platform comes from the browser user agent', () => {
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36';
  const chromebook = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

  assert.equal(platformFromUserAgent(windows), 'Windows');
  assert.equal(platformFromUserAgent(mac), 'Mac');
  assert.equal(platformFromUserAgent(iphone), 'iPhone');
  assert.equal(platformFromUserAgent(ipad), 'iPad');
  assert.equal(platformFromUserAgent(android), 'Android');
  assert.equal(platformFromUserAgent(chromebook), 'Chromebook');
  assert.equal(platformFromUserAgent(linux), 'Linux');
  assert.equal(platformFromUserAgent(undefined), 'Unknown');
  assert.equal(platformFromUserAgent('not a browser'), 'Unknown');
});
