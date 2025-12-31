/**
 * pgvector 動作確認（OpenAI Embeddings → Supabase RPC → search_menu_examples）
 *
 * 例:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... \\
 *   node scripts/test-vector-search.mjs "塩分控えめのカレー" --meal dinner --count 5
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
}

function tryLoadDotenvLocal() {
  // .env.local は通常 gitignore 対象。実行環境の制約で読めない場合もあるので、失敗しても続行する。
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "..");
    const candidates = [
      path.join(projectRoot, ".env.local"),
      path.resolve(projectRoot, "..", ".env.local"),
    ];
    const dotenvPath = candidates.find((p) => fs.existsSync(p));
    if (!dotenvPath) return;

    const content = fs.readFileSync(dotenvPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (!key) continue;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] == null && val !== "") process.env[key] = val;
    }

    if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
      process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    }
    if (!process.env.SUPABASE_ANON_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      process.env.SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    }
  } catch {
    // no-op
  }
}

function parseArgs(argv) {
  const args = {
    query: null,
    meal: null, // breakfast|lunch|dinner|snack|null
    count: 10,
    maxSodium: null,
    themes: null, // comma separated
    dimensions: 384,
  };

  if (argv.length === 0) return args;
  args.query = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--meal" && argv[i + 1]) args.meal = argv[++i];
    else if (a === "--count" && argv[i + 1]) args.count = Number(argv[++i]);
    else if (a === "--max-sodium" && argv[i + 1]) args.maxSodium = Number(argv[++i]);
    else if (a === "--themes" && argv[i + 1]) args.themes = argv[++i];
    else if (a === "--dimensions" && argv[i + 1]) args.dimensions = Number(argv[++i]);
    else if (a === "-h" || a === "--help") args.help = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  return args;
}

function printHelp() {
  console.log(`
使い方:
  node scripts/test-vector-search.mjs "<query>" [options]

Options:
  --meal breakfast|lunch|dinner|snack    meal_type_hint で絞り込み
  --count <N>                            取得件数 (default: 10)
  --max-sodium <g>                       sodium_g 上限で絞り込み
  --themes <tag1,tag2>                   theme_tags で絞り込み（AND）
  --dimensions <N>                       embeddings次元 (default: 384)
  -h, --help

必須環境変数:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  OPENAI_API_KEY
`);
}

async function main() {
  tryLoadDotenvLocal();
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.query) {
    printHelp();
    process.exitCode = args.query ? 0 : 1;
    return;
  }

  const supabase = createClient(mustGetEnv("SUPABASE_URL"), mustGetEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const openai = new OpenAI({ apiKey: mustGetEnv("OPENAI_API_KEY") });

  const embRes = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: args.query,
    dimensions: args.dimensions,
  });
  const embedding = embRes.data[0]?.embedding;
  if (!embedding) throw new Error("embedding生成に失敗しました");

  const filterThemeTags = args.themes ? args.themes.split(",").map((s) => s.trim()).filter(Boolean) : null;

  const { data, error } = await supabase.rpc("search_menu_examples", {
    query_embedding: embedding,
    match_count: args.count,
    filter_meal_type_hint: args.meal,
    filter_max_sodium: args.maxSodium,
    filter_theme_tags: filterThemeTags,
  });
  if (error) throw error;

  console.log(`query: ${args.query}`);
  console.log(`results: ${data?.length ?? 0}`);
  for (const r of data ?? []) {
    const dishes = (r.dishes ?? []).slice(0, 5).map((d) => `${d.name}(${d.class_raw ?? d.role ?? ""})`).join(" / ");
    console.log(`- [${r.similarity?.toFixed?.(3) ?? r.similarity}] ${r.title} | ${r.meal_type_hint} | salt=${r.sodium_g} | kcal=${r.calories_kcal}`);
    console.log(`  dishes: ${dishes}`);
    if (r.theme_tags?.length) console.log(`  themes: ${r.theme_tags.join(" ")}`);
  }
}

main().catch((e) => {
  console.error("❌ vector search failed:", e?.message ?? e);
  process.exitCode = 1;
});


