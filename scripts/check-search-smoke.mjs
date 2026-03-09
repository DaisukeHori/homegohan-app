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

const VALID_TYPES = ["all", "ingredients", "recipes", "menu_sets"];

function mustGetEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が未設定です`);
  return value;
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
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--type" || arg === "-t") && argv[i + 1]) {
      args.type = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`不明な引数: ${arg}`);
    }
  }

  if (!VALID_TYPES.includes(args.type)) {
    throw new Error(`--type は ${VALID_TYPES.join("|")} のいずれかです: ${args.type}`);
  }

  return args;
}

function printHelp() {
  console.log(`
使い方:
  node scripts/check-search-smoke.mjs [options]

Options:
  --type, -t all|ingredients|recipes|menu_sets   確認対象 (default: all)
  --help, -h
`);
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
  const results = [];

  if (args.type === "all" || args.type === "ingredients") {
    const ingredientEmbedding = await fetchSingleDatasetEmbedding("たまねぎ", { apiKey, inputType: "query" });
    const ingredientVector = await withRetry("ingredients", () =>
      supabase.rpc("search_ingredients_full_by_embedding", {
        query_embedding: ingredientEmbedding,
        match_count: 3,
      }),
    );
    results.push(["ingredients", ingredientVector]);
  }

  if (args.type === "all" || args.type === "recipes") {
    const recipeEmbedding = await fetchSingleDatasetEmbedding("親子丼", { apiKey, inputType: "query" });
    const recipeHybrid = await withRetry("recipes", () =>
      supabase.rpc("search_recipes_hybrid", {
        query_text: "親子丼",
        query_embedding: recipeEmbedding,
        match_count: 3,
        similarity_threshold: 0.15,
      }),
    );
    results.push(["recipes", recipeHybrid]);
  }

  if (args.type === "all" || args.type === "menu_sets") {
    const menuEmbedding = await fetchSingleDatasetEmbedding("減塩の和食献立", { apiKey, inputType: "query" });
    const menuExamples = await withRetry("menu_sets", () =>
      supabase.rpc("search_menu_examples", {
        query_embedding: menuEmbedding,
        match_count: 3,
        filter_meal_type_hint: null,
        filter_max_sodium: null,
        filter_theme_tags: null,
      }),
    );
    results.push(["menu_sets", menuExamples]);
  }

  for (const [label, response] of results) {
    if (response.error) {
      throw new Error(`${label}: ${response.error.message}`);
    }
    console.log(`${label}: ${response.data?.length ?? 0} rows`);
  }
}

main().catch((error) => {
  console.error("❌ search smoke failed:", error?.message ?? error);
  process.exitCode = 1;
});
