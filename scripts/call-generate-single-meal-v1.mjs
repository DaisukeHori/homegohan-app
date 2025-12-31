/**
 * generate-single-meal (v1) を叩くための簡易スクリプト（デプロイ後の動作確認用）
 *
 * 例:
 *   node scripts/call-generate-single-meal-v1.mjs --user <uuid> --date 2026-01-06 --meal lunch --note "ヘルシーに"
 *
 * 必須環境変数:
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import process from "node:process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { userId: null, dayDate: null, mealType: null, note: null, requestId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user" && argv[i + 1]) args.userId = argv[++i];
    else if ((a === "--date" || a === "--day") && argv[i + 1]) args.dayDate = argv[++i];
    else if ((a === "--meal" || a === "--mealType") && argv[i + 1]) args.mealType = argv[++i];
    else if (a === "--note" && argv[i + 1]) args.note = argv[++i];
    else if (a === "--requestId" && argv[i + 1]) args.requestId = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  return args;
}

function printHelp() {
  console.log(`
使い方:
  node scripts/call-generate-single-meal-v1.mjs --user <uuid> --date YYYY-MM-DD --meal <breakfast|lunch|dinner|snack|midnight_snack> [--note "..."] [--requestId <uuid>]

必須環境変数:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
`);
}

function tryLoadEnvLocal() {
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "..", ".env.local"),
  ];
  const p = candidates.find((x) => fs.existsSync(x));
  if (!p) return;
  const content = fs.readFileSync(p, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null && v) process.env[k] = v;
  }
  if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
}

async function main() {
  tryLoadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.userId || !args.dayDate || !args.mealType) {
    printHelp();
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const url = mustGetEnv("SUPABASE_URL");
  const key = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");

  const res = await fetch(`${url}/functions/v1/generate-single-meal`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: args.userId,
      dayDate: args.dayDate,
      mealType: args.mealType,
      note: args.note,
      requestId: args.requestId,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`❌ failed (${res.status}):`, text);
    process.exitCode = 1;
    return;
  }
  console.log(text);
}

main().catch((e) => {
  console.error("❌ error:", e?.message ?? e);
  process.exitCode = 1;
});


