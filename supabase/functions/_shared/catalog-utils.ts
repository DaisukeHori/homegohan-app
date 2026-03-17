import { z } from "npm:zod@4.1.13";

export const catalogNutritionSchema = z.object({
  caloriesKcal: z.number().nullable().optional(),
  proteinG: z.number().nullable().optional(),
  fatG: z.number().nullable().optional(),
  carbsG: z.number().nullable().optional(),
  fiberG: z.number().nullable().optional(),
  sodiumG: z.number().nullable().optional(),
  sugarG: z.number().nullable().optional(),
}).default({});

export const firecrawlListItemSchema = z.object({
  name: z.string().nullable().optional(),
  url: z.string().url(),
  imageUrl: z.string().url().nullable().optional(),
});

export const firecrawlDiscoverySchema = z.object({
  itemUrls: z.array(z.string().url()).default([]),
  categoryUrls: z.array(z.string().url()).default([]),
  regionUrls: z.array(z.string().url()).default([]),
  lineupUrls: z.array(z.string().url()).default([]),
});

export const firecrawlProductSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  imageUrl: z.string().url().nullable().optional(),
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  priceYen: z.number().nullable().optional(),
  salesRegion: z.string().nullable().optional(),
  availabilityStatus: z.string().nullable().optional(),
  allergens: z.array(z.string()).default([]),
  nutrition: catalogNutritionSchema,
  nutritionText: z.string().nullable().optional(),
  rawText: z.string().nullable().optional(),
});

export type FirecrawlDiscoveryExtract = z.infer<typeof firecrawlDiscoverySchema>;
export type FirecrawlProductExtract = z.infer<typeof firecrawlProductSchema>;

export const cleanedCatalogProductSchema = z.object({
  name: z.string().min(1),
  canonicalUrl: z.string().url(),
  externalId: z.string().min(1),
  brandName: z.string().min(1),
  categoryCode: z.string().nullable().optional(),
  subcategoryCode: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  priceYen: z.number().nullable().optional(),
  salesRegion: z.string().nullable().optional(),
  availabilityStatus: z.enum(["active", "limited", "discontinued", "unknown"]).default("unknown"),
  mainImageUrl: z.string().url().nullable().optional(),
  caloriesKcal: z.number().nullable().optional(),
  proteinG: z.number().nullable().optional(),
  fatG: z.number().nullable().optional(),
  carbsG: z.number().nullable().optional(),
  fiberG: z.number().nullable().optional(),
  sodiumG: z.number().nullable().optional(),
  sugarG: z.number().nullable().optional(),
  nutritionJson: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.any()),
    z.record(z.string(), z.any()),
  ])).default({}),
  allergensJson: z.array(z.string()).default([]),
  metadataJson: z.record(z.string(), z.any()).default({}),
  contentHash: z.string().min(1),
});

export type CleanedCatalogProduct = z.infer<typeof cleanedCatalogProductSchema>;

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const normalized = value
    .replace(/[，,]/g, "")
    .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 65248))
    .replace(/[^\d.\-]/g, "")
    .trim();

  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeCatalogName(name: string): string {
  return String(name ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = shouldPreserveSearchParams(parsed) ? parsed.search : "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function shouldPreserveSearchParams(parsed: URL): boolean {
  return /\/syohin\/nutrition\/results\.html$/i.test(parsed.pathname);
}

export function isPlaceholderImageUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  return /\/images\/common\/giphy\.gif$/i.test(url);
}

const SEVEN_ITEM_PATH_RE = /^\/products\/a\/item\/(\d+)(?:\/([a-z0-9_-]+))?\/?$/i;
const LAWSON_ITEM_PATH_RE = /^\/(?:sp\/)?recommend\/original\/detail\/(\d{7})_\d{4}\.html$/i;
const NATURAL_LAWSON_ITEM_PATH_RE = /^\/(?:sp\/)?recommend\/commodity\/detail\/(\d{7})_\d{4}\.html$/i;

export function normalizeCatalogProductUrl(url: string, sourceCode?: string | null): string {
  const normalized = normalizeUrl(url);
  if (sourceCode !== "seven_eleven_jp") {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    const match = parsed.pathname.match(SEVEN_ITEM_PATH_RE);
    if (!match) return normalized;

    parsed.pathname = `/products/a/item/${match[1]}/`;
    return parsed.toString();
  } catch {
    return normalized;
  }
}

export function extractCatalogObservedRegionCode(url: string, sourceCode?: string | null): string | null {
  if (sourceCode !== "seven_eleven_jp") {
    return null;
  }

  try {
    const parsed = new URL(normalizeUrl(url));
    const match = parsed.pathname.match(SEVEN_ITEM_PATH_RE);
    return match?.[2]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function deriveExternalId(url: string, sourceCode?: string | null): string {
  const normalized = normalizeCatalogProductUrl(url, sourceCode);
  try {
    const parsed = new URL(normalized);
    if (sourceCode === "seven_eleven_jp") {
      const match = parsed.pathname.match(SEVEN_ITEM_PATH_RE);
      if (match?.[1]) return match[1];
    }
    if (sourceCode === "lawson_jp") {
      const match = parsed.pathname.match(LAWSON_ITEM_PATH_RE);
      if (match?.[1]) return match[1];
    }
    if (sourceCode === "natural_lawson_jp") {
      const match = parsed.pathname.match(NATURAL_LAWSON_ITEM_PATH_RE);
      if (match?.[1]) return match[1];
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    return path || parsed.hostname;
  } catch {
    return normalized;
  }
}

export function normalizeCategoryCode(category: string | null | undefined, fallback?: string | null): string | null {
  const raw = String(category ?? fallback ?? "").trim().toLowerCase();
  if (!raw) return fallback ?? null;

  if (/おにぎり|onigiri/.test(raw)) return "onigiri";
  if (/弁当|bento/.test(raw)) return "bento";
  if (/麺|めん|men|noodle/.test(raw)) return "men";
  if (/サンド|ロールパン|sandwich/.test(raw)) return "sandwich";
  return fallback ?? raw;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildCatalogContentHash(input: Record<string, unknown>): Promise<string> {
  const stable = JSON.stringify(sortValue(input));
  return sha256Hex(stable);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
