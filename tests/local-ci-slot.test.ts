/**
 * tests/local-ci-slot.test.ts
 *
 * scripts/local-ci.sh を同じ機械で同時に複数回すための「枠 (slot)」の値の表 (scripts/lib/local-ci-slot.sh) を検査する。
 *
 *   - 枠 0 は今までと同じ値 (CI の .github/workflows/* は枠を指定しないので枠 0。変わると CI の前提が崩れる)
 *   - 枠どうしで project_id・ポートが 1 つも重ならない (重なると同時に回したスタックが互いを壊す)
 *   - scripts/supabase-local.sh が組み立てる config.toml: 枠 0 はポートを足さない (CLI の既定のまま)、
 *     枠 1 以上は CLI が開くポートをすべて枠の値にずらす
 *
 * 値はスクリプトを実際に実行して得る (文字列を読んで推測しない)。
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SLOT_LIB = "scripts/lib/local-ci-slot.sh";
const SUPABASE_LOCAL = "scripts/supabase-local.sh";

/** 今まで (枠を入れる前) の値。CI はこの値で動いている */
const SLOT_ZERO_EXPECTED: Record<string, string> = {
  SLOT_PROJECT_ID: "homegohan-local",
  // Supabase CLI 2.62.10 の既定 (`npx supabase@2.62.10 init` が生成する config.toml の値)
  SLOT_API_PORT: "54321",
  SLOT_DB_PORT: "54322",
  SLOT_SHADOW_PORT: "54320",
  SLOT_STUDIO_PORT: "54323",
  SLOT_INBUCKET_PORT: "54324",
  SLOT_INBUCKET_SMTP_PORT: "54325",
  SLOT_INBUCKET_POP3_PORT: "54326",
  SLOT_ANALYTICS_PORT: "54327",
  SLOT_POOLER_PORT: "54329",
  SLOT_INSPECTOR_PORT: "8083",
  // 今までの local-ci.sh が空きを確かめていたポート (LOCAL_CI_SUPABASE_PORTS の既定)
  SLOT_SUPABASE_PORTS: "54320 54321 54322 54323 54324 54325 54326 54327 54328 54329",
  // CI の yml (e2e-local.yml / security-regression.yml) と同じ Next のポート
  SLOT_APP_PORT: "3000",
  SLOT_ENFORCED_APP_PORT: "3001",
  SLOT_NOTICE_APP_PORT: "3002",
};

/** 1 つの値が 1 つのポートである変数 (SLOT_SUPABASE_PORTS は範囲、SLOT_PROJECT_ID は名前) */
const SUPABASE_PORT_VARS = [
  "SLOT_API_PORT",
  "SLOT_DB_PORT",
  "SLOT_SHADOW_PORT",
  "SLOT_STUDIO_PORT",
  "SLOT_INBUCKET_PORT",
  "SLOT_INBUCKET_SMTP_PORT",
  "SLOT_INBUCKET_POP3_PORT",
  "SLOT_ANALYTICS_PORT",
  "SLOT_POOLER_PORT",
];
const NEXT_PORT_VARS = ["SLOT_APP_PORT", "SLOT_ENFORCED_APP_PORT", "SLOT_NOTICE_APP_PORT"];
const SINGLE_PORT_VARS = [...SUPABASE_PORT_VARS, "SLOT_INSPECTOR_PORT", ...NEXT_PORT_VARS];

/** 特権ポートと、TCP のポート番号の上限 */
const MIN_UNPRIVILEGED_PORT = 1024;
const MAX_PORT = 65535;

/** config.toml の表 (枠 1 以上で足す) と、そこに書くキー → 値の変数 */
const SLOT_CONFIG: Array<{ table: string; key: string; slotVar: string }> = [
  { table: "api", key: "port", slotVar: "SLOT_API_PORT" },
  { table: "db", key: "port", slotVar: "SLOT_DB_PORT" },
  { table: "db", key: "shadow_port", slotVar: "SLOT_SHADOW_PORT" },
  { table: "db.pooler", key: "port", slotVar: "SLOT_POOLER_PORT" },
  { table: "studio", key: "port", slotVar: "SLOT_STUDIO_PORT" },
  { table: "inbucket", key: "port", slotVar: "SLOT_INBUCKET_PORT" },
  { table: "inbucket", key: "smtp_port", slotVar: "SLOT_INBUCKET_SMTP_PORT" },
  { table: "inbucket", key: "pop3_port", slotVar: "SLOT_INBUCKET_POP3_PORT" },
  { table: "analytics", key: "port", slotVar: "SLOT_ANALYTICS_PORT" },
  { table: "edge_runtime", key: "inspector_port", slotVar: "SLOT_INSPECTOR_PORT" },
];

function slotValues(slot: string): Map<string, string> {
  const out = execFileSync("bash", [SLOT_LIB, slot], { cwd: ROOT, encoding: "utf8" });
  const values = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^(SLOT_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) values.set(m[1], m[2]);
  }
  return values;
}

function slotMax(): number {
  const text = fs.readFileSync(path.join(ROOT, SLOT_LIB), "utf8");
  const m = /^readonly LCS_SLOT_MAX=(\d+)$/m.exec(text);
  if (!m) throw new Error(`${SLOT_LIB} に LCS_SLOT_MAX が無い`);
  return Number(m[1]);
}

/** 枠ごとに使うポートすべて (範囲 + 個別) */
function portsOf(values: Map<string, string>): number[] {
  const block = (values.get("SLOT_SUPABASE_PORTS") ?? "").split(" ").filter(Boolean).map(Number);
  return Array.from(new Set([...block, ...SINGLE_PORT_VARS.map((v) => Number(values.get(v)))]));
}

/** config.toml の「表 → キー → 値」 (このテストが必要な範囲の簡単な読み取り) */
function tomlTables(text: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  let current = "";
  tables.set(current, new Map());
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const t = /^\[([^\]]+)\]$/.exec(line);
    if (t) {
      if (tables.has(t[1])) throw new Error(`表 [${t[1]}] が 2 回ある`);
      current = t[1];
      tables.set(current, new Map());
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (kv) tables.get(current)?.set(kv[1], kv[2]);
  }
  return tables;
}

describe("scripts/lib/local-ci-slot.sh の枠ごとの値", () => {
  const max = slotMax();
  const all = Array.from({ length: max + 1 }, (_, slot) => ({ slot, values: slotValues(String(slot)) }));

  it("枠 0 は今までの値 (CI が使う値) と同じ", () => {
    expect(Object.fromEntries(slotValues("0"))).toEqual(SLOT_ZERO_EXPECTED);
  });

  it("すべての枠が全部の変数を出す (空の値が無い)", () => {
    for (const { slot, values } of all) {
      expect(Array.from(values.keys()).sort(), `枠 ${slot}`).toEqual(Object.keys(SLOT_ZERO_EXPECTED).sort());
      for (const [name, value] of values) expect(value, `枠 ${slot} の ${name}`).not.toBe("");
    }
  });

  it("枠どうしで project_id もポートも 1 つも重ならない (枠の中でも重ならない)", () => {
    const ids = all.map(({ values }) => values.get("SLOT_PROJECT_ID"));
    expect(new Set(ids).size).toBe(all.length);
    const owner = new Map<number, string>();
    for (const { slot, values } of all) {
      const singles = SINGLE_PORT_VARS.map((v) => Number(values.get(v)));
      expect(new Set(singles).size, `枠 ${slot} の中でポートが重なる`).toBe(singles.length);
      for (const port of portsOf(values)) {
        expect(owner.get(port), `ポート ${port} が枠 ${owner.get(port)} と枠 ${slot} で重なる`).toBeUndefined();
        owner.set(port, String(slot));
      }
    }
  });

  it("ポートはすべて 1024〜65535 の整数で、Supabase のポートは枠の範囲 (SLOT_SUPABASE_PORTS) に入っている", () => {
    for (const { slot, values } of all) {
      for (const port of portsOf(values)) {
        expect(Number.isInteger(port) && port >= MIN_UNPRIVILEGED_PORT && port <= MAX_PORT, `枠 ${slot} のポート ${port}`).toBe(true);
      }
      const block = new Set((values.get("SLOT_SUPABASE_PORTS") ?? "").split(" ").map(Number));
      for (const v of SUPABASE_PORT_VARS) {
        expect(block.has(Number(values.get(v))), `枠 ${slot} の ${v}=${values.get(v)} が範囲に無い`).toBe(true);
      }
    }
  });

  it("範囲外の枠・整数でない枠は受け付けない", () => {
    for (const bad of [String(max + 1), "-1", "x", "1.5", ""]) {
      const r = spawnSync("bash", [SLOT_LIB, bad], { cwd: ROOT, encoding: "utf8" });
      expect(r.status, `枠 "${bad}"`).not.toBe(0);
      expect(r.stdout, `枠 "${bad}"`).toBe("");
    }
  });
});

describe("scripts/supabase-local.sh が枠に合わせて組み立てる config.toml", () => {
  // リポジトリの .supabase-local/ (動いているスタックが使っているかもしれない) に触れないよう、必要なファイルだけを
  // 一時的な git リポジトリに写して、migrations (config.toml を組み立てて migration を並べるだけ。Docker も CLI も使わない) を回す
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-slot-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const copy = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
  };
  for (const rel of [SUPABASE_LOCAL, SLOT_LIB, "supabase/config.toml", "supabase/baseline/manifest.json"]) copy(rel);
  fs.mkdirSync(path.join(tmp, "supabase/migrations"), { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: tmp });

  const repoConfig = tomlTables(fs.readFileSync(path.join(ROOT, "supabase/config.toml"), "utf8"));
  const build = (slot: string | undefined) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_CLI: "true" };
    if (slot !== undefined) env.LOCAL_CI_SLOT = slot;
    const r = spawnSync("bash", [SUPABASE_LOCAL, "migrations"], { cwd: tmp, env, encoding: "utf8" });
    return { status: r.status, stderr: r.stderr, config: r.status === 0 ? fs.readFileSync(path.join(tmp, ".supabase-local/supabase/config.toml"), "utf8") : "" };
  };

  it("リポジトリの config.toml は、枠でずらす表を持っていない (持つと枠 0 が CLI の既定でなくなり、枠 1 以上は表が 2 回になる)", () => {
    for (const { table } of SLOT_CONFIG) expect(repoConfig.has(table), `[${table}]`).toBe(false);
    expect(repoConfig.has("auth")).toBe(false);
  });

  it("枠を指定しない (CI) と LOCAL_CI_SLOT=0 は同じ config.toml で、ポートも認証の戻り先も足さない", () => {
    const unset = build(undefined);
    const zero = build("0");
    expect(unset.status, unset.stderr).toBe(0);
    expect(zero.config).toBe(unset.config);
    const tables = tomlTables(unset.config);
    expect(tables.get("")?.get("project_id")).toBe('"homegohan-local"');
    for (const { table } of SLOT_CONFIG) expect(tables.has(table), `[${table}]`).toBe(false);
    expect(tables.has("auth")).toBe(false);
  });

  it("枠 1 以上は、CLI が開くポートをすべて枠の値にし、認証の戻り先を枠の Next に向ける", () => {
    for (const slot of ["1", String(slotMax())]) {
      const values = slotValues(slot);
      const r = build(slot);
      expect(r.status, r.stderr).toBe(0);
      const tables = tomlTables(r.config);
      expect(tables.get("")?.get("project_id")).toBe(`"${values.get("SLOT_PROJECT_ID")}"`);
      for (const { table, key, slotVar } of SLOT_CONFIG) {
        expect(tables.get(table)?.get(key), `枠 ${slot} の [${table}] ${key}`).toBe(values.get(slotVar));
      }
      expect(tables.get("auth")?.get("site_url")).toBe(`"http://127.0.0.1:${values.get("SLOT_APP_PORT")}"`);
      expect(tables.get("auth")?.get("additional_redirect_urls")).toBe(`["https://127.0.0.1:${values.get("SLOT_APP_PORT")}"]`);
      // ローカル専用の認証のレート制限は枠 0 と同じく残る
      expect(tables.get("auth.rate_limit")?.get("sign_in_sign_ups")).toBe("1000");
    }
  });

  it("範囲外の枠は config.toml を作らずに止まる", () => {
    const r = build(String(slotMax() + 1));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("LOCAL_CI_SLOT");
  });
});
