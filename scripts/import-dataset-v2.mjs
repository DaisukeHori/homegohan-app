/**
 * v2 データセット取り込み（CSV → Supabase）
 *
 * 対象:
 * - data/raw/Menus_combined.csv（献立セット 13万件）
 * - data/raw/recipies.csv（レシピ 1.1万件）
 *
 * 重要:
 * - Menus_combined.csv の「料理2カロリー(kcal)」は壊れているため、必ず残差で復元する:
 *     dish2_kcal = total_kcal - (dish1_kcal + dish3_kcal + dish4_kcal + dish5_kcal)
 * - recipies.csv の amino_acid(g) は、Menus_combined.csv の 全たんぱく質(g) と整合するため
 *   protein_g として格納する（=「たんぱく質」扱い）。
 *
 * 実行例:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-dataset-v2.mjs --dry-run --limit 3
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-dataset-v2.mjs --import recipes
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-dataset-v2.mjs --import menu_sets
 *
 * embedding も入れる場合:
 *   OPENAI_API_KEY=... node scripts/import-dataset-v2.mjs --import all --with-embeddings
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_MENUS_CSV = "data/raw/Menus_combined.csv";
const DEFAULT_RECIPES_CSV = "data/raw/recipies.csv";
const DEFAULT_INGREDIENTS_CSV = "data/raw/食材栄養.csv";

const ROLE_BY_CLASS = new Map([
  ["主菜", "main"],
  ["副菜", "side"],
  ["汁物", "soup"],
  ["主食", "rice"],
  ["デザート", "other"],
  ["その他", "other"],
]);

function parseArgs(argv) {
  const args = {
    menusCsv: DEFAULT_MENUS_CSV,
    recipesCsv: DEFAULT_RECIPES_CSV,
    ingredientsCsv: DEFAULT_INGREDIENTS_CSV,
    importTarget: "all", // all | recipes | menu_sets | ingredients
    dryRun: false,
    limit: null,
    withEmbeddings: false,
    datasetVersion: `oishi-kenko-${new Date().toISOString().slice(0, 10)}`,
    embeddingDimensions: 384,
    batchSize: 200,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--with-embeddings") args.withEmbeddings = true;
    else if (a === "--menus" && argv[i + 1]) args.menusCsv = argv[++i];
    else if (a === "--recipes" && argv[i + 1]) args.recipesCsv = argv[++i];
    else if (a === "--ingredients" && argv[i + 1]) args.ingredientsCsv = argv[++i];
    else if (a === "--import" && argv[i + 1]) args.importTarget = argv[++i];
    else if (a === "--limit" && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (a === "--dataset-version" && argv[i + 1]) args.datasetVersion = argv[++i];
    else if (a === "--embedding-dimensions" && argv[i + 1]) args.embeddingDimensions = Number(argv[++i]);
    else if (a === "--batch-size" && argv[i + 1]) args.batchSize = Number(argv[++i]);
    else {
      throw new Error(`不明な引数: ${a}`);
    }
  }

  if (!["all", "recipes", "menu_sets", "ingredients"].includes(args.importTarget)) {
    throw new Error(`--import は all|recipes|menu_sets|ingredients のいずれかです: ${args.importTarget}`);
  }
  if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error(`--limit は正の数です: ${args.limit}`);
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1 || args.batchSize > 2000) {
    throw new Error(`--batch-size は 1〜2000 の範囲で指定してください: ${args.batchSize}`);
  }
  if (!Number.isFinite(args.embeddingDimensions) || args.embeddingDimensions < 64 || args.embeddingDimensions > 3072) {
    throw new Error(`--embedding-dimensions が不正です: ${args.embeddingDimensions}`);
  }

  return args;
}

function printHelp() {
  console.log(`
使い方:
  node scripts/import-dataset-v2.mjs [options]

Options:
  --import all|recipes|menu_sets|ingredients   取り込み対象 (default: all)
  --menus <path>                  Menus_combined.csv のパス (default: ${DEFAULT_MENUS_CSV})
  --recipes <path>                recipies.csv のパス (default: ${DEFAULT_RECIPES_CSV})
  --ingredients <path>            食材栄養.csv のパス (default: ${DEFAULT_INGREDIENTS_CSV})
  --dataset-version <text>         dataset_import_runs に記録するバージョン文字列
  --dry-run                        DBへ書き込まず、パースと変換だけ実行
  --limit <N>                      先頭N行のみ処理（テスト用）
  --batch-size <N>                 DBへ送るバッチサイズ（default: 200）
  --with-embeddings                OpenAI Embeddings を生成して格納
  --embedding-dimensions <N>        埋め込み次元（default: 384）
  -h, --help                       ヘルプ表示

必須環境変数:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

--with-embeddings の場合:
  OPENAI_API_KEY
`);
}

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
      path.resolve(projectRoot, "..", ".env.local"), // monorepo上位など
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
      // remove optional quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] == null && val !== "") process.env[key] = val;
    }

    // 互換: SUPABASE_URL がない場合は NEXT_PUBLIC_SUPABASE_URL を使う
    if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
      process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    }
    // 互換: SUPABASE_ANON_KEY がない場合は NEXT_PUBLIC_SUPABASE_ANON_KEY を使う
    if (!process.env.SUPABASE_ANON_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      process.env.SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    }
  } catch {
    // no-op（ログに秘密情報を出したくないので詳細は出さない）
  }
}

function tryLoadEdgeSecretsEnv() {
  // ローカル開発用: data/raw/edge-secrets.env（gitignore想定）から最低限の鍵を読む
  // - DATASET_SERVICE_ROLE_KEY -> SUPABASE_SERVICE_ROLE_KEY へマップ
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "..");
    const candidates = [
      path.join(projectRoot, "data/raw/edge-secrets.env"),
      path.resolve(projectRoot, "..", "data/raw/edge-secrets.env"),
    ];
    const envPath = candidates.find((p) => fs.existsSync(p));
    if (!envPath) return;

    const content = fs.readFileSync(envPath, "utf8");
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

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.DATASET_SERVICE_ROLE_KEY) {
      process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.DATASET_SERVICE_ROLE_KEY;
    }
    if (!process.env.SUPABASE_URL && process.env.DATASET_SUPABASE_URL) {
      process.env.SUPABASE_URL = process.env.DATASET_SUPABASE_URL;
    }
  } catch {
    // no-op
  }
}

function toNumberOrNull(x) {
  if (x == null) return null;
  let s = String(x).trim();
  if (!s) return null;
  // 欠損表現
  if (s === "-" || s === "－" || s === "—" || s === "―") return null;
  // trace
  if (/^tr$/iu.test(s)) return 0;
  // () / （） で囲われた数値を許容（推定値など）
  s = s.replace(/^[（(]/u, "").replace(/[）)]$/u, "");
  // 余計な区切り除去
  s = s.replace(/[, ]+/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(x) {
  const n = toNumberOrNull(x);
  if (n == null) return null;
  const i = Math.trunc(n);
  return Number.isFinite(i) ? i : null;
}

function normalizeDishNameJs(name) {
  return String(name ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

// 食材名は括弧内（生/ゆで等）も識別子として残したいので「括弧は外すが中身は残す」正規化を採用
function normalizeIngredientNameJs(name) {
  return String(name ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

function parseTheme(themeRaw) {
  const raw = String(themeRaw ?? "").trim();
  if (!raw) return { theme_raw: null, theme_tags: [] };
  // 例: "食事のテーマ：高血圧 糖尿病（2型）"
  const cleaned = raw.replace(/^食事のテーマ：\s*/u, "").trim();
  const tags = cleaned ? cleaned.split(/\s+/).filter(Boolean) : [];
  return { theme_raw: raw, theme_tags: tags };
}

function buildMenuSetTitle(dishNames) {
  const names = dishNames.filter(Boolean);
  if (names.length === 0) return "（無題）";
  return names.join(" / ");
}

function roleFromClass(classRaw) {
  const c = String(classRaw ?? "").trim();
  return ROLE_BY_CLASS.get(c) ?? "other";
}

/**
 * CSVをストリームで読み、row(Array<string>) をyieldする。
 * - ダブルクォートをサポート（"" のエスケープも対応）
 * - クォート中の改行も許容
 */
async function* csvRows(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });

  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteEscapePending = false;

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const c0 = chunk[i];
      let c = c0;
      let reprocess = true;

      while (reprocess) {
        reprocess = false;

        if (quoteEscapePending) {
          quoteEscapePending = false;
          if (c === '"') {
            field += '"';
            inQuotes = true;
            break;
          }
          // クォート終了だったので、この文字を「非クォート」として再処理
          reprocess = true;
          continue;
        }

        if (inQuotes) {
          if (c === '"') {
            inQuotes = false;
            quoteEscapePending = true;
          } else {
            field += c;
          }
          break;
        }

        // not in quotes
        if (c === '"') {
          inQuotes = true;
          break;
        }
        if (c === ",") {
          row.push(field);
          field = "";
          break;
        }
        if (c === "\n") {
          row.push(field);
          field = "";
          yield row;
          row = [];
          break;
        }
        if (c === "\r") {
          break; // ignore
        }
        field += c;
      }
    }
  }

  // EOF: pending quote means it was a closing quote
  quoteEscapePending = false;
  inQuotes = false;

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    yield row;
  }
}

async function* csvObjects(filePath) {
  let header = null;
  for await (const row of csvRows(filePath)) {
    if (!header) {
      header = row.map((h) => String(h ?? ""));
      // BOM除去
      if (header[0]?.charCodeAt(0) === 0xfeff) header[0] = header[0].slice(1);
      continue;
    }
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = row[i] ?? "";
    yield obj;
  }
}

async function withRetry(fn, { retries = 5, baseDelayMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.status ?? e?.response?.status;
      const retryable = status === 429 || (status >= 500 && status <= 599);
      if (!retryable || attempt === retries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.log(`⏳ retry in ${delay}ms (attempt ${attempt + 1}/${retries}) status=${status}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function createEmbeddingClientIfNeeded(args) {
  if (!args.withEmbeddings) return null;
  const apiKey = mustGetEnv("OPENAI_API_KEY");
  return new OpenAI({ apiKey });
}

async function embedTexts(openai, texts, dimensions) {
  const res = await withRetry(() =>
    openai.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
      dimensions,
    })
  );
  return res.data.map((d) => d.embedding);
}

function buildMenuEmbeddingText(menu) {
  const theme = (menu.theme_tags ?? []).join(" ");
  const dishLines = (menu.dishes ?? []).map((d) => `${d.name}(${d.class_raw})`).join(" / ");
  const macro = `kcal=${menu.calories_kcal ?? "?"},P=${menu.protein_g ?? "?"},F=${menu.fat_g ?? "?"},C=${menu.carbs_g ?? "?"},salt=${menu.sodium_g ?? "?"}`;
  return `テーマ: ${theme}\n料理: ${dishLines}\n栄養: ${macro}`;
}

function guessMealTypeHint(menu) {
  const kcal = Number(menu.calories_kcal ?? 0);
  const dishCount = Number(menu.dish_count ?? 0);
  const hasDessert = (menu.dishes ?? []).some((d) => d.class_raw === "デザート");
  if (hasDessert && kcal <= 300) return "snack";
  if (kcal <= 350 && dishCount <= 2) return "breakfast";
  if (kcal <= 600) return "lunch";
  return "dinner";
}

async function main() {
  tryLoadEdgeSecretsEnv();
  tryLoadDotenvLocal();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const menusCsvPath = path.resolve(args.menusCsv);
  const recipesCsvPath = path.resolve(args.recipesCsv);
  const ingredientsCsvPath = path.resolve(args.ingredientsCsv);

  if (args.importTarget === "all" || args.importTarget === "menu_sets") {
    if (!fs.existsSync(menusCsvPath)) throw new Error(`見つかりません: ${menusCsvPath}`);
  }
  if (args.importTarget === "all" || args.importTarget === "recipes") {
    if (!fs.existsSync(recipesCsvPath)) throw new Error(`見つかりません: ${recipesCsvPath}`);
  }
  if (args.importTarget === "all" || args.importTarget === "ingredients") {
    if (!fs.existsSync(ingredientsCsvPath)) throw new Error(`見つかりません: ${ingredientsCsvPath}`);
  }

  console.log("=== dataset import v2 ===");
  console.log("importTarget:", args.importTarget);
  console.log("datasetVersion:", args.datasetVersion);
  console.log("dryRun:", args.dryRun);
  console.log("limit:", args.limit);
  console.log("withEmbeddings:", args.withEmbeddings);
  console.log("embeddingDimensions:", args.embeddingDimensions);
  console.log("batchSize:", args.batchSize);
  console.log("menusCsv:", menusCsvPath);
  console.log("recipesCsv:", recipesCsvPath);
  console.log("ingredientsCsv:", ingredientsCsvPath);

  const supabaseUrl = args.dryRun ? null : mustGetEnv("SUPABASE_URL");
  const supabaseServiceKey = args.dryRun ? null : mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase =
    args.dryRun
      ? null
      : createClient(supabaseUrl, supabaseServiceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

  const openai = await createEmbeddingClientIfNeeded(args);

  const importRun = {
    dataset_version: args.datasetVersion,
    source: "oishi-kenko",
    status: "running",
    menu_sets_total: 0,
    recipes_total: 0,
    menu_sets_inserted: 0,
    recipes_inserted: 0,
    ingredients_total: 0,
    ingredients_inserted: 0,
  };

  let importRunId = null;
  try {
    if (!args.dryRun) {
      const { data, error } = await supabase
        .from("dataset_import_runs")
        .insert(importRun)
        .select("id")
        .single();
      if (error) throw error;
      importRunId = data?.id ?? null;
    }

    // ----------------------------------------------------------
    // Recipes
    // ----------------------------------------------------------
    let recipesInserted = 0;
    let recipesTotal = 0;
    if (args.importTarget === "all" || args.importTarget === "recipes") {
      console.log("\n### Import: dataset_recipes");
      const batch = [];
      const embedTextsBatch = [];

      for await (const row of csvObjects(recipesCsvPath)) {
        recipesTotal++;
        if (args.limit && recipesTotal > args.limit) break;

        const externalId = String(row["web-scraper-order"] ?? "").trim();
        const sourceUrl = String(row["web-scraper-start-url"] ?? "").trim();
        const name = String(row["name"] ?? "").trim();
        if (!externalId || !name) continue;

        const protein = toNumberOrNull(row["amino_acid(g)"]);
        const fat = toNumberOrNull(row["fat(g)"]);
        const sugar = toNumberOrNull(row["sugar(g)"]);
        const fiber = toNumberOrNull(row["食物繊維(g)"]);
        const carbs = sugar != null && fiber != null ? sugar + fiber : null;

        const rec = {
          external_id: externalId,
          source_url: sourceUrl || null,
          name,
          name_norm: normalizeDishNameJs(name),
          target_audience_raw: String(row["こんな病気・お悩みの方向けのレシピです"] ?? "").trim() || null,
          tag_raw: String(row["Tag"] ?? "").trim() || null,
          ingredients_text: String(row["材料 1 人"] ?? "").trim() || null,
          instructions_text: String(row["作り方"] ?? "").trim() || null,

          calories_kcal: toIntOrNull(row["kcal"]),
          sodium_g: toNumberOrNull(row["sodium(g)"]),
          protein_g: protein,
          fat_g: fat,
          sugar_g: sugar,
          fiber_g: fiber,
          carbs_g: carbs,

          fiber_soluble_g: toNumberOrNull(row["水溶性食物繊維(g)"]),
          fiber_insoluble_g: toNumberOrNull(row["不溶性食物繊維(g)"]),
          potassium_mg: toNumberOrNull(row["カリウム(mg)"]),
          calcium_mg: toNumberOrNull(row["カルシウム(mg)"]),
          phosphorus_mg: toNumberOrNull(row["リン(mg)"]),
          iron_mg: toNumberOrNull(row["Iron(mg)"]),
          zinc_mg: toNumberOrNull(row["亜鉛(mg)"]),
          iodine_ug: toNumberOrNull(row["ヨウ素(µg)"]),
          cholesterol_mg: toNumberOrNull(row["コレステロール(mg)"]),
          vitamin_b1_mg: toNumberOrNull(row["ビタミンB1(mg)"]),
          vitamin_b2_mg: toNumberOrNull(row["ビタミンB2(mg)"]),
          vitamin_c_mg: toNumberOrNull(row["ビタミンC(mg)"]),
          vitamin_b6_mg: toNumberOrNull(row["ビタミンB6(mg)"]),
          vitamin_b12_ug: toNumberOrNull(row["ビタミンB12(µg)"]),
          folic_acid_ug: toNumberOrNull(row["葉酸(µg)"]),
          vitamin_a_ug: toNumberOrNull(row["ビタミンA(µg)"]),
          vitamin_d_ug: toNumberOrNull(row["ビタミンD(µg)"]),
          vitamin_k_ug: toNumberOrNull(row["ビタミンK(µg)"]),
          vitamin_e_mg: toNumberOrNull(row["ビタミンE(mg)"]),
          saturated_fat_g: toNumberOrNull(row["飽和脂肪酸(g)"]),
          monounsaturated_fat_g: toNumberOrNull(row["一価不飽和脂肪酸(g)"]),
          polyunsaturated_fat_g: toNumberOrNull(row["多価不飽和脂肪酸(g)"]),
        };

        if (args.withEmbeddings) {
          embedTextsBatch.push(name);
        }

        batch.push(rec);

        if (batch.length >= args.batchSize) {
          if (args.withEmbeddings) {
            const embeddings = await embedTexts(openai, embedTextsBatch, args.embeddingDimensions);
            for (let i = 0; i < batch.length; i++) batch[i].name_embedding = embeddings[i];
          }

          if (!args.dryRun) {
            const { error } = await supabase.from("dataset_recipes").upsert(batch, {
              onConflict: "external_id",
              returning: "minimal",
            });
            if (error) throw error;
          }

          recipesInserted += batch.length;
          if (recipesInserted % 2000 === 0 || recipesInserted < 1000) {
            console.log(`recipes: inserted ${recipesInserted} (read ${recipesTotal})`);
          }
          batch.length = 0;
          embedTextsBatch.length = 0;
        }
      }

      if (batch.length > 0) {
        if (args.withEmbeddings) {
          const embeddings = await embedTexts(openai, embedTextsBatch, args.embeddingDimensions);
          for (let i = 0; i < batch.length; i++) batch[i].name_embedding = embeddings[i];
        }
        if (!args.dryRun) {
          const { error } = await supabase.from("dataset_recipes").upsert(batch, {
            onConflict: "external_id",
            returning: "minimal",
          });
          if (error) throw error;
        }
        recipesInserted += batch.length;
      }

      console.log(`✅ dataset_recipes done: inserted=${recipesInserted}, read=${recipesTotal}`);
    }

    // ----------------------------------------------------------
    // Menu sets
    // ----------------------------------------------------------
    let menuSetsInserted = 0;
    let menuSetsTotal = 0;
    if (args.importTarget === "all" || args.importTarget === "menu_sets") {
      console.log("\n### Import: dataset_menu_sets");
      const batch = [];
      const embedBatch = [];

      for await (const row of csvObjects(menusCsvPath)) {
        menuSetsTotal++;
        if (args.limit && menuSetsTotal > args.limit) break;

        const externalId = String(row["web-scraper-order"] ?? "").trim();
        const sourceUrl = String(row["web-scraper-start-url"] ?? "").trim();
        if (!externalId) continue;

        const dishNames = [];
        const dishes = [];

        const totalKcal = toIntOrNull(row["全エネルギー(kcal)"]);
        const dish1K = toIntOrNull(row["料理1カロリー(kcal)"]) ?? 0;
        const dish3K = toIntOrNull(row["料理3カロリー(kcal)"]) ?? 0;
        const dish4K = toIntOrNull(row["料理4カロリー(kcal)"]) ?? 0;
        const dish5K = toIntOrNull(row["料理5カロリー(kcal)"]) ?? 0;

        for (let i = 1; i <= 5; i++) {
          const name = String(row[`料理${i}`] ?? "").trim().replace(/^\"|\"$/g, "");
          const classRaw = String(row[`料理${i}分類`] ?? "").trim().replace(/^\"|\"$/g, "");
          if (!name) continue;
          dishNames.push(name);

          let kcal = toIntOrNull(row[`料理${i}カロリー(kcal)`]);
          if (i === 2) {
            // 料理2カロリーは壊れているため、必ず残差で復元する
            if (totalKcal != null) kcal = totalKcal - (dish1K + dish3K + dish4K + dish5K);
          }

          const dish = {
            index: i,
            name,
            class_raw: classRaw || null,
            role: roleFromClass(classRaw),
            calories_kcal: kcal,
            sodium_g: toNumberOrNull(row[`料理${i}塩分(g)`]),
          };
          dishes.push(dish);
        }

        const { theme_raw, theme_tags } = parseTheme(row["対象献立"]);
        const title = buildMenuSetTitle(dishNames);

        const menu = {
          external_id: externalId,
          source_url: sourceUrl || null,
          title,
          theme_raw,
          theme_tags,
          dish_count: dishes.length,
          dishes,

          calories_kcal: totalKcal,
          sodium_g: toNumberOrNull(row["全食塩相当量(g)"]),
          protein_g: toNumberOrNull(row["全たんぱく質(g)"]),
          fat_g: toNumberOrNull(row["全脂質(g)"]),
          carbs_g: toNumberOrNull(row["全炭水化物(g)"]),
          sugar_g: toNumberOrNull(row["全糖質(g)"]),
          fiber_g: toNumberOrNull(row["全食物繊維(g)"]),
          fiber_soluble_g: toNumberOrNull(row["全水溶性食物繊維(g)"]),
          potassium_mg: toNumberOrNull(row["全カリウム(mg)"]),
          calcium_mg: toNumberOrNull(row["全カルシウム(g)"]), // 値はmg相当
          magnesium_mg: toNumberOrNull(row["全マグネシウム(mg)"]),
          phosphorus_mg: toNumberOrNull(row["全リン(mg)"]),
          iron_mg: toNumberOrNull(row["全鉄(mg)"]),
          zinc_mg: toNumberOrNull(row["全亜鉛(mg)"]),
          iodine_ug: toNumberOrNull(row["全ヨウ素(μg)"]),
          cholesterol_mg: toNumberOrNull(row["全コレステロール(mg)"]),
          vitamin_b1_mg: toNumberOrNull(row["全ビタミンB1(mg)"]),
          vitamin_b2_mg: toNumberOrNull(row["全ビタミンB2(mg)"]),
          vitamin_c_mg: toNumberOrNull(row["全ビタミンC(mg)"]),
          vitamin_b6_mg: toNumberOrNull(row["全ビタミンB6(mg)"]),
          vitamin_b12_ug: toNumberOrNull(row["全ビタミンB12(μg)"]),
          folic_acid_ug: toNumberOrNull(row["全葉酸(μg)"]),
          vitamin_a_ug: toNumberOrNull(row["全ビタミンA(μg)"]),
          vitamin_d_ug: toNumberOrNull(row["全ビタミンD(μg)"]),
          vitamin_k_ug: toNumberOrNull(row["全ビタミンK(μg)"]),
          vitamin_e_mg: toNumberOrNull(row["全ビタミンE(mg)"]),
          saturated_fat_g: toNumberOrNull(row["全飽和脂肪酸(g)"]),
          monounsaturated_fat_g: toNumberOrNull(row["全一価不飽和脂肪酸(g)"]),
          polyunsaturated_fat_g: toNumberOrNull(row["全多価不飽和脂肪酸(g)"]),
        };

        menu.meal_type_hint = guessMealTypeHint(menu);

        if (args.withEmbeddings) embedBatch.push(buildMenuEmbeddingText(menu));
        batch.push(menu);

        if (batch.length >= args.batchSize) {
          if (args.withEmbeddings) {
            const embeddings = await embedTexts(openai, embedBatch, args.embeddingDimensions);
            for (let i = 0; i < batch.length; i++) batch[i].content_embedding = embeddings[i];
          }

          if (!args.dryRun) {
            const { error } = await supabase.from("dataset_menu_sets").upsert(batch, {
              onConflict: "external_id",
              returning: "minimal",
            });
            if (error) throw error;
          }

          menuSetsInserted += batch.length;
          if (menuSetsInserted % 5000 === 0 || menuSetsInserted < 2000) {
            console.log(`menu_sets: inserted ${menuSetsInserted} (read ${menuSetsTotal})`);
          }
          batch.length = 0;
          embedBatch.length = 0;
        }
      }

      if (batch.length > 0) {
        if (args.withEmbeddings) {
          const embeddings = await embedTexts(openai, embedBatch, args.embeddingDimensions);
          for (let i = 0; i < batch.length; i++) batch[i].content_embedding = embeddings[i];
        }
        if (!args.dryRun) {
          const { error } = await supabase.from("dataset_menu_sets").upsert(batch, {
            onConflict: "external_id",
            returning: "minimal",
          });
          if (error) throw error;
        }
        menuSetsInserted += batch.length;
      }

      console.log(`✅ dataset_menu_sets done: inserted=${menuSetsInserted}, read=${menuSetsTotal}`);
    }

    // ----------------------------------------------------------
    // Ingredients (食材栄養)
    // ----------------------------------------------------------
    let ingredientsInserted = 0;
    let ingredientsTotal = 0;
    if (args.importTarget === "all" || args.importTarget === "ingredients") {
      console.log("\n### Import: dataset_ingredients");
      const batch = [];
      const embedBatch = [];

      const KEY_B6 = "ビタミン\nＢ6(mg)";

      for await (const row of csvObjects(ingredientsCsvPath)) {
        ingredientsTotal++;
        if (args.limit && ingredientsTotal > args.limit) break;

        const name = String(row["食品名"] ?? "").trim();
        if (!name) continue;

        const ing = {
          name,
          name_norm: normalizeIngredientNameJs(name),
          discard_rate_percent: toNumberOrNull(row["廃棄率(%)"]),
          calories_kcal: toNumberOrNull(row["エネルギー(kcal)"]),
          water_g: toNumberOrNull(row["水分(g)"]),
          protein_aa_g: toNumberOrNull(row["アミノ酸組成によるたんぱく質(g)"]),
          protein_g: toNumberOrNull(row["たんぱく質(g)"]),
          fat_fa_tg_g: toNumberOrNull(row["脂肪酸のトリアシルグリセロール当量(g)"]),
          cholesterol_mg: toNumberOrNull(row["コレステロール(mg)"]),
          fat_g: toNumberOrNull(row["脂質(g)"]),
          available_carbs_mono_eq_g: toNumberOrNull(row["利用可能炭水化物（単糖当量）(g)"]),
          available_carbs_mass_g: toNumberOrNull(row["利用可能炭水化物（質量計）(g)"]),
          available_carbs_diff_g: toNumberOrNull(row["差引き法による利用可能炭水化物(g)"]),
          fiber_g: toNumberOrNull(row["食物繊維総量(g)"]),
          sugar_alcohol_g: toNumberOrNull(row["糖アルコール(g)"]),
          carbs_g: toNumberOrNull(row["炭水化物(g)"]),
          organic_acid_g: toNumberOrNull(row["有機酸(g)"]),
          ash_g: toNumberOrNull(row["灰分(g)"]),
          sodium_mg: toNumberOrNull(row["ナトリウム(mg)"]),
          potassium_mg: toNumberOrNull(row["カリウム(mg)"]),
          calcium_mg: toNumberOrNull(row["カ ル シ ウ ム(mg)"]),
          magnesium_mg: toNumberOrNull(row["マ グ ネ シ ウ ム(mg)"]),
          phosphorus_mg: toNumberOrNull(row["リン(mg)"]),
          iron_mg: toNumberOrNull(row["鉄(mg)"]),
          zinc_mg: toNumberOrNull(row["亜　鉛(mg)"]),
          copper_mg: toNumberOrNull(row["銅(mg)"]),
          manganese_mg: toNumberOrNull(row["マンガン(mg)"]),
          iodine_ug: toNumberOrNull(row["ヨウ素(μg)"]),
          selenium_ug: toNumberOrNull(row["セレン(μg)"]),
          chromium_ug: toNumberOrNull(row["クロム(μg)"]),
          molybdenum_ug: toNumberOrNull(row["モリブデン(μg)"]),

          vitamin_a_retinol_ug: toNumberOrNull(row["ビタミンA(レチノール)(μg)"]),
          vitamin_a_alpha_carotene_ug: toNumberOrNull(row["ビタミンA(αカロテン)(μg)"]),
          vitamin_a_beta_carotene_ug: toNumberOrNull(row["ビタミンA(βカロテン)(μg)"]),
          vitamin_a_beta_cryptoxanthin_ug: toNumberOrNull(row["ビタミンA(β|クリプトキサンチン)(μg)"]),
          vitamin_a_beta_carotene_eq_ug: toNumberOrNull(row["ビタミンA(βカロテン当量)(μg)"]),
          vitamin_a_ug: toNumberOrNull(row["ビタミンA(レチノール活性当量)(μg)"]),
          vitamin_d_ug: toNumberOrNull(row["ビタミンD(μg)"]),

          vitamin_e_alpha_mg: toNumberOrNull(row["ビタミンE(α|トコフェロール)(mg)"]),
          vitamin_e_beta_mg: toNumberOrNull(row["ビタミンE(β|トコフェロール)(mg)"]),
          vitamin_e_gamma_mg: toNumberOrNull(row["ビタミンE(γ|トコフェロール)(mg)"]),
          vitamin_e_delta_mg: toNumberOrNull(row["ビタミンE(δ|トコフェロール)(mg)"]),

          vitamin_k_ug: toNumberOrNull(row["ビタミンK(μg)"]),
          vitamin_b1_mg: toNumberOrNull(row["ビタミンＢ1(mg)"]),
          vitamin_b2_mg: toNumberOrNull(row["ビタミンB2(mg)"]),
          niacin_mg: toNumberOrNull(row["ナイアシン(mg)"]),
          niacin_eq_mg: toNumberOrNull(row["ナイアシン当量(mg)"]),
          vitamin_b6_mg: toNumberOrNull(row[KEY_B6]),
          vitamin_b12_ug: toNumberOrNull(row["ビタミンＢ12(μg)"]),
          folic_acid_ug: toNumberOrNull(row["葉酸(μg)"]),
          pantothenic_acid_mg: toNumberOrNull(row["パントテン酸"]),
          biotin_ug: toNumberOrNull(row["ビオチン(μg)"]),
          vitamin_c_mg: toNumberOrNull(row["ビタミンC"]),
          alcohol_g: toNumberOrNull(row["アルコール(g)"]),
          salt_eq_g: toNumberOrNull(row["食塩相当量(g)"]),

          notes: String(row["備考"] ?? "").trim() || null,
        };

        if (args.withEmbeddings) embedBatch.push(name);
        batch.push(ing);

        if (batch.length >= args.batchSize) {
          if (args.withEmbeddings) {
            const embeddings = await embedTexts(openai, embedBatch, args.embeddingDimensions);
            for (let i = 0; i < batch.length; i++) batch[i].name_embedding = embeddings[i];
          }

          if (!args.dryRun) {
            const { error } = await supabase.from("dataset_ingredients").upsert(batch, {
              onConflict: "name_norm",
              returning: "minimal",
            });
            if (error) throw error;
          }

          ingredientsInserted += batch.length;
          if (ingredientsInserted % 1000 === 0 || ingredientsInserted < 1000) {
            console.log(`ingredients: inserted ${ingredientsInserted} (read ${ingredientsTotal})`);
          }
          batch.length = 0;
          embedBatch.length = 0;
        }
      }

      if (batch.length > 0) {
        if (args.withEmbeddings) {
          const embeddings = await embedTexts(openai, embedBatch, args.embeddingDimensions);
          for (let i = 0; i < batch.length; i++) batch[i].name_embedding = embeddings[i];
        }
        if (!args.dryRun) {
          const { error } = await supabase.from("dataset_ingredients").upsert(batch, {
            onConflict: "name_norm",
            returning: "minimal",
          });
          if (error) throw error;
        }
        ingredientsInserted += batch.length;
      }

      console.log(`✅ dataset_ingredients done: inserted=${ingredientsInserted}, read=${ingredientsTotal}`);
    }

  // ----------------------------------------------------------
  // finalize
  // ----------------------------------------------------------
    if (!args.dryRun) {
      if (importRunId) {
        const { error } = await supabase
          .from("dataset_import_runs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            menu_sets_total: menuSetsTotal,
            recipes_total: recipesTotal,
            menu_sets_inserted: menuSetsInserted,
            recipes_inserted: recipesInserted,
            ingredients_total: ingredientsTotal,
            ingredients_inserted: ingredientsInserted,
          })
          .eq("id", importRunId);
        if (error) throw error;
      } else {
        console.log("\n⚠️ dataset_import_runs のID取得に失敗したため、更新をスキップしました");
      }
    }

    console.log("\n=== done ===");
    console.log({ recipesInserted, recipesTotal, menuSetsInserted, menuSetsTotal, ingredientsInserted, ingredientsTotal });
  } catch (e) {
    if (!args.dryRun && importRunId) {
      const msg = String(e?.message ?? e ?? "").slice(0, 4000);
      await supabase
        .from("dataset_import_runs")
        .update({ status: "failed", completed_at: new Date().toISOString(), error_log: msg })
        .eq("id", importRunId);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error("❌ import failed:", e?.message ?? e);
  process.exitCode = 1;
});


