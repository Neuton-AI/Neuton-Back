import { GoogleGenAI, type Part } from '@google/genai';
import pino from 'pino';
import { env, isProduction } from '../env.js';
import { isPermanentError, isUnknownModelError } from './jobErrors.js';
import type { MediaKind } from './queue.js';

const logger = pino({
  level: isProduction ? 'info' : 'debug',
  ...(isProduction ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

/**
 * Vision models tried in order. Google serves each model from its own capacity
 * pool, so a 503 on one frequently succeeds on the next — that rotation is the
 * whole point of the ladder. Order matters: the first entry is the default.
 * Configurable via GEMINI_MODELS so the ladder can be retuned without a redeploy.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Model for a given zero-based attempt: the same model for
 * GEMINI_ATTEMPTS_PER_MODEL attempts, then the next in the ladder, wrapping.
 */
function modelForAttempt(attempt: number): string {
  const index = Math.floor(attempt / env.GEMINI_ATTEMPTS_PER_MODEL) % MODELS.length;
  const model = MODELS[index];
  if (model === undefined) {
    throw new Error(`GEMINI_MODELS is empty; no model for attempt ${attempt}`);
  }
  return model;
}

/**
 * Exponential backoff with full jitter. Jitter matters here: several workers
 * hit a capacity wall at the same moment, and without it they resync on every
 * retry and stampede the model that just recovered.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(
    env.GEMINI_RETRY_BASE_DELAY_MS * 2 ** attempt,
    env.GEMINI_RETRY_MAX_DELAY_MS,
  );
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/**
 * Walks the model ladder: retry a model in place, then rotate. The attempt
 * counter is local to this call, so concurrent jobs never inherit each other's
 * position. Returns null only when every model produced an unusable payload,
 * preserving the caller's existing contract.
 */
async function runStructured<T>(kind: MediaKind, part: Part): Promise<T | null> {
  const { instruction, schema } = PROMPTS[kind];

  for (let attempt = 0; attempt < env.GEMINI_MAX_ATTEMPTS; attempt++) {
    const model = modelForAttempt(attempt);

    try {
      const response = await client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [part, { text: instruction }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: JSON.parse(schema) as unknown as Record<string, unknown>,
          temperature: 0.1,
        },
      });

      const text = response.text;
      if (!text) throw new UnusableResponseError(model, 'returned no text');
      return parseJson<T>(text);
    } catch (error) {
      const unusable = error instanceof UnusableResponseError || isUnknownModelError(error);
      // Auth, billing, malformed requests and oversize payloads will fail
      // identically on every model, so they end the job immediately.
      const fatal = isPermanentError(error) && !unusable;
      const exhausted = attempt === env.GEMINI_MAX_ATTEMPTS - 1;

      if (fatal || exhausted) {
        if (!fatal && unusable) return null;
        throw error;
      }

      logger.warn(
        {
          model,
          attempt: attempt + 1,
          maxAttempts: env.GEMINI_MAX_ATTEMPTS,
          rotatingTo: modelForAttempt(attempt + 1),
          err: error,
        },
        unusable ? 'gemini model unusable, rotating' : 'gemini call failed, retrying',
      );
      await sleep(backoffDelay(attempt));
    }
  }

  return null;
}

export async function extractReceipt(
  inlineData: { mimeType: string; data: string },
): Promise<ReceiptExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('receipt', {
    inlineData,
  });
  if (!raw) return null;

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
  if (!raw) return null;

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
  if (!raw) return null;

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
