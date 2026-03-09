#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import {
  DATASET_EMBEDDING_API_KEY_ENV,
  fetchSingleDatasetEmbedding,
} from "../shared/dataset-embedding.mjs";

const DEFAULT_LIMIT = 5;
const PRESETS = {
  ingredients: ["たまねぎ", "鶏むね肉", "白ご飯"],
  recipes: ["親子丼", "減塩カレー", "味噌汁"],
  menu_sets: ["減塩の和食献立", "高たんぱく朝食", "子ども向け献立"],
};

function mustGetEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が未設定です`);
  return value;
}

function tryLoadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key] && value) process.env[key] = value;
  }
}

function tryLoadEnv() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, "..");
  tryLoadEnvFile(path.join(root, ".env.local"));
  tryLoadEnvFile(path.join(root, "data/raw/edge-secrets.env"));

  if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.DATASET_SERVICE_ROLE_KEY) {
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.DATASET_SERVICE_ROLE_KEY;
  }
}

function parseArgs(argv) {
  const args = {
    type: "all",
    limit: DEFAULT_LIMIT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--type" || arg === "-t") && argv[i + 1]) {
      args.type = argv[++i];
    } else if ((arg === "--limit" || arg === "-n") && argv[i + 1]) {
      args.limit = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`不明な引数: ${arg}`);
    }
  }

  if (!["all", "ingredients", "recipes", "menu_sets"].includes(args.type)) {
    throw new Error(`--type は all|ingredients|recipes|menu_sets のいずれかです: ${args.type}`);
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error(`--limit は正の数です: ${args.limit}`);
  }

  return args;
}

function printHelp() {
  console.log(`
使い方:
  node scripts/check-search-quality.mjs [options]

Options:
  --type, -t all|ingredients|recipes|menu_sets   確認対象 (default: all)
  --limit, -n <N>                                上位N件表示 (default: ${DEFAULT_LIMIT})
  --help, -h

必須環境変数:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  ${DATASET_EMBEDDING_API_KEY_ENV}
`);
}

function formatSimilarity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "?";
  return num.toFixed(3);
}

function isTemporaryError(error) {
  const message = String(error?.message ?? error ?? "");
  return [
    /statement timeout/i,
    /canceling statement due to statement timeout/i,
    /fetch failed/i,
    /timeout/i,
    /network/i,
    /503/i,
    /502/i,
    /504/i,
    /service unavailable/i,
  ].some((pattern) => pattern.test(message));
}

async function withRetry(label, fn, { retries = 3, baseDelayMs = 1000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTemporaryError(error) || attempt === retries) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[retry] ${label}: waiting ${delay}ms after ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function printSectionHeader(title) {
  console.log(`\n=== ${title} ===`);
}

async function runIngredientChecks(supabase, apiKey, limit) {
  printSectionHeader("ingredients");

  for (const query of PRESETS.ingredients) {
    const embedding = await fetchSingleDatasetEmbedding(query, { apiKey, inputType: "query" });
    const [{ data: vectorData, error: vectorError }, { data: textData, error: textError }] = await Promise.all(
      [
        withRetry(`ingredients(vector:${query})`, () =>
          supabase.rpc("search_ingredients_full_by_embedding", {
            query_embedding: embedding,
            match_count: limit,
          }),
        ),
        withRetry(`ingredients(text:${query})`, () =>
          supabase.rpc("search_ingredients_by_text_similarity", {
            query_name: query,
            similarity_threshold: 0.3,
            result_limit: limit,
          }),
        ),
      ],
    );
    if (vectorError) throw new Error(`ingredients(vector:${query}): ${vectorError.message}`);
    if (textError) throw new Error(`ingredients(text:${query}): ${textError.message}`);

    console.log(`\n[query] ${query}`);
    console.log("  vector:");
    for (const row of vectorData ?? []) {
      console.log(`- ${row.name} | sim=${formatSimilarity(row.similarity)} | kcal=${row.calories_kcal ?? "?"}`);
    }
    console.log("  text:");
    for (const row of textData ?? []) {
      console.log(`- ${row.name} | sim=${formatSimilarity(row.similarity)} | kcal=${row.calories_kcal ?? "?"}`);
    }
  }
}

async function runRecipeChecks(supabase, apiKey, limit) {
  printSectionHeader("recipes");

  for (const query of PRESETS.recipes) {
    const embedding = await fetchSingleDatasetEmbedding(query, { apiKey, inputType: "query" });
    const { data, error } = await withRetry(`recipes(${query})`, () =>
      supabase.rpc("search_recipes_hybrid", {
        query_text: query,
        query_embedding: embedding,
        match_count: limit,
        similarity_threshold: 0.15,
      }),
    );
    if (error) throw new Error(`recipes(${query}): ${error.message}`);

    console.log(`\n[query] ${query}`);
    for (const row of data ?? []) {
      console.log(`- ${row.name} | score=${formatSimilarity(row.combined_score)} | kcal=${row.calories_kcal ?? "?"}`);
    }
  }
}

async function runMenuChecks(supabase, apiKey, limit) {
  printSectionHeader("menu_sets");

  for (const query of PRESETS.menu_sets) {
    const embedding = await fetchSingleDatasetEmbedding(query, { apiKey, inputType: "query" });
    const { data, error } = await withRetry(`menu_sets(${query})`, () =>
      supabase.rpc("search_menu_examples", {
        query_embedding: embedding,
        match_count: limit,
        filter_meal_type_hint: null,
        filter_max_sodium: null,
        filter_theme_tags: null,
      }),
    );
    if (error) throw new Error(`menu_sets(${query}): ${error.message}`);

    console.log(`\n[query] ${query}`);
    for (const row of data ?? []) {
      console.log(`- ${row.title} | sim=${formatSimilarity(row.similarity)} | kcal=${row.calories_kcal ?? "?"} | salt=${row.sodium_g ?? "?"}`);
    }
  }
}

async function main() {
  tryLoadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const supabase = createClient(
    mustGetEnv("SUPABASE_URL"),
    mustGetEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const apiKey = mustGetEnv(DATASET_EMBEDDING_API_KEY_ENV);

  if (args.type === "all" || args.type === "ingredients") {
    await runIngredientChecks(supabase, apiKey, args.limit);
  }
  if (args.type === "all" || args.type === "recipes") {
    await runRecipeChecks(supabase, apiKey, args.limit);
  }
  if (args.type === "all" || args.type === "menu_sets") {
    await runMenuChecks(supabase, apiKey, args.limit);
  }
}

main().catch((error) => {
  console.error("❌ search quality check failed:", error?.message ?? error);
  process.exitCode = 1;
});
