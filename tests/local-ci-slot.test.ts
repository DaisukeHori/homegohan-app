/**
 * tests/local-ci-slot.test.ts
 *
 * scripts/local-ci.sh を同じ機械で同時に複数回すための「枠 (slot)」の値の表 (scripts/lib/local-ci-slot.sh) を検査する。
 *
 *   - 枠 0 は今までと同じ値 (CI の .github/workflows/* は枠を指定しないので枠 0。変わると CI の前提が崩れる)
 *   - 枠どうしで project_id・ポートが 1 つも重ならない (重なると同時に回したスタックが互いを壊す)
 *   - scripts/supabase-local.sh が組み立てる config.toml: 枠 0 はポートを足さない (CLI の既定のまま)、
 *     枠 1 以上は CLI が開くポートをすべて枠の値にずらす
 *   - scripts/supabase-local.sh の作業ディレクトリは枠ごとに分かれ、stop / status / env は指定した枠のスタックだけに触る
 *     (同じチェックアウトで 2 つの枠を使っても、別の枠を止めたり別の枠の接続先を書いたりしない)
 *   - scripts/local-ci.sh は、持ち主の死んだ枠のロックを回収したときだけ、その枠に残ったスタックを片付ける
 *     (空いていた枠に残っているスタックは、ロックを取らずに手で起動したものかもしれないので消さずに赤にする)
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
const LOCAL_CI = "scripts/local-ci.sh";

/** supabase-local.sh の作業ディレクトリ (枠 0 は今までと同じ .supabase-local、枠 n は .supabase-local-s<n>) */
function workDirOf(slot: string | undefined): string {
  return slot === undefined || Number(slot) === 0 ? ".supabase-local" : `.supabase-local-s${Number(slot)}`;
}

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
  // CLI の代わり: --workdir の config.toml の project_id と [api] port を読んで、受け取った引数と一緒に出す
  // (status -o env では、その project_id・ポートの接続先を出す)。Docker も本物の CLI も使わない
  const fakeCli = path.join(tmp, "fake-supabase-cli.sh");
  fs.writeFileSync(
    fakeCli,
    [
      "#!/usr/bin/env bash",
      'wd=""; prev=""',
      'for a in "$@"; do [ "$prev" = "--workdir" ] && wd="$a"; prev="$a"; done',
      'cfg="$wd/supabase/config.toml"',
      'id="$(sed -n \'s/^project_id = "\\(.*\\)"$/\\1/p\' "$cfg" | head -n1)"',
      'port="$(awk \'/^\\[api\\]/ { inapi = 1; next } /^\\[/ { inapi = 0 } inapi && /^port = / { print $3 }\' "$cfg")"',
      'port="${port:-54321}"',
      'if [ "$1" = status ] && [ "${2:-}" = "-o" ]; then',
      '  printf \'API_URL="http://127.0.0.1:%s"\\nANON_KEY="anon-%s"\\nSERVICE_ROLE_KEY="service-%s"\\nJWT_SECRET="jwt-%s"\\nDB_URL="db-%s"\\n\' "$port" "$id" "$id" "$id" "$id"',
      "else",
      '  echo "FAKECLI $1 project_id=$id workdir=$(basename "$wd")"',
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const run = (slot: string | undefined, args: string[], cli = "true") => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_CLI: cli };
    if (slot !== undefined) env.LOCAL_CI_SLOT = slot;
    return spawnSync("bash", [SUPABASE_LOCAL, ...args], { cwd: tmp, env, encoding: "utf8" });
  };
  const configOf = (slot: string | undefined) => fs.readFileSync(path.join(tmp, workDirOf(slot), "supabase/config.toml"), "utf8");
  const build = (slot: string | undefined) => {
    const r = run(slot, ["migrations"]);
    return { status: r.status, stderr: r.stderr, config: r.status === 0 ? configOf(slot) : "" };
  };
  const projectIdOf = (config: string) => tomlTables(config).get("")?.get("project_id");

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

  it("作業ディレクトリは枠ごとに分かれ、枠 1 と枠 2 を続けて組み立てても枠 1 の config.toml は枠 1 のまま (枠 0 は .supabase-local)", () => {
    for (const slot of ["1", "2", "0"]) expect(build(slot).status, `枠 ${slot}`).toBe(0);
    expect(projectIdOf(configOf("1"))).toBe(`"${slotValues("1").get("SLOT_PROJECT_ID")}"`);
    expect(projectIdOf(configOf("2"))).toBe(`"${slotValues("2").get("SLOT_PROJECT_ID")}"`);
    // 枠 0 は今までと同じ場所 (.supabase-local/) に、今までと同じ project_id で組み立てる
    expect(projectIdOf(fs.readFileSync(path.join(tmp, ".supabase-local/supabase/config.toml"), "utf8"))).toBe('"homegohan-local"');
  });

  it("stop / status は、ほかの枠をあとから組み立てても、指定した枠のスタックだけに触る", () => {
    // 枠 1 → 枠 2 → 枠 0 の順に組み立てたあとで、それぞれの枠を指定して stop / status を打つ
    for (const slot of ["1", "2", "0"]) expect(build(slot).status).toBe(0);
    for (const slot of ["1", "2", "0", undefined]) {
      const id = slotValues(slot ?? "0").get("SLOT_PROJECT_ID");
      for (const cmd of ["stop", "status"]) {
        const r = run(slot, [cmd], fakeCli);
        expect(r.status, `${cmd} 枠 ${slot}: ${r.stderr}`).toBe(0);
        expect(r.stdout.trim(), `${cmd} 枠 ${slot}`).toBe(`FAKECLI ${cmd} project_id=${id} workdir=${workDirOf(slot)}`);
      }
    }
  });

  it("env は指定した枠の接続先を書く (あとから組み立てた別の枠の接続先を書かない)", () => {
    for (const slot of ["1", "0"]) expect(build(slot).status).toBe(0);
    for (const slot of ["1", "0"]) {
      const values = slotValues(slot);
      const out = path.join(tmp, `env-${slot}.txt`);
      const r = run(slot, ["env", out], fakeCli);
      expect(r.status, r.stderr).toBe(0);
      const text = fs.readFileSync(out, "utf8");
      expect(text).toContain(`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:${values.get("SLOT_API_PORT")}\n`);
      expect(text).toContain(`SUPABASE_SERVICE_ROLE_KEY=service-${values.get("SLOT_PROJECT_ID")}\n`);
    }
  });

  it("作業ディレクトリの config.toml が別の枠のもの (枠を分ける前の版が組み立てたものなど) なら、stop / status / env は CLI を呼ばずに止まる", () => {
    expect(build("1").status).toBe(0);
    expect(build("0").status).toBe(0);
    // 枠を分ける前の版では、枠 1 を組み立てると .supabase-local/ (枠 0 の場所) に枠 1 の config.toml ができていた
    const slotZeroConfig = path.join(tmp, ".supabase-local/supabase/config.toml");
    fs.writeFileSync(slotZeroConfig, configOf("1"));
    try {
      for (const args of [["stop"], ["status"], ["env", path.join(tmp, "env-mismatch.txt")]]) {
        const r = run("0", args, fakeCli);
        expect(r.status, args[0]).toBe(2);
        expect(r.stdout, args[0]).not.toContain("FAKECLI");
        expect(r.stderr, args[0]).toContain(`${slotValues("1").get("SLOT_PROJECT_ID")}`);
      }
      expect(fs.existsSync(path.join(tmp, "env-mismatch.txt"))).toBe(false);
    } finally {
      expect(build("0").status).toBe(0);
    }
  });

  it(".gitignore は枠ごとの作業ディレクトリ (.supabase-local/・.supabase-local-s<n>/) をすべて git 管理外にする", () => {
    for (const slot of ["0", "1", String(slotMax())]) {
      const rel = `${workDirOf(slot)}/supabase/config.toml`;
      const r = spawnSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: ROOT });
      expect(r.status, rel).toBe(0);
    }
  });
});

/**
 * scripts/local-ci.sh の枠のロックの関数を、スクリプトから名前で取り出して動かす (スクリプトの本体は動かさない)。
 * docker / run_in / record などは記録だけする代わりに置き換える
 */
describe("scripts/local-ci.sh: 枠に残ったスタックの片付けは、持ち主の死んだロックを回収したときだけ", () => {
  const LOCK_FUNCTIONS = [
    "file_mtime",
    "proc_lstart",
    "lock_held",
    "write_owner",
    "reclaim_lock",
    "try_lock",
    "release_lock",
    "legacy_lock_held",
    "apply_slot",
    "acquire_slot",
    "slot_stack_exists",
    "clear_slot_leftovers",
    "check_slot_stack",
  ];
  const scriptLines = fs.readFileSync(path.join(ROOT, LOCAL_CI), "utf8").split("\n");
  const extract = (name: string): string => {
    const start = scriptLines.findIndex((line) => line.startsWith(`${name}() {`));
    if (start < 0) throw new Error(`${LOCAL_CI} に関数 ${name} が無い`);
    if (/\}\s*$/.test(scriptLines[start])) return scriptLines[start];
    const end = scriptLines.findIndex((line, i) => i > start && line === "}");
    if (end < 0) throw new Error(`${LOCAL_CI} の関数 ${name} の終わりが無い`);
    return scriptLines.slice(start, end + 1).join("\n");
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-slot-lock-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const harness = path.join(tmp, "harness.sh");
  fs.writeFileSync(
    harness,
    [
      "set -u -o pipefail",
      'say() { echo "SAY $*" >&2; }',
      "now() { date +%s; }",
      'record() { echo "RECORD $*"; }',
      'run_in() { echo "RUN_IN ${*:3}"; }',
      // 枠の project_id のラベルで絞った一覧を、FAKE_CONTAINERS / FAKE_VOLUMES の中身で返す
      'docker() { case "$1" in ps) printf "%s" "${FAKE_CONTAINERS:-}" ;; volume) printf "%s" "${FAKE_VOLUMES:-}" ;; esac; }',
      "check_docker_memory() { :; }",
      'LOCK_OWNER_GRACE_SEC=60; SLOT_POLL_SEC=1; SLOT_WAIT_SECONDS=0; LEGACY_LOCK=""',
      'HEAD_SHA=test; ART="$HARNESS_TMP"; WT="$HARNESS_TMP"; APP_HOST_URL="http://localhost"; ENV_SLOT=""',
      'SLOT=""; SLOT_LOCK=""; SLOT_RECLAIMED=0; LOCK_RECLAIMED=0',
      `. "${path.join(ROOT, SLOT_LIB)}"`,
      ...LOCK_FUNCTIONS.map(extract),
      'acquire_slot || { echo "ACQUIRE_FAILED"; exit 0; }',
      'echo "SLOT=$SLOT RECLAIMED=$SLOT_RECLAIMED"',
      "clear_slot_leftovers",
      'if check_slot_stack integration; then echo "STACK_OK"; else echo "STACK_RED"; fi',
      'release_lock "$SLOT_LOCK"',
      "",
    ].join("\n"),
  );

  let caseNo = 0;
  /** 枠の候補・前もって置くロックの持ち主・残っているコンテナ / ボリュームを決めて、ハーネスを 1 回動かす */
  const runCase = (opts: { slot: string; owner?: string; containers?: string; volumes?: string; tz?: string }) => {
    caseNo += 1;
    const lockDir = path.join(tmp, `locks-${caseNo}`);
    fs.mkdirSync(lockDir, { recursive: true });
    if (opts.owner !== undefined) {
      fs.mkdirSync(path.join(lockDir, `slot-${opts.slot}`));
      fs.writeFileSync(path.join(lockDir, `slot-${opts.slot}`, "owner"), opts.owner);
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HARNESS_TMP: tmp,
      LOCK_DIR: lockDir,
      SLOT_CANDIDATES: opts.slot,
      FAKE_CONTAINERS: opts.containers ?? "",
      FAKE_VOLUMES: opts.volumes ?? "",
    };
    if (opts.tz !== undefined) env.TZ = opts.tz;
    const r = spawnSync("bash", [harness], { cwd: tmp, env, encoding: "utf8" });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  // 持ち主の死んだロック: pid 1 は生きているが、開始時刻が違う (= pid が使い回された別のプロセス) ので持ち主ではない
  const DEAD_OWNER = "pid=1\nlstart=Thu Jan  1 00:00:00 1970\n";
  // 生きている持ち主: このテストのプロセス。local-ci.sh の write_owner と同じく LC_ALL=C・TZ=UTC で開始時刻を書く
  const liveOwner = () => {
    const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" },
    }).trim();
    return `pid=${process.pid}\nlstart=${lstart}\n`;
  };

  it("空いていた枠 1 に、その枠のコンテナが残っていれば、消さずに integration:setup を赤にする", () => {
    const r = runCase({ slot: "1", containers: "c0ffee" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("SLOT=1 RECLAIMED=0");
    expect(r.out).not.toContain("RUN_IN");
    expect(r.out).toMatch(/^RECORD integration:setup RED .*homegohan-local-s1/m);
    expect(r.out).toContain("STACK_RED");
  });

  it("空いていた枠 1 に、その枠のボリュームだけが残っていても、消さずに赤にする", () => {
    const r = runCase({ slot: "1", volumes: "homegohan-local-s1_db" });
    expect(r.out).toContain("SLOT=1 RECLAIMED=0");
    expect(r.out).not.toContain("RUN_IN");
    expect(r.out).toContain("STACK_RED");
  });

  it("持ち主の死んだ枠 1 のロックを回収したときは、残ったスタックを stop-leftover で片付ける", () => {
    const r = runCase({ slot: "1", owner: DEAD_OWNER, containers: "c0ffee" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("SLOT=1 RECLAIMED=1");
    expect(r.out).toContain("RUN_IN bash scripts/supabase-local.sh stop-leftover");
  });

  it("持ち主の死んだロックを回収しても、何も残っていなければ片付けず、赤にもしない", () => {
    const r = runCase({ slot: "1", owner: DEAD_OWNER });
    expect(r.out).toContain("SLOT=1 RECLAIMED=1");
    expect(r.out).not.toContain("RUN_IN");
    expect(r.out).not.toContain("RECORD");
    expect(r.out).toContain("STACK_OK");
  });

  it("空いていて何も残っていない枠は、そのまま使う", () => {
    const r = runCase({ slot: "1" });
    expect(r.out).toContain("SLOT=1 RECLAIMED=0");
    expect(r.out).not.toContain("RUN_IN");
    expect(r.out).not.toContain("RECORD");
    expect(r.out).toContain("STACK_OK");
  });

  it("枠 0 は、回収したときも残りがあるときも片付けず、赤にもしない (枠を使わない作業と共有している)", () => {
    const r = runCase({ slot: "0", owner: DEAD_OWNER, containers: "c0ffee", volumes: "v" });
    expect(r.out).toContain("SLOT=0 RECLAIMED=1");
    expect(r.out).not.toContain("RUN_IN");
    expect(r.out).not.toContain("RECORD");
    expect(r.out).toContain("STACK_OK");
  });

  it("integration / e2e の段は、ローカル Supabase を起動する前に、枠に残ったスタックを確かめる (check_slot_stack)", () => {
    for (const [fn, stage] of [
      ["stage_integration", "integration"],
      ["stage_e2e", "e2e"],
    ]) {
      const body = extract(fn).split("\n");
      const check = body.findIndex((line) => line.trim() === `check_slot_stack ${stage} || return 0`);
      const start = body.findIndex((line) => line.includes("bash scripts/supabase-local.sh start"));
      expect(check, `${fn} に check_slot_stack ${stage} が無い`).toBeGreaterThan(0);
      expect(start, `${fn} に supabase-local.sh start が無い`).toBeGreaterThan(0);
      expect(check, `${fn} の check_slot_stack が起動より後にある`).toBeLessThan(start);
    }
  });

  it("持ち主が生きているロックは、確かめる実行のタイムゾーンが書いた実行と違っても回収しない (枠を取れず、片付けもしない)", () => {
    for (const tz of [undefined, "UTC", "Asia/Tokyo", "America/New_York"]) {
      const r = runCase({ slot: "1", owner: liveOwner(), containers: "c0ffee", tz });
      expect(r.out, `TZ=${tz}`).toContain("ACQUIRE_FAILED");
      expect(r.out, `TZ=${tz}`).not.toContain("RUN_IN");
    }
  });
});
