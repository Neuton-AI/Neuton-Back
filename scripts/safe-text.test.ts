/**
 * Unit cover for the shared stored-XSS guard (#116, `src/lib/safeText.ts`).
 *
 * The rule the whole fix rests on: `<` and `>` are the only characters every
 * HTML payload needs, so text without them cannot carry a tag. These tests pin
 * both halves of the helper — the schema wrapper the request DTOs use to
 * *reject* such values, and the stripper the paths that cannot reject
 * (model-extracted text, already-stored rows) use instead — so a change to the
 * rule cannot slip through behind the endpoint tests.
 */
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { HTML_SAFE_MESSAGE, htmlFree, isHtmlSafe, stripHtml } from '../src/lib/safeText.js';

function issuesOf(result: z.SafeParseReturnType<unknown, unknown>): z.ZodIssue[] {
  if (result.success) throw new Error('expected the parse to fail');
  return result.error.issues;
}

test('isHtmlSafe: plain text of every shape is allowed', () => {
  for (const value of [
    "Dana O'Brien",
    '12 HaYarkon St, Apt #4',
    'Ana & Sons "Catering" — 100% fresh',
    '2 + 2 = 4',
    'ყავა & პური',
  ]) {
    assert.equal(isHtmlSafe(value), true, value);
  }
});

test('isHtmlSafe: any angle bracket fails, however small', () => {
  assert.equal(isHtmlSafe('<'), false);
  assert.equal(isHtmlSafe('>'), false);
  assert.equal(isHtmlSafe('a < b'), false);
  assert.equal(isHtmlSafe('<script>alert(1)</script>'), false);
  assert.equal(isHtmlSafe('<img src=x onerror=alert(2)>'), false);
  assert.equal(isHtmlSafe('<svg onload=alert(3)>'), false);
});

test('htmlFree: a plain value parses and comes back trimmed, not rewritten', () => {
  const schema = htmlFree(z.string().trim().max(160));
  const parsed = schema.safeParse("  Dana O'Brien & Sons  ");
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data, "Dana O'Brien & Sons");
});

test('htmlFree: payloads fail with the shared message on the offending path', () => {
  const schema = z.object({
    customerName: htmlFree(z.string().trim().max(160)),
    note: z.string().optional(),
  });
  const issues = issuesOf(
    schema.safeParse({
      customerName: '<script>alert(1)</script><img src=x onerror=alert(2)>',
    }),
  );
  assert.equal(issues.length, 1);
  const issue = issues[0];
  assert.ok(issue, 'a single customerName issue is expected');
  assert.deepEqual(issue.path, ['customerName']);
  assert.equal(issue.message, HTML_SAFE_MESSAGE);
});

test('htmlFree: null and undefined still pass through the wrappers the DTOs chain', () => {
  const field = htmlFree(z.string().trim().max(300)).nullable().optional();
  assert.equal(field.safeParse(null).success, true);
  assert.equal(field.safeParse(undefined).success, true);
  assert.equal(field.safeParse('<svg onload=alert(3)>').success, false);

  const defaulted = htmlFree(z.string().trim().min(1).max(24)).default('portion');
  assert.equal(defaulted.safeParse(undefined).success, true, 'the default value itself is safe');
  const applied = defaulted.safeParse('<b>portion</b>');
  assert.equal(applied.success, false, 'a supplied value is still checked');
});

test('stripHtml: tags go, the text inside them stays', () => {
  assert.equal(stripHtml('<script>alert(1)</script>'), 'alert(1)');
  assert.equal(stripHtml('<b>Anna</b>'), 'Anna');
  assert.equal(stripHtml('<img src=x onerror=alert(2)>'), '');
  assert.equal(stripHtml('<svg onload=alert(3)>Anna'), 'Anna');
});

test('stripHtml: stray angle brackets are removed too, plain text is untouched', () => {
  assert.equal(stripHtml('a < b'), 'a  b');
  assert.equal(stripHtml("Dana O'Brien — 100% fresh"), "Dana O'Brien — 100% fresh");
  assert.equal(isHtmlSafe(stripHtml('<i>a</i> <b>b</b>')), true, 'output upholds the invariant');
});
