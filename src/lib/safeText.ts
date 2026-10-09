import { z } from 'zod';

/**
 * Shared defence against stored HTML/XSS (issue #116).
 *
 * These columns hold plain text — names, addresses, labels — never markup, so
 * the invariant is simple: `<` and `>` are the only characters every HTML
 * payload needs, and text that carries none of them cannot carry a tag. The
 * API *rejects* such values (clear feedback, nothing silently rewritten);
 * paths that must not fail the write — model-extracted text, rows persisted
 * before this guard existed — *strip* them instead.
 */
export const HTML_SAFE_MESSAGE = 'HTML markup is not allowed';

/** True when the value contains no angle brackets and therefore no HTML. */
export function isHtmlSafe(value: string): boolean {
  return !/[<>]/.test(value);
}

/**
 * Removes `<…>` tag sequences first, so text a tag wraps survives, then any
 * stray angle brackets — leaving the same `<`-free invariant `htmlFree`
 * enforces on input. Used at write points that cannot reject the value.
 */
export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
}

/**
 * Wraps a string schema so values containing `<` or `>` fail validation.
 * The ZodError surfaces through the standard handler as a 400
 * `VALIDATION_ERROR` naming the offending field.
 *
 * ```ts
 * customerName: htmlFree(z.string().trim().max(160)).nullable().optional(),
 * ```
 */
export function htmlFree<S extends z.ZodType<string>>(schema: S): z.ZodEffects<S> {
  return schema.refine(isHtmlSafe, { message: HTML_SAFE_MESSAGE });
}
