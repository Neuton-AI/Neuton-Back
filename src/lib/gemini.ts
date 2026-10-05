import { GoogleGenAI, type Part } from '@google/genai';
import pino from 'pino';
import { env, isDevelopment } from '../env.js';
import { isPermanentError, isUnknownModelError } from './jobErrors.js';
import type { MediaKind } from './queue.js';

const logger = pino({
  // Silent in tests: the model walk warns once per failure, which would bury
  // the assertion output. Same reason worker.ts silences itself under NODE_ENV=test.
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  // pino-pretty logs through a worker thread, so it is limited to development;
  // tests and CI use plain JSON and the process is free to exit.
  ...(isDevelopment ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
});

/**
 * Creates a promise that rejects after the configured Gemini request timeout.
 * Used to enforce a hard deadline on the underlying HTTP call since the
 * Google GenAI SDK does not yet accept an AbortSignal on generateContent.
 */
function createGeminiTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Gemini request timed out after ${env.GEMINI_REQUEST_TIMEOUT_MS}ms`));
    }, env.GEMINI_REQUEST_TIMEOUT_MS);
    timer.unref(); // Don't prevent process exit while waiting
  });
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

export interface RecipeExtraction {
  name: string | null;
  description: string | null;
  prepTimeMinutes: number | null;
  yieldQuantity: number | null;
  yieldUnit: string | null;
  allergens: string[];
  instructions: string | null;
  ingredients: { rawName: string; quantity: number | null; unit: string | null }[];
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
          "quantity": { "type": "number" },
          "unit": { "type": "string" },
          "unitPrice": { "type": "number" },
          "totalPrice": { "type": "number" },
          "confidence": { "type": "number" }
        },
        "required": ["rawName"]
      }
    }
  },
  "required": ["items"]
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
          "quantity": { "type": "number" },
          "unit": { "type": "string" }
        },
        "required": ["rawName"]
      }
    }
  },
  "required": ["name", "ingredients"]
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

const PROMPTS: Record<MediaKind, { instruction: string; schema: string }> = {
  receipt: {
    instruction:
      'Extract this shopping receipt. Return the merchant name, purchase date, grand total, tax, currency, and every purchased line item with its quantity, unit, unit price and line total. Use null for anything you cannot read. Never invent values.',
    schema: RECEIPT_SCHEMA,
  },
  recipe: {
    instruction:
      'Extract this recipe (handwritten or printed). Return the recipe name, short description, preparation time in minutes, how many portions it yields and their unit, the allergen list, the preparation instructions, and every ingredient with its quantity and unit. Use null for anything you cannot read. Never invent values.',
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

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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
): Promise<T> {
  let lastError: unknown;
  // A walk where *every* model answered "not found" never got a single usable
  // response, so the list itself is misconfigured rather than the parse failing.
  let everyFailureWasUnknownModel = true;

  for (const model of models) {
    try {
      return await call(model);
    } catch (error) {
      // Auth, billing, malformed requests and oversize payloads fail
      // identically on every model, so they end the job immediately instead of
      // burning the rest of the list.
      const fatal = isPermanentError(error);
      if (fatal) throw error;

      lastError = error;
      if (!isUnknownModelError(error)) everyFailureWasUnknownModel = false;

      logger.warn({ model, err: error }, 'gemini model failed, trying the next model');
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
async function runStructured<T>(kind: MediaKind, part: Part): Promise<T> {
  const { instruction, schema } = PROMPTS[kind];

  return walkModels(MODELS, async (model) => {
    const response = await Promise.race([
      client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [part, { text: instruction }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: JSON.parse(schema) as unknown as Record<string, unknown>,
          temperature: 0.1,
        },
      }),
      createGeminiTimeout(),
    ]);

    const text = response.text;
    if (!text) throw new UnusableResponseError(model, 'returned no text');
    return parseJson<T>(text);
  });
}

export async function extractReceipt(
  inlineData: { mimeType: string; data: string },
): Promise<ReceiptExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('receipt', {
    inlineData,
  });

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
): Promise<RecipeExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('recipe', { inlineData });

  const ingredients = Array.isArray(raw.ingredients) ? raw.ingredients : [];
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    prepTimeMinutes: asNumber(raw.prepTimeMinutes),
    yieldQuantity: asNumber(raw.yieldQuantity),
    yieldUnit: asString(raw.yieldUnit),
    allergens: Array.isArray(raw.allergens)
      ? raw.allergens.filter((a): a is string => typeof a === 'string')
      : [],
    instructions: asString(raw.instructions),
    ingredients: ingredients.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        rawName: asString(item.rawName) ?? 'Unknown ingredient',
        quantity: asNumber(item.quantity),
        unit: asString(item.unit),
      };
    }),
  };
}

export async function extractOrder(
  inlineData: { mimeType: string; data: string },
): Promise<OrderExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('order', { inlineData });

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