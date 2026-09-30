import { GoogleGenAI, type Part } from '@google/genai';
import { env } from '../env.js';
import type { MediaKind } from './queue.js';

const MODEL = 'gemini-flash-latest';

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

async function runStructured<T>(
  kind: MediaKind,
  part: Part,
): Promise<T | null> {
  const { instruction, schema } = PROMPTS[kind];

  const response = await client.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [part, { text: instruction }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: JSON.parse(schema) as unknown as Record<string, unknown>,
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) return null;
  try {
    return parseJson<T>(text);
  } catch {
    return null;
  }
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
