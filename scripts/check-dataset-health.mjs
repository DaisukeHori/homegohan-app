#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const KNOWN_TABLES = ["dataset_ingredients", "dataset_recipes", "dataset_menu_sets"];

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

function parseTableList(value, flagName) {
  if (!value) return [];
  const tables = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const table of tables) {
    if (!KNOWN_TABLES.includes(table)) {
      throw new Error(`${flagName} には ${KNOWN_TABLES.join(", ")} のいずれかを指定してください: ${table}`);
    }
  }
  return tables;
}

function parseArgs(argv) {
  const args = {
    failOnZero: [],
    failOnMissing: [],
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--fail-on-zero" || arg === "-z") && argv[i + 1]) {
      args.failOnZero = parseTableList(argv[++i], "--fail-on-zero");
    } else if ((arg === "--fail-on-missing" || arg === "-m") && argv[i + 1]) {
      args.failOnMissing = parseTableList(argv[++i], "--fail-on-missing");
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`不明な引数: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
使い方:
  node scripts/check-dataset-health.mjs [options]

Options:
  --fail-on-zero, -z <tables>      件数が 0 件なら失敗にするテーブル一覧（カンマ区切り）
  --fail-on-missing, -m <tables>   埋め込み missing が 1 件以上なら失敗にするテーブル一覧
  --json                           JSON 形式で出力
  --help, -h

例:
  node scripts/check-dataset-health.mjs --fail-on-zero dataset_ingredients,dataset_recipes,dataset_menu_sets
  node scripts/check-dataset-health.mjs --fail-on-missing dataset_ingredients,dataset_recipes
`);
}

async function countTable(supabase, table, embeddingColumn) {
  const { count: total, error: totalError } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });
  if (totalError) throw totalError;

  let missingEmbeddings = null;
  let countMode = "exact";

  const exactResponse = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .is(embeddingColumn, null);

  if (!exactResponse.error) {
    missingEmbeddings = exactResponse.count ?? 0;
  } else {
    const plannedResponse = await supabase
      .from(table)
      .select("id", { count: "planned", head: true })
      .is(embeddingColumn, null);
    if (plannedResponse.error) throw plannedResponse.error;
    missingEmbeddings = plannedResponse.count ?? 0;
    countMode = "planned";
  }

  return {
    table,
    total: total ?? 0,
    nonNullEmbeddings: Math.max(0, (total ?? 0) - (missingEmbeddings ?? 0)),
    countMode,
  };
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

  const results = await Promise.all([
    countTable(supabase, "dataset_ingredients", "name_embedding"),
    countTable(supabase, "dataset_recipes", "name_embedding"),
    countTable(supabase, "dataset_menu_sets", "content_embedding"),
  ]);

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      console.log(
        `${result.table}: total=${result.total}, embedded=${result.nonNullEmbeddings}, missing=${result.total - result.nonNullEmbeddings}, countMode=${result.countMode}`,
      );
    }
  }

  const failures = [];
  for (const result of results) {
    const missing = result.total - result.nonNullEmbeddings;
    if (args.failOnZero.includes(result.table) && result.total === 0) {
      failures.push(`${result.table}: total=0`);
    }
    if (args.failOnMissing.includes(result.table) && missing > 0) {
      failures.push(`${result.table}: missing=${missing}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`health check failed: ${failures.join(", ")}`);
  }
}

main().catch((error) => {
  console.error("❌ dataset health check failed:", error?.message ?? JSON.stringify(error));
  process.exitCode = 1;
});
