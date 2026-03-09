import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  DATASET_EMBEDDING_API_KEY_ENV,
  DATASET_EMBEDDING_DIMENSIONS,
  DATASET_EMBEDDING_MODEL,
  fetchDatasetEmbeddings,
} from "../../../shared/dataset-embedding.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type BackfillRequest = {
  batchSize?: number; // 1..500
  maxRows?: number; // 1..N, 省略で全件
  dryRun?: boolean;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth) return null;
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return auth.trim();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    // base64url -> base64
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    // pad
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { label?: string; retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const label = opts.label ?? "op";
  const retries = opts.retries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 800;

  let lastErr: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const status = e?.status ?? e?.response?.status ?? e?.cause?.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
      if (!retryable || attempt === retries) {
        throw e;
      }
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.log(`⏳ ${label} retry in ${delay}ms (attempt ${attempt + 1}/${retries}) status=${status}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function embedTexts(texts: string[], dimensions = DATASET_EMBEDDING_DIMENSIONS): Promise<number[][]> {
  const apiKey = Deno.env.get(DATASET_EMBEDDING_API_KEY_ENV);
  if (!apiKey) throw new Error(`Embedding API Key is missing (${DATASET_EMBEDDING_API_KEY_ENV})`);

  const res = await withRetry(
    async () => await fetchDatasetEmbeddings(texts, { apiKey, inputType: "document" }),
    { label: "embeddings" },
  );

  const embeddings = res;
  if (!embeddings.every((e: any) => Array.isArray(e) && e.length === dimensions)) {
    throw new Error("Embeddings API returned invalid embedding vectors");
  }
  return embeddings as number[][];
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Security: service_role JWT only (avoid letting user JWTs burn tokens)
  const token = getBearerToken(req);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const payload = decodeJwtPayload(token);
  const role = String(payload?.role ?? "");
  if (role !== "service_role") {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const startedAt = Date.now();

  const body: BackfillRequest = await req.json().catch(() => ({}));
  const batchSize = clampInt(Number(body.batchSize ?? 200), 1, 500);
  const dryRun = Boolean(body.dryRun ?? false);
  const maxRowsRaw = body.maxRows == null ? null : Number(body.maxRows);
  const maxRows = maxRowsRaw == null || !Number.isFinite(maxRowsRaw) ? null : clampInt(maxRowsRaw, 1, 1000000);

  // before count
  const beforeCountRes = await supabaseAdmin
    .from("dataset_ingredients")
    .select("id", { count: "exact", head: true })
    .is("name_embedding", null);
  if (beforeCountRes.error) {
    return jsonResponse({ error: beforeCountRes.error.message }, 500);
  }
  const beforeNullCount = beforeCountRes.count ?? 0;

  let processed = 0;
  let batches = 0;

  try {
    while (true) {
      if (maxRows != null && processed >= maxRows) break;
      const limit = maxRows != null ? Math.min(batchSize, maxRows - processed) : batchSize;

      const { data, error } = await supabaseAdmin
        .from("dataset_ingredients")
        .select("id,name,name_norm")
        .is("name_embedding", null)
        .order("id", { ascending: true })
        .limit(limit);

      if (error) throw new Error(`Failed to fetch dataset_ingredients: ${error.message}`);
      const rows = (data ?? []) as { id: string; name: string; name_norm: string }[];
      if (rows.length === 0) break;

      const names = rows.map((r) => String(r.name ?? "").trim()).filter(Boolean);
      if (names.length !== rows.length) {
        throw new Error("Invalid ingredient name found (empty)");
      }

      const embeddings = await embedTexts(names, DATASET_EMBEDDING_DIMENSIONS);

      if (!dryRun) {
        // NOTE:
        // PostgREST upsert は insert を経由するため、NOT NULL 列を省くと
        // まれに制約違反になる（既存行でも）。安全のため name/name_norm も同梱する。
        const upsertRows = rows.map((r, i) => ({
          id: r.id,
          name: r.name,
          name_norm: r.name_norm,
          name_embedding: embeddings[i],
        }));
        const { error: upsertErr } = await supabaseAdmin.from("dataset_ingredients").upsert(upsertRows, {
          onConflict: "id",
          returning: "minimal",
        });
        if (upsertErr) throw new Error(`Failed to upsert embeddings: ${upsertErr.message}`);
      }

      processed += rows.length;
      batches += 1;

      console.log(
        `✅ batch ${batches}: processed ${processed}${maxRows != null ? `/${maxRows}` : ""} (last=${rows.length})`,
      );
    }

    const afterCountRes = await supabaseAdmin
      .from("dataset_ingredients")
      .select("id", { count: "exact", head: true })
      .is("name_embedding", null);
    if (afterCountRes.error) throw new Error(`Failed to count after: ${afterCountRes.error.message}`);
    const afterNullCount = afterCountRes.count ?? 0;

    return jsonResponse({
      ok: true,
      dryRun,
      batchSize,
      maxRows,
      beforeNullCount,
      afterNullCount,
      processed,
      batches,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (e: any) {
    console.error("❌ backfill-ingredient-embeddings failed:", e?.message ?? e);
    return jsonResponse(
      {
        ok: false,
        error: e?.message ?? String(e),
        processed,
        batches,
        elapsed_ms: Date.now() - startedAt,
      },
      500,
    );
  }
});
