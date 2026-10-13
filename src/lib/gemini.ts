import { canonicalUnit, parseNumber } from './measurements.js';
import { GoogleGenAI, type Part } from '@google/genai';
import { env } from '../env.js';
import { geminiLogger } from './logger/index.js';
import type { LogContext } from './logger/types.js';
import { isPermanentError, isUnknownModelError } from './jobErrors.js';
import { stripHtml } from './safeText.js';
import type { MediaKind } from './queue.js';

/**
 * Creates an AbortController that fires after the configured Gemini request timeout.
 * Used to enforce a hard deadline on the underlying HTTP call via AbortSignal.
 */
function createGeminiAbortSignal(): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Gemini request timed out after ${env.GEMINI_REQUEST_TIMEOUT_MS}ms`));
  }, env.GEMINI_REQUEST_TIMEOUT_MS);
  timer.unref(); // Don't prevent process exit while waiting
  // Clean up timer if aborted early
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/**
 * Vision models in fallback order. Google serves each model from its own
 * capacity pool, so a 503 on one frequently succeeds on another — that rotation
 * is the whole point. The walk is strictly in declared order: on failure the
 * next model is tried immediately, and the job-level retry budget belongs to
 * BullMQ, not to this loop.
 * Configurable via GEMINI_MODELS so the list can be retuned without a redeploy.
 */
const MODELS = env.GEMINI_MODELS.split(',')
  .map((m) => m.trim())
  .filter(Boolean);

if (MODELS.length === 0) {
  throw new Error('GEMINI_MODELS resolved to an empty model list');
}

export interface ExtractedLineItem {
  rawSku?: string | null;
  packageQuantity?: number | null;
  packageUnit?: string | null;
  packagesPerPurchase?: number | null;
  rawName: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  confidence: number | null;
}

export interface ReceiptExtraction {
  merchantName: string | null;
  receiptDate: string | null;
  totalAmount: number | null;
  taxAmount: number | null;
  currency: string | null;
  items: ExtractedLineItem[];
}

export interface RecipeIngredient {
  qualifier?: string | null;
  convention?: string | null;
  conventionEvidence?: string | null;
  alternatives?: string[];
  alternateMeasurements?: { quantity: number | null; unit: string | null }[];
  rawName: string;
  searchAbleName?: string | null;
  quantity: number | null;
  unit: string | null;
}

export interface RecipeExtraction {
  name: string | null;
  description: string | null;
  prepTimeMinutes: number | null;
  yieldQuantity: number | null;
  yieldUnit: string | null;
  allergens: string[];
  instructions: string | null;
  ingredients: RecipeIngredient[];
}

export interface OrderExtraction {
  customerName: string | null;
  destinationAddress: string | null;
  items: { name: string; quantity: number | null; unitPrice: number | null }[];
}

const RECEIPT_SCHEMA = `{
  "type": "object",
  "properties": {
    "merchantName": { "type": "string" },
    "receiptDate": { "type": "string", "description": "ISO date YYYY-MM-DD" },
    "totalAmount": { "type": "number" },
    "taxAmount": { "type": "number" },
    "currency": { "type": "string", "description": "ISO 4217, 3 letters" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "rawName": { "type": "string" },
          "rawSku": {"type": "string"},
          "packageQuantity": {"type": "number"},
          "packageUnit": {"type": "string"},
          "packagesPerPurchase": {"type": "number"},
          "quantity": { "type": "number" },
          "unit": { "type": "string" },
          "unitPrice": { "type": "number" },
          "totalPrice": { "type": "number" },
          "confidence": { "type": "number" }
        },
        "required": ["rawName", "rawSku", "quantity", "unit", "unitPrice", "totalPrice", "confidence"]
      }
    }
  },
  "required": ["items", "receiptDate", "merchantName", "totalAmount", "taxAmount", "currency"]
}`;

const RECIPE_SCHEMA = `{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "description": { "type": "string" },
    "prepTimeMinutes": { "type": "number" },
    "yieldQuantity": { "type": "number" },
    "yieldUnit": { "type": "string" },
    "allergens": { "type": "array", "items": { "type": "string" } },
    "instructions": { "type": "string" },
    "ingredients": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "rawName": { "type": "string" },
          "searchAbleName": { "type": "string" },
          "qualifier": {"type": "string"},
          "convention": {"type": "string", "enum": ["us", "metric", "imperial"]},
          "conventionEvidence": {"type": "string", "description": "Exact source quotation explicitly establishing the measurement convention; null when not stated"},
          "alternatives": {"type": "array", "items": {"type": "string"}},
          "alternateMeasurements": {"type": "array", "items": {"type": "object", "properties": {"quantity": {"type": "number"}, "unit": {"type": "string"}}}},
          "quantity": { "type": "number" },
          "unit": { "type": "string" }
        },
        "required": ["rawName", "searchAbleName", "quantity", "unit"]
      }
    }
  },
  "required": ["name", "ingredients", "instructions", "prepTimeMinutes", "yieldQuantity", "yieldUnit", "allergens"]
}`;

const ORDER_SCHEMA = `{
  "type": "object",
  "properties": {
    "customerName": { "type": "string" },
    "destinationAddress": { "type": "string" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "quantity": { "type": "number" },
          "unitPrice": { "type": "number" }
        },
        "required": ["name"]
      }
    }
  },
  "required": ["items"]
}`;

const EXTRACT_RECEIPT_PROMPT = `Extract this shopping receipt.
Read every purchased line, including Hebrew right-to-left receipts. Keep each product name paired with its own code, quantity, price and paid total; the code and quantity/price can appear directly below the name. Never attach that row to the following product.
Copy the full product name in the document's language. Exclude transaction, card and merchant identifiers from product codes.
Preserve rawSku as a string, including leading zeros. Separate package count, packageQuantity/packageUnit (contents per inner package), and packagesPerPurchase (multipack count). For weighed purchases keep the measured quantity and its unit. Never infer package contents from price. Return all receipt fields.
The receipt quantity "units" describes purchased packages, not the weight or volume inside them. Leave package contents null unless printed explicitly. Do not turn an unknown food package into contents 1 each. Contents printed in a product name belong only to that product.
Check the alignment across the entire row: name on the right, code near the middle, price and paid total on the left. A quantity × price continuation immediately below belongs to the product above it, not to the next name. Reconcile the sum of paid line totals with the receipt total. Numeric-only text is not an additional product. Missing quantity is null, never default 1.
Use null for anything you cannot read. Never invent values.`;

const EXTRACT_RECIPE_PROMPT = `Extract the recipe without inventing missing values. Preserve all separate ingredient lines.
Read every bullet under the ingredient heading (including Hebrew מצרכים), even when fractions or units are visually split by right-to-left layout. Return a populated ingredients array for a readable ingredient list. Copy ingredient names in the document's language.
Use an explicit gram weight in preference to an accompanying cup measurement; preserve alternateMeasurements.
Preserve numeric fractions exactly: 1/4 = 0.25. Two large eggs = quantity 2, unit each, qualifier large.
Separate preparation/size qualifiers from the measurement unit. Preserve all alternatives as an array including the first named choice, never silently select a substitute.
Keep searchAbleName clean of measures/instructions, retaining ingredient attributes. When alternatives are not chosen leave searchAbleName null.
Record a measurement convention only if the document explicitly establishes it, and quote that text in conventionEvidence; otherwise both are null. The document's language or ingredient weights do not establish a cup/spoon convention. Missing quantity, unit or yield stays null.`;

const PROMPTS: Record<MediaKind, { instruction: string; schema: string }> = {
  receipt: {
    instruction: EXTRACT_RECEIPT_PROMPT,
    schema: RECEIPT_SCHEMA,
  },
  recipe: {
    instruction: EXTRACT_RECIPE_PROMPT,
    schema: RECIPE_SCHEMA,
  },
  product: {
    instruction:
      'Extract this finished food or packaged product photo. Return a short product name, description, approximate preparation time in minutes and the ingredient list you can infer. Use null for anything you cannot read. Never invent values.',
    schema: RECIPE_SCHEMA,
  },
  order: {
    instruction:
      'Extract this customer order document or catering order sheet. Return the customer name, the destination address if printed, and each ordered line with its quantity and unit price. Use null for anything you cannot read. Never invent values.',
    schema: ORDER_SCHEMA,
  },
};

const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/**
 * Coerces a model-returned value to a finite number, or null when unreadable.
 * Models frequently ignore `responseSchema` and answer numerics as strings
 * (`"3.00"`, `"1,290.50"`, `"₪12.90"`), so strings are stripped of currency
 * symbols, grouping commas and whitespace before parsing. Anything
 * unparseable stays null — never invented, never zero.
 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^(?:[₪$€£]|ILS|NIS|USD)\s*/, '').replace(/\s*(?:ILS|NIS|USD|₪)$/, '');
    return parseNumber(cleaned.replace(/(?<=\d),(?=\d{3}(?:,|\.|$))/g, ''));
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Model output is untrusted — a receipt or order image can carry markup the
  // model happily echoes back, so it is stripped here, at the trust boundary,
  // before any extraction value can reach a table (issue #116).
  const cleaned = stripHtml(value).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function parseJson<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  return JSON.parse(cleaned) as T;
}

/**
 * Raised when a model answers but the payload is unusable (empty text, or JSON
 * that will not parse). Distinct from an API error: nothing is wrong with the
 * request, the model just did not honour the response schema. Worth another
 * model, because older vision models often ignore `responseSchema` outright.
 */
class UnusableResponseError extends Error {
  constructor(
    readonly model: string,
    readonly reason: string,
  ) {
    super(`model ${model} ${reason}`);
    this.name = 'UnusableResponseError';
  }
}

/**
 * Walks `models` in declared order, first to last, advancing to the next model
 * on every non-permanent failure. There is no randomness, no shared memory of
 * which models recently failed, and no sleep between models: a model that just
 * 429'd hands over to the next one immediately.
 *
 * Exhaustion always throws. The retry budget belongs to BullMQ, so the throw
 * ends this attempt and the next job attempt restarts the walk from the first
 * model.
 *
 * `call` is injected so the policy is unit-testable without a Gemini key or a
 * network, which is why this lives beside the client rather than around it.
 */
export async function walkModels<T>(
  models: readonly string[],
  call: (model: string) => Promise<T>,
  context: LogContext = {},
): Promise<T> {
  let lastError: unknown;
  // A walk where *every* model answered "not found" never got a single usable
  // response, so the list itself is misconfigured rather than the parse failing.
  let everyFailureWasUnknownModel = true;

  for (let attempt = 1; attempt <= models.length; attempt++) {
    const model = models[attempt - 1]!;
    const attemptContext = geminiLogger.child({ ...context, model, attempt });
    const startedAt = Date.now();
    try {
      const result = await call(model);
      attemptContext.info({ durationMs: Date.now() - startedAt }, 'gemini model call succeeded');
      return result;
    } catch (error) {
      // Auth, billing, malformed requests and oversize payloads fail
      // identically on every model, so they end the job immediately instead of
      // burning the rest of the list.
      const fatal = isPermanentError(error);
      if (fatal) throw error;

      lastError = error;
      if (!isUnknownModelError(error)) everyFailureWasUnknownModel = false;

      attemptContext.warn({ err: error }, 'gemini model failed, trying the next model');
    }
  }

  if (everyFailureWasUnknownModel) {
    // Plain language: the raw upstream payload names the project and leaks
    // account internals, and the actionable part is the list, not the parse.
    throw new Error(
      `No available vision model. Tried and rejected as unavailable: ${[...models].join(', ')}. Update GEMINI_MODELS.`,
    );
  }
  throw lastError;
}

/**
 * Calls one model with the shared structured-extraction contract, or throws:
 * an unusable answer is just another reason to advance to the next model.
 */
async function runStructured<T>(kind: MediaKind, part: Part, context?: LogContext): Promise<T> {
  const { instruction, schema } = PROMPTS[kind];

  return walkModels(
    MODELS,
    async (model) => {
      const abortSignal = createGeminiAbortSignal();
      const response = await client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [part, { text: instruction }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: JSON.parse(schema) as unknown as Record<string, unknown>,
          temperature: 0.1,
          abortSignal,
        },
      });

      const text = response.text;
      if (!text) throw new UnusableResponseError(model, 'returned no text');
      const parsed = parseJson<T>(text);
      const lines = (parsed as Record<string, unknown>)[kind === 'recipe' || kind === 'product' ? 'ingredients' : 'items'];
      if (!Array.isArray(lines) || lines.length === 0) throw new UnusableResponseError(model, 'returned no document lines');
      return parsed;
    },
    context,
  );
}

export async function extractReceipt(
  inlineData: { mimeType: string; data: string },
  context?: LogContext,
): Promise<ReceiptExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>(
    'receipt',
    {
      inlineData,
    },
    context,
  );

  return mapReceiptExtraction(raw);
}

export function mapReceiptExtraction(raw: Record<string, unknown>): ReceiptExtraction {
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    merchantName: asString(raw.merchantName),
    receiptDate: asString(raw.receiptDate),
    totalAmount: asNumber(raw.totalAmount),
    taxAmount: asNumber(raw.taxAmount),
    currency: asString(raw.currency)?.toUpperCase() ?? null,
    items: items.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        rawName: asString(item.rawName) ?? 'Unknown item',
        rawSku: asString(item.rawSku),
        packageQuantity: asNumber(item.packageQuantity),
        packageUnit: asString(item.packageUnit),
        packagesPerPurchase: asNumber(item.packagesPerPurchase),
        quantity: asNumber(item.quantity),
        unit: asString(item.unit),
        unitPrice: asNumber(item.unitPrice),
        totalPrice: asNumber(item.totalPrice),
        confidence: asNumber(item.confidence),
      };
    }),
  };
}

export async function extractRecipe(
  inlineData: { mimeType: string; data: string },
  context?: LogContext,
): Promise<RecipeExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('recipe', { inlineData }, context);

  return mapRecipeExtraction(raw);
}

export function mapRecipeExtraction(raw: Record<string, unknown>): RecipeExtraction {
  const ingredients = Array.isArray(raw.ingredients) ? raw.ingredients : [];
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    prepTimeMinutes: asNumber(raw.prepTimeMinutes),
    yieldQuantity: asNumber(raw.yieldQuantity),
    yieldUnit: asString(raw.yieldUnit),
    allergens: Array.isArray(raw.allergens)
      ? raw.allergens
        .filter((a): a is string => typeof a === 'string')
        .map((a) => stripHtml(a).trim())
        .filter((a) => a.length > 0)
      : [],
    instructions: asString(raw.instructions),
    ingredients: ingredients.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      let quantity = asNumber(item.quantity);
      let unit = asString(item.unit);
      let qualifier = asString(item.qualifier);
      const conventionEvidence = asString(item.conventionEvidence);
      const convention = conventionEvidence && ['us', 'metric', 'imperial'].includes(String(item.convention)) ? asString(item.convention) : null;
      const alternatives = Array.isArray(item.alternatives) ? item.alternatives.map(asString).filter((v): v is string => v !== null) : [];
      const primaryName = asString(item.searchAbleName);
      if (alternatives.length && primaryName && !alternatives.includes(primaryName)) alternatives.unshift(primaryName);
      const alternateMeasurements = Array.isArray(item.alternateMeasurements)
        ? item.alternateMeasurements.map(value => {
          const alternate = (value ?? {}) as Record<string, unknown>;
          return { quantity: asNumber(alternate.quantity), unit: asString(alternate.unit) };
        }) : [];
      // Printed mass takes precedence over a model-selected cup/spoon equivalent.
      // Keep both weights if they disagree so costing can require review.
      const explicitWeight = alternateMeasurements.find(value => value.quantity !== null &&
        value.quantity > 0 && ['g', 'kg', 'oz', 'lb'].includes(canonicalUnit(value.unit) ?? ''));
      if (explicitWeight && !['g', 'kg', 'oz', 'lb'].includes(canonicalUnit(unit) ?? '')) {
        alternateMeasurements.unshift({ quantity, unit });
        alternateMeasurements.splice(alternateMeasurements.indexOf(explicitWeight), 1);
        quantity = explicitWeight.quantity;
        unit = explicitWeight.unit;
      }
      // Older model responses used egg size as the unit. Size is a qualifier.
      if (/^(?:small|medium|large|extra large)$/i.test(unit ?? '') &&
        /(?:\beggs?\b|ביצ)/i.test(asString(item.searchAbleName) ?? asString(item.rawName) ?? '')) {
        qualifier ??= unit;
        unit = 'each';
      }
      return {
        rawName: asString(item.rawName) ?? 'Unknown ingredient',
        searchAbleName: asString(item.searchAbleName),
        qualifier,
        convention,
        conventionEvidence,
        alternatives,
        alternateMeasurements,
        quantity,
        unit,
      };
    }),
  };
}

export async function extractOrder(
  inlineData: { mimeType: string; data: string },
  context?: LogContext,
): Promise<OrderExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('order', { inlineData }, context);

  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    customerName: asString(raw.customerName),
    destinationAddress: asString(raw.destinationAddress),
    items: items.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        name: asString(item.name) ?? 'Unknown item',
        quantity: asNumber(item.quantity),
        unitPrice: asNumber(item.unitPrice),
      };
    }),
  };
}
