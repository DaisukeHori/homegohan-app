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
 *   - scripts/local-ci.sh の枠のロックは、同時に同じ死んだロックを回収しに来ても 1 本しか取れない。ロックを外すのも回収と同時に走らない。
 *     持ち主が生きているか確かめられないときは回収しない
 *   - scripts/local-ci.sh は、ローカル Supabase を止めきれなかったとき (同じ dockerd の別の枠の prune と重なったときなど。#1616)、
 *     止める前に控えた自分の枠のコンテナ・ボリュームだけを消し、消えたかを確かめる (残れば <段>:teardown を赤)。
 *     次の段の前に残っているのが、この実行が前の段で起動したものだけなら片付けて進み、ほかのものがあれば今までどおり消さずに赤。
 *     scripts/supabase-local.sh の stop / stop-leftover は、prune の衝突のときだけ間をおいて打ち直す
 *   - scripts/local-ci.sh の回収の見張りは、シグナル (INT / TERM / HUP。Ctrl-C のようにプロセスグループ全体に届くものを含む) で
 *     どこで終わっても残らない (残ると、その枠の死んだロックを誰も回収できなくなる)。外すときに、別の実行が取り直した見張りは消さない
 *
 * 値はスクリプトを実際に実行して得る (文字列を読んで推測しない)。
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveUnitSlotTestTimeout, testsWithUnexpectedTimeout } from "./helpers/local-ci-slot-test-timeout";
import { SLOT_LIB, slotMaxOf, slotValueTable, slotValuesOf } from "./helpers/local-ci-slot-values";

const ROOT = process.cwd();

// 1 件のテストの時間切れを、このファイルだけ延ばす (bash・git を何度も起動するので、負荷の高い機械で vitest の既定の 5 秒を超える。
// 根拠と環境変数での上書きは tests/helpers/local-ci-slot-test-timeout.ts。#1488)。テストを定義する前に置く。
// beforeAll (bash を共有の 1 回だけ起動して、枠の値を読む・config.toml を組み立てる。#1496) の時間切れも同じ値にする
// (同じ起動を、以前は 1 件のテストの中でしていた。負荷の高い機械ではフックの既定の 10 秒を超えうる)
const SLOT_TEST_TIMEOUT_MS = resolveUnitSlotTestTimeout(process.env);
vi.setConfig({ testTimeout: SLOT_TEST_TIMEOUT_MS, hookTimeout: SLOT_TEST_TIMEOUT_MS });
// 同時に走らせる実行どうしの競合を確かめるテストの、個別の時間切れ (と、ハーネスを打ち切る上限)
const RACE_TIMEOUT_MS = 30_000;
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
  SLOT_VECTOR_PORT: "54328",
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
  "SLOT_VECTOR_PORT",
  "SLOT_POOLER_PORT",
];
const NEXT_PORT_VARS = ["SLOT_APP_PORT", "SLOT_ENFORCED_APP_PORT", "SLOT_NOTICE_APP_PORT"];
const SINGLE_PORT_VARS = [...SUPABASE_PORT_VARS, "SLOT_INSPECTOR_PORT", ...NEXT_PORT_VARS];

/**
 * Apple が文書にしている、Apple のソフトウェアが使う TCP のポート (1024〜49151 の行。UDP だけの行は除く)。
 * 出典: 「TCP and UDP ports used by Apple software products」 https://support.apple.com/en-us/103229 (2026-10-11 に確認)。
 * macOS が既定で待ち受けるもの (3031 の Remote Apple Events = eppc は launchd が持つ、5000 / 7000 は AirPlay レシーバー、
 * 3283 は Apple Remote Desktop など) を含む。2026-10-10 に M2 で 3031 を launchd が LISTEN していて、枠 3 の e2e
 * (当時の Next のポートは 3030〜3032) が毎回「使用中のポート 3031」で赤になった。
 * 表のうち 49152〜65535 (動的に割り当てるポートの範囲。AirPlay・機器のペアリングなどが一時的に使う) は入れない
 * (ローカル Supabase の CLI の既定 54320〜54329 = 枠 0 がこの範囲にあり、避けようがない)
 */
const APPLE_TCP_PORT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [2197, 2197], // mnp-exchange (Push 通知)
  [3031, 3031], // eppc (Remote Apple Events)
  [3283, 3283], // net-assistant (Apple Remote Desktop)
  [3284, 3285], // Classroom
  [3689, 3689], // daap (iTunes の共有・AirPlay)
  [3690, 3690], // svn (Xcode Server)
  [5000, 5000], // AirPlay
  [5100, 5100], // カメラ・スキャナーの共有
  [5223, 5223], // Push 通知・iCloud・FaceTime など
  [5228, 5228], // Spotlight の候補・Siri
  [5297, 5297], // メッセージ (ローカルの通信)
  [5900, 5900], // rfb (画面共有・Apple Remote Desktop)
  [6000, 6000], // AirPlay
  [7000, 7000], // AirPlay
  [8000, 8999], // Web サービス・iTunes Radio
  [9100, 9100], // ネットワークプリンターへの印刷
  [9418, 9418], // git (Xcode Server)
  [42000, 42999], // iTunes Radio
];
const isAppleTcpPort = (port: number) => APPLE_TCP_PORT_RANGES.some(([lo, hi]) => port >= lo && port <= hi);

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
  { table: "analytics", key: "vector_port", slotVar: "SLOT_VECTOR_PORT" },
  { table: "edge_runtime", key: "inspector_port", slotVar: "SLOT_INSPECTOR_PORT" },
];

/**
 * 枠の SLOT_*=値。スクリプトを実際に実行して得る。全部の枠を 1 回の起動でまとめて読み、使い回す
 * (以前は呼ぶたびに bash を起動していた。#1496。読み方は tests/helpers/local-ci-slot-values.ts)
 */
function slotValues(slot: string): Map<string, string> {
  return slotValuesOf(ROOT, slot);
}

function slotMax(): number {
  return slotMaxOf(ROOT);
}

// 全部の枠の値を、最初のテストの前に 1 回だけ読む (読めなければ、ここで落ちる)
beforeAll(() => {
  expect(slotValueTable(ROOT).size).toBe(slotMax() + 1);
});

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
  let all: Array<{ slot: number; values: Map<string, string> }> = [];
  beforeAll(() => {
    all = Array.from({ length: max + 1 }, (_, slot) => ({ slot, values: slotValues(String(slot)) }));
  });

  it("全部の枠をまとめて読んだ値は、枠を 1 つずつ指定してスクリプトを起動した値と同じ (まとめて読む仕組みの確かめ)", () => {
    for (const slot of [0, max]) {
      const out = execFileSync("bash", [SLOT_LIB, String(slot)], { cwd: ROOT, encoding: "utf8" });
      const direct = new Map(
        out
          .split("\n")
          .map((line) => /^(SLOT_[A-Z0-9_]+)=(.*)$/.exec(line))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => [m[1], m[2]] as const),
      );
      expect(direct.size, `枠 ${slot}`).toBeGreaterThan(0);
      expect(all[slot].values, `枠 ${slot}`).toEqual(direct);
    }
  });

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

  it("枠 1 以上の Next のポートは 3100 + 枠 × 10 からの 3 つ (枠 0 の 3000〜3002 とは別の帯)", () => {
    expect([1, 3, max].map((slot) => NEXT_PORT_VARS.map((v) => all[slot].values.get(v)))).toEqual([
      ["3110", "3111", "3112"],
      ["3130", "3131", "3132"],
      [String(3100 + max * 10), String(3100 + max * 10 + 1), String(3100 + max * 10 + 2)],
    ]);
  });

  it("Next のポートと Supabase のポートの範囲は、Apple が文書にしている macOS の既定のポート (3031 の Remote Apple Events など) と重ならない", () => {
    expect(isAppleTcpPort(3031), "表の読み方の確かめ (枠 3 を赤にしていたポート)").toBe(true);
    for (const { slot, values } of all) {
      const block = (values.get("SLOT_SUPABASE_PORTS") ?? "").split(" ").filter(Boolean).map(Number);
      for (const port of [...NEXT_PORT_VARS.map((v) => Number(values.get(v))), ...block]) {
        expect(isAppleTcpPort(port), `枠 ${slot} のポート ${port}`).toBe(false);
      }
    }
    // inspector_port (枠 0 は CLI の既定 8083) は表の 8000〜8999 (Apple の Web サービスへの外向きの接続) に入るが、
    // supabase start では開かない (functions serve --inspect のときだけ) ので、空きを確かめる範囲にも入れていない
  });

  it("Supabase のポートの範囲 (SLOT_SUPABASE_PORTS) は、どれも名前の付いた CLI のポートで、そのすべてを config.toml でずらす (範囲だけ確かめて、ずらし忘れるポートが無い)", () => {
    for (const { slot, values } of all) {
      const block = (values.get("SLOT_SUPABASE_PORTS") ?? "").split(" ").map(Number).sort((a, b) => a - b);
      const named = SUPABASE_PORT_VARS.map((v) => Number(values.get(v))).sort((a, b) => a - b);
      expect(named, `枠 ${slot}`).toEqual(block);
    }
    // inspector_port は supabase start では開かないので範囲に入れないが、config.toml ではずらす
    const shifted = new Set(SLOT_CONFIG.map(({ slotVar }) => slotVar));
    for (const v of [...SUPABASE_PORT_VARS, "SLOT_INSPECTOR_PORT"]) expect(shifted.has(v), `${v} を config.toml に書いていない`).toBe(true);
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

  // 枠 1 → 枠 2 → 枠 0 の順に 1 回だけ組み立て、下の「作業ディレクトリ」「stop / status」「env」「別の枠の config.toml」の
  // テストで共有する (以前はテストごとに同じ順で組み立て直していた。#1496)。どのテストも、ほかの枠をあとから組み立てたあとの
  // 状態を確かめる (枠 1 のあとに枠 2・枠 0、枠 2 のあとに枠 0)。間のテストが枠 (枠 0・枠 1・上限の枠) を組み立て直しても、
  // 枠ごとの作業ディレクトリは分かれているので、その状態は「ほかの枠をあとから組み立てた」ままになる
  const SHARED_BUILD_ORDER = ["1", "2", "0"] as const;
  let sharedBuilds: Array<{ slot: string; status: number | null; stderr: string }> = [];
  beforeAll(() => {
    sharedBuilds = SHARED_BUILD_ORDER.map((slot) => ({ slot, ...build(slot) }));
  });
  const expectSharedBuilds = () => {
    expect(sharedBuilds.map(({ slot, status, stderr }) => [slot, status, status === 0 ? "" : stderr])).toEqual(
      SHARED_BUILD_ORDER.map((slot) => [slot, 0, ""]),
    );
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

  it("作業ディレクトリは枠ごとに分かれ、枠 1 と枠 2 を続けて組み立てても枠 1 の config.toml は枠 1 のまま (枠 0 は .supabase-local)", () => {
    expectSharedBuilds();
    expect(projectIdOf(configOf("1"))).toBe(`"${slotValues("1").get("SLOT_PROJECT_ID")}"`);
    expect(projectIdOf(configOf("2"))).toBe(`"${slotValues("2").get("SLOT_PROJECT_ID")}"`);
    // 枠 0 は今までと同じ場所 (.supabase-local/) に、今までと同じ project_id で組み立てる
    expect(projectIdOf(fs.readFileSync(path.join(tmp, ".supabase-local/supabase/config.toml"), "utf8"))).toBe('"homegohan-local"');
  });

  it("stop / status は、ほかの枠をあとから組み立てても、指定した枠のスタックだけに触る", () => {
    // beforeAll が枠 1 → 枠 2 → 枠 0 の順に組み立て、そのあと間のテストが枠 0 (枠の指定なし・枠 0) → 枠 1 → 上限の枠の順に
    // 組み立て直している (枠 2 のあとに枠 0・枠 1・上限の枠、枠 0 のあとに枠 1・上限の枠、枠 1 のあとに上限の枠を組み立てた状態)。
    // その状態で、それぞれの枠を指定して stop / status を打つ
    expectSharedBuilds();
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
    // beforeAll が枠 1 → 枠 2 → 枠 0 の順に組み立て、そのあと間のテストが枠 0 (枠の指定なし・枠 0) → 枠 1 → 上限の枠の順に
    // 組み立て直している (枠 0 のあとに枠 1・上限の枠、枠 1 のあとに上限の枠を組み立てた状態)
    expectSharedBuilds();
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
    // 枠 1 と枠 0 は組み立て済み (beforeAll)
    expectSharedBuilds();
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
 * docker / run_in / record などは記録だけする代わりに置き換える。
 * 同時に動かすときの順序を決めるため、環境変数で次の待ちを差し込める (どれも指定しなければ何もしない):
 *   HOOK_PS_DELAY       ps を呼ぶ前に待つ秒数 (持ち主が生きているかの確かめが遅い実行)
 *   HOOK_PS_FAIL        1 なら ps を失敗させる (fork の失敗などで ps が動かない)
 *   HOOK_SAY_DELAY      say (回収するときの表示) のあとで待つ秒数
 *   HOOK_LOCK / HOOK_REMKDIR_DELAY  HOOK_LOCK のディレクトリを 2 回目に mkdir する直前 (回収したあとの作り直し) に待つ秒数
 *   HOOK_LOCK_MADE_DELAY  HOOK_LOCK のディレクトリを mkdir した直後 (持ち主を書く前・SLOT_LOCK に入れる前) に LOCK_MADE を出して待つ秒数
 *   HOOK_GUARD_CREATED_DELAY  見張りのファイルを作った直後 (GUARD_HELD に入れる前) に GUARD_CREATED を出して待つ秒数
 *   HOOK_RM_LOCK_DELAY  HOOK_LOCK のディレクトリを rm する直前に RM_LOCK を出して待つ秒数 (見張りを持ってロックを外している最中)
 *   HOOK_RM_GUARD       HOOK_LOCK の見張りを rm するときの振る舞い。killed-once: 1 回目は消さずに 130 で返す (Ctrl-C で止められた rm)。
 *                       pause: 消したあとに GUARD_REMOVED を出して HOOK_PAUSE_SEC 秒待つ (GUARD_HELD を空にする前)
 * 待ちの sleep は、テストがプロセスグループに送るシグナル (Ctrl-C と同じ届き方) で止まる
 */
describe("scripts/local-ci.sh: 枠のロック (回収・片付け・外し方)", () => {
  const LOCK_FUNCTIONS = [
    "file_mtime",
    "proc_lstart",
    "init_owner_identity",
    "exit_on_signal",
    "on_signal",
    "defer_signals",
    "resume_signals",
    "signal_pending",
    "install_signal_traps",
    "read_owner",
    "lock_held",
    "write_owner",
    "make_lock",
    "create_guard_file",
    "make_guard",
    "guard_is_mine",
    "take_guard",
    "drop_guard",
    "warn_stale_guard",
    "reclaim_lock",
    "try_lock",
    "release_lock",
    "legacy_lock_held",
    "apply_slot",
    "slot_busy_ports",
    "acquire_slot",
    "slot_containers",
    "slot_volumes",
    "slot_stack_exists",
    "in_list",
    "remember_own_stack",
    "own_stack_only",
    "clear_own_stack",
    "clear_slot_leftovers",
    "check_slot_stack",
    "cleanup",
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
  /** スクリプトの定数 (readonly NAME=値) の値 */
  const constant = (name: string): string => {
    const m = new RegExp(`^readonly ${name}=([0-9]+)\\b`).exec(scriptLines.find((line) => line.startsWith(`readonly ${name}=`)) ?? "");
    if (!m) throw new Error(`${LOCAL_CI} に定数 ${name} が無い`);
    return m[1];
  };
  // 見張りを作った直後・消した直後などで待つ秒数 (テストがシグナルを送ると、待ちの sleep はその場で止まる)
  const HOOK_PAUSE_SEC = 10;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-slot-lock-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const prelude = [
    "set -u -o pipefail",
    'say() { echo "SAY $*" >&2; if [ -n "${HOOK_SAY_DELAY:-}" ]; then sleep "$HOOK_SAY_DELAY"; fi; return 0; }',
    'ps() { if [ -n "${HOOK_PS_FAIL:-}" ]; then return 1; fi; if [ -n "${HOOK_PS_DELAY:-}" ]; then sleep "$HOOK_PS_DELAY"; fi; command ps "$@"; }',
    "HOOK_MKDIR_N=0",
    'mkdir() { if [ -n "${HOOK_LOCK:-}" ] && [ "$1" = "$HOOK_LOCK" ]; then HOOK_MKDIR_N=$((HOOK_MKDIR_N + 1)); if [ "$HOOK_MKDIR_N" = 2 ] && [ -n "${HOOK_REMKDIR_DELAY:-}" ]; then sleep "$HOOK_REMKDIR_DELAY"; fi; if [ -n "${HOOK_LOCK_MADE_DELAY:-}" ]; then command mkdir "$@" || return; echo "LOCK_MADE"; sleep "$HOOK_LOCK_MADE_DELAY"; return 0; fi; fi; command mkdir "$@"; }',
    `HOOK_RM_GUARD_KILLED=0; HOOK_PAUSE_SEC=${HOOK_PAUSE_SEC}`,
    [
      'rm() { local target; for target; do :; done',
      '  if [ -n "${HOOK_LOCK:-}" ] && [ "$target" = "$HOOK_LOCK" ] && [ -n "${HOOK_RM_LOCK_DELAY:-}" ]; then echo "RM_LOCK"; sleep "$HOOK_RM_LOCK_DELAY"; fi',
      '  if [ -n "${HOOK_LOCK:-}" ] && [ "$target" = "$HOOK_LOCK.reclaim" ]; then',
      '    case "${HOOK_RM_GUARD:-}" in',
      '      killed-once) if [ "$HOOK_RM_GUARD_KILLED" = 0 ]; then HOOK_RM_GUARD_KILLED=1; echo "RM_GUARD_KILLED"; return 130; fi ;;',
      '      pause) command rm "$@"; echo "GUARD_REMOVED"; sleep "$HOOK_PAUSE_SEC"; return 0 ;;',
      "    esac",
      "  fi",
      '  command rm "$@"; }',
    ].join("\n"),
    "now() { date +%s; }",
    'record() { echo "RECORD $*"; }',
    // stop-leftover で残ったスタックを片付けたら、FAKE_BUSY_UNTIL_CLEARED を消す (そのスタックが持っていたポートが空く)
    'run_in() { echo "RUN_IN ${*:3}"; if [ -n "${FAKE_BUSY_UNTIL_CLEARED:-}" ]; then command rm -f "$FAKE_BUSY_UNTIL_CLEARED"; fi; }',
    // 枠の project_id のラベルで絞った一覧を、FAKE_CONTAINERS / FAKE_VOLUMES の中身で返す
    'docker() { case "$1" in ps) printf "%s" "${FAKE_CONTAINERS:-}" ;; volume) printf "%s" "${FAKE_VOLUMES:-}" ;; esac; }',
    "check_docker_memory() { :; }",
    // ポートの空きの確かめ: FAKE_BUSY_PORTS (空白区切り) に入っているポートだけを使用中とみなす。
    // FAKE_BUSY_UNTIL_CLEARED のファイルがある間は、FAKE_BUSY_PORTS_BEFORE_CLEAR のポートも使用中 (残ったスタックが持つポート)
    [
      'busy_ports() { local p out=""; for p; do',
      '  case " ${FAKE_BUSY_PORTS:-} " in *" $p "*) out="$out${out:+ }$p"; continue ;; esac',
      '  if [ -n "${FAKE_BUSY_UNTIL_CLEARED:-}" ] && [ -e "$FAKE_BUSY_UNTIL_CLEARED" ]; then case " ${FAKE_BUSY_PORTS_BEFORE_CLEAR:-} " in *" $p "*) out="$out${out:+ }$p" ;; esac; fi',
      'done; printf "%s" "$out"; [ -n "$out" ]; }',
    ].join("\n"),
    // 回す段 (HARNESS_STAGES。既定は integration と e2e の両方)
    'want() { case ",${HARNESS_STAGES:-integration,e2e}," in *",$1,"*) return 0 ;; esac; return 1; }',
    // cleanup が呼ぶ片付け (枠のスタックと Next は動かしていないので何もしない)
    "stop_server() { :; }",
    "stop_supabase() { :; }",
    'LOCK_OWNER_GRACE_SEC=60; GUARD_POLL_SEC=1; SLOT_POLL_SEC=1; SLOT_WAIT_SECONDS="${HARNESS_SLOT_WAIT_SECONDS:-0}"; LEGACY_LOCK=""',
    `GUARD_DROP_TRIES=${constant("GUARD_DROP_TRIES")}; EXIT_SIGINT=${constant("EXIT_SIGINT")}; EXIT_SIGTERM=${constant("EXIT_SIGTERM")}; EXIT_SIGHUP=${constant("EXIT_SIGHUP")}`,
    'HEAD_SHA=test; ART="$HARNESS_TMP"; WT="$HARNESS_TMP"; APP_HOST_URL="http://localhost"; ENV_SLOT=""',
    'SLOT=""; SLOT_LOCK=""; SLOT_RECLAIMED=0; LOCK_RECLAIMED=0; GUARD_HELD=""; STALE_GUARDS_WARNED=""',
    'OWN_STACK_SLOT=""; OWN_STACK_CONTAINERS=""; OWN_STACK_VOLUMES=""; OWN_STACK_NOTE=""',
    'SIGNAL_DEFER_DEPTH=0; PENDING_SIGNAL_EXIT=""; OWNER_PID=""; OWNER_LSTART=""; MY_LSTART=""; GUARD_TOKEN=""',
    `. "${path.join(ROOT, SLOT_LIB)}"`,
    ...LOCK_FUNCTIONS.map(extract),
    // 見張りのファイルを作った直後 (GUARD_HELD に入れる前) で待てるようにする
    extract("create_guard_file").replace(/^create_guard_file\(\)/, "orig_create_guard_file()"),
    'create_guard_file() { orig_create_guard_file "$@"; local rc=$?; if [ "$rc" -eq 0 ] && [ -n "${HOOK_GUARD_CREATED_DELAY:-}" ]; then echo "GUARD_CREATED"; sleep "$HOOK_GUARD_CREATED_DELAY"; fi; return "$rc"; }',
    "init_owner_identity",
  ];
  const writeHarness = (name: string, body: string[]) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, [...prelude, ...body, ""].join("\n"));
    return file;
  };
  // 枠を取り (回収したときの片付けは acquire_slot の中)、残ったスタックを確かめてから、ロックを外す (local-ci.sh の本体と同じ順)
  const harness = writeHarness("harness.sh", [
    'acquire_slot; rc=$?; if [ "$rc" -ne 0 ]; then echo "ACQUIRE_FAILED rc=$rc note=$SLOT_BUSY_NOTE"; exit 0; fi',
    'echo "SLOT=$SLOT RECLAIMED=$SLOT_RECLAIMED APP_PORT=$APP_PORT"',
    'if check_slot_stack integration; then echo "STACK_OK"; else echo "STACK_RED"; fi',
    'release_lock "$SLOT_LOCK"',
  ]);
  // HOOK_LOCK のロックを 1 回だけ取りに行き、取れたら HARNESS_STOP ができるまで持ったままにする (外さない)
  const tryHarness = writeHarness("try.sh", [
    'if try_lock "$HOOK_LOCK"; then echo "GOT reclaimed=$LOCK_RECLAIMED pid=$$"; else echo "MISSED pid=$$"; exit 0; fi',
    'while [ ! -e "$HARNESS_STOP" ]; do sleep 0.1; done',
  ]);
  // HOOK_LOCK のロックを作ってから外す
  const releaseHarness = writeHarness("release.sh", [
    'make_lock "$HOOK_LOCK" || { echo "MAKE_FAILED"; exit 1; }',
    'echo "READY pid=$$"',
    'release_lock "$HOOK_LOCK"',
    'echo "RELEASED"',
  ]);
  // local-ci.sh の本体と同じく cleanup とシグナルの trap を入れてから、HARNESS_MODE の操作をして HARNESS_STOP ができるまで待つ。
  //   acquire: 枠を取りに行く (持ち主の死んだロックがあれば回収に入る)
  //   hold:    HOOK_LOCK のロックを作って SLOT_LOCK に入れる (終わるときに cleanup が外す)
  //   release: HOOK_LOCK のロックを作り、cleanup の外で外す (外側のロックに気づいたときの acquire_slot と同じ)
  const signalHarness = writeHarness("signal.sh", [
    'WT=""; KEEP=0; GL_DIR=""; WORK_PARENT="$HARNESS_TMP/no-work"; SRC_ROOT="$HARNESS_TMP"; CLEANED=0; ART_LOCK=""',
    "install_signal_traps",
    'case "$HARNESS_MODE" in',
    '  acquire) if acquire_slot; then echo "ACQUIRED pid=$$"; else echo "ACQUIRE_FAILED pid=$$"; fi ;;',
    '  hold) make_lock "$HOOK_LOCK" || exit 1; SLOT_LOCK="$HOOK_LOCK"; echo "READY pid=$$" ;;',
    '  release) make_lock "$HOOK_LOCK" || exit 1; echo "READY pid=$$"; release_lock "$HOOK_LOCK"; echo "RELEASED" ;;',
    "esac",
    'while [ ! -e "$HARNESS_STOP" ]; do sleep 0.1; done',
  ]);

  const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, HARNESS_TMP: tmp });

  let caseNo = 0;
  const newLockDir = () => {
    caseNo += 1;
    const dir = path.join(tmp, `locks-${caseNo}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const backdate = (p: string, ageSec: number) => {
    if (ageSec > 0) {
      const t = new Date(Date.now() - ageSec * 1000);
      fs.utimesSync(p, t, t);
    }
  };
  /** ロックのディレクトリを、持ち主の内容と、作られてからの秒数を決めて置く */
  const placeLock = (dir: string, owner: string, ageSec = 0) => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "owner"), owner);
    backdate(dir, ageSec);
  };
  /** 回収の見張り (持ち主の印を書いたファイル) を、持ち主の内容と、作られてからの秒数を決めて置く */
  const placeGuard = (file: string, owner: string, ageSec = 0) => {
    fs.writeFileSync(file, owner, { flag: "wx" });
    backdate(file, ageSec);
  };
  /** 枠の候補・前もって置くロックの持ち主・残っているコンテナ / ボリュームを決めて、ハーネスを 1 回動かす */
  const runCase = (opts: {
    slot: string;
    owner?: string;
    guard?: { owner: string; ageSec: number };
    containers?: string;
    volumes?: string;
    tz?: string;
    env?: Record<string, string>;
  }) => {
    const lockDir = newLockDir();
    const slotLock = path.join(lockDir, `slot-${opts.slot}`);
    if (opts.owner !== undefined) placeLock(slotLock, opts.owner);
    if (opts.guard !== undefined) placeGuard(`${slotLock}.reclaim`, opts.guard.owner, opts.guard.ageSec);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      LOCK_DIR: lockDir,
      SLOT_CANDIDATES: opts.slot,
      FAKE_CONTAINERS: opts.containers ?? "",
      FAKE_VOLUMES: opts.volumes ?? "",
      ...opts.env,
    };
    if (opts.tz !== undefined) env.TZ = opts.tz;
    const r = spawnSync("bash", [harness], { cwd: tmp, env, encoding: "utf8" });
    return { status: r.status, out: r.stdout, err: r.stderr, slotLock };
  };

  /** 起動したハーネスの標準出力が条件を満たすまで待つ */
  type Proc = { child: ReturnType<typeof spawn>; out: () => string; exited: Promise<number | null> };
  // group: 自分のプロセスグループで起動する (signalGroup で、Ctrl-C と同じくハーネスと子プロセスの sleep などの全部にシグナルを送れる)
  const start = (file: string, env: NodeJS.ProcessEnv, group = false): Proc => {
    const child = spawn("bash", [file], { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"], detached: group });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr?.on("data", () => undefined);
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, out: () => out, exited };
  };
  const POLL_MS = 50;
  const WAIT_LIMIT_MS = 15_000;
  const waitFor = async (cond: () => boolean, what: string) => {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`待ちの時間切れ: ${what}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const signalGroup = (p: Proc, sig: NodeJS.Signals) => process.kill(-(p.child.pid as number), sig);
  /** 後始末: まだ動いていれば、プロセスグループごと止める */
  const killGroup = async (p: Proc) => {
    if (p.child.exitCode === null && p.child.signalCode === null) {
      try {
        signalGroup(p, "SIGKILL");
      } catch {
        // すでに終わっている
      }
    }
    await p.exited;
  };
  const ownerPidOf = (dir: string) => /^pid=(\d+)$/m.exec(fs.readFileSync(path.join(dir, "owner"), "utf8"))?.[1];

  // 持ち主の死んだロック: pid 1 は生きているが、開始時刻が違う (= pid が使い回された別のプロセス) ので持ち主ではない
  const DEAD_OWNER = "pid=1\nlstart=Thu Jan  1 00:00:00 1970\n";
  // 生きている持ち主: このテストのプロセス。local-ci.sh の write_owner と同じく LC_ALL=C・TZ=UTC で開始時刻を書く。
  // このプロセスの開始時刻は変わらないので、ps は最初の 1 回だけ起動して使い回す (#1496)
  let liveOwnerText: string | undefined;
  const liveOwner = () => {
    if (liveOwnerText === undefined) {
      const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" },
      }).trim();
      expect(lstart, "このプロセスの開始時刻を ps で読めない").not.toBe("");
      liveOwnerText = `pid=${process.pid}\nlstart=${lstart}\n`;
    }
    return liveOwnerText;
  };
  // 見張りが空くのを待っているあいだに、まだ外していないことを確かめるまでの時間
  const RELEASE_BLOCKED_MS = 1_500;
  // 持ち主の死んだ見張りとみなす古さ (LOCK_OWNER_GRACE_SEC=60 より古い)
  const STALE_GUARD_AGE_SEC = 120;

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
    // 外したあとは、ロックも回収の見張りも残らない
    expect(fs.existsSync(r.slotLock)).toBe(false);
    expect(fs.existsSync(`${r.slotLock}.reclaim`)).toBe(false);
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

  /** 候補の枠 (空白区切り) と、使用中のポート・回す段・持ち主の決まったロックを決めて、ハーネスを回す */
  const runSlots = (opts: { candidates: string; busy?: number[]; stages?: string; owners?: Record<string, string>; env?: Record<string, string> }) => {
    const lockDir = newLockDir();
    for (const [slot, owner] of Object.entries(opts.owners ?? {})) placeLock(path.join(lockDir, `slot-${slot}`), owner);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      LOCK_DIR: lockDir,
      SLOT_CANDIDATES: opts.candidates,
      FAKE_BUSY_PORTS: (opts.busy ?? []).join(" "),
      ...(opts.stages === undefined ? {} : { HARNESS_STAGES: opts.stages }),
      ...opts.env,
    };
    // 待ってしまう誤り (待ちの上限を長くしたとき) でテストが止まらないよう、上限で打ち切る (打ち切ると status が null になり赤)
    const r = spawnSync("bash", [harness], { cwd: tmp, env, encoding: "utf8", timeout: RACE_TIMEOUT_MS });
    return { status: r.status, out: r.stdout, err: r.stderr, lockDir };
  };
  // 待ちの上限を長くしたとき (待たずに返ることを確かめる。これだけ待つと vitest の 1 件の時間切れより長い)
  const LONG_SLOT_WAIT_SEC = 600;
  const portOf = (slot: string, name: string) => Number(slotValues(slot).get(name));
  const locksLeft = (lockDir: string) => fs.readdirSync(lockDir).filter((name) => name.startsWith("slot-"));

  it("取れた枠のポートを local-ci.sh 以外が使っていれば、その枠を外して次の候補の枠を使う (赤で止めない)", () => {
    const busy = portOf("3", "SLOT_ENFORCED_APP_PORT");
    const r = runSlots({ candidates: "3 1", busy: [busy] });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain(`SLOT=1 RECLAIMED=0 APP_PORT=${portOf("1", "SLOT_APP_PORT")}`);
    expect(r.err).toContain(`枠 3 のポート (${busy}) を local-ci.sh 以外が使っている`);
    expect(r.out).not.toContain("RECORD");
    // 外した枠 3 のロックも、使い終わった枠 1 のロックも残らない
    expect(locksLeft(r.lockDir)).toEqual([]);
  });

  it("どの候補の枠もポートを local-ci.sh 以外に使われていれば、待たずに 2 で返し、使用中のポートを知らせる (ロックは残さない)", () => {
    const b3 = portOf("3", "SLOT_APP_PORT");
    const b1 = portOf("1", "SLOT_API_PORT");
    // 待ちの上限を長くしても待たない (ほかの local-ci.sh が持っている枠が無いので、待っても空く見込みが無い)
    const started = Date.now();
    const r = runSlots({ candidates: "3 1", busy: [b3, b1], env: { HARNESS_SLOT_WAIT_SECONDS: String(LONG_SLOT_WAIT_SEC) } });
    expect(r.status, r.err).toBe(0);
    expect(Date.now() - started, "待たずに返る").toBeLessThan(LONG_SLOT_WAIT_SEC * 1000);
    expect(r.out).toContain(`ACQUIRE_FAILED rc=2 note=枠 3:${b3} / 枠 1:${b1}`);
    expect(locksLeft(r.lockDir)).toEqual([]);
  });

  it("ポートを使われている枠のほかに、生きている local-ci.sh が持つ枠があれば、空くのを待つ (時間切れは 1。使用中のポートも知らせる)", () => {
    const b3 = portOf("3", "SLOT_NOTICE_APP_PORT");
    const r = runSlots({ candidates: "1 3", busy: [b3], owners: { "1": liveOwner() } });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain(`ACQUIRE_FAILED rc=1 note=枠 3:${b3}`);
    // 生きている持ち主のロックはそのまま。外した枠 3 のロックは残らない
    expect(locksLeft(r.lockDir)).toEqual(["slot-1"]);
  });

  it("e2e を回さないときは、e2e だけが使うポート (2 つ目・3 つ目のサーバー) が使用中でも、その枠を使う", () => {
    const enforced = portOf("3", "SLOT_ENFORCED_APP_PORT");
    const notice = portOf("3", "SLOT_NOTICE_APP_PORT");
    const integ = runSlots({ candidates: "3", busy: [enforced, notice], stages: "integration" });
    expect(integ.out, integ.err).toContain("SLOT=3 RECLAIMED=0");
    const e2e = runSlots({ candidates: "3", busy: [notice], stages: "e2e" });
    expect(e2e.out, e2e.err).toContain(`ACQUIRE_FAILED rc=2 note=枠 3:${notice}`);
  });

  it("持ち主の死んだロックを回収したときは、残ったスタックを片付けてからポートを確かめる (残ったスタックのポートで枠を外さない)", () => {
    const lockDir = newLockDir();
    placeLock(path.join(lockDir, "slot-1"), DEAD_OWNER);
    const leftover = path.join(tmp, `leftover-${caseNo}`);
    fs.writeFileSync(leftover, "");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      LOCK_DIR: lockDir,
      SLOT_CANDIDATES: "1",
      FAKE_CONTAINERS: "c0ffee",
      FAKE_BUSY_UNTIL_CLEARED: leftover,
      FAKE_BUSY_PORTS_BEFORE_CLEAR: String(portOf("1", "SLOT_API_PORT")),
    };
    const r = spawnSync("bash", [harness], { cwd: tmp, env, encoding: "utf8" });
    expect(r.stdout, r.stderr).toContain("RUN_IN bash scripts/supabase-local.sh stop-leftover");
    expect(r.stdout, r.stderr).toContain("SLOT=1 RECLAIMED=1");
    expect(r.stdout).not.toContain("ACQUIRE_FAILED");
  });

  it("ポートの確かめ (PORT_PROBE_JS) は、待ち受けているポートだけを使用中として出し、1 つも無ければ終了コード 1", async () => {
    const lines = scriptLines;
    const start = lines.findIndex((line) => line === "PORT_PROBE_JS='");
    const end = lines.findIndex((line, i) => i > start && line === "'");
    expect(start, "PORT_PROBE_JS が無い").toBeGreaterThanOrEqual(0);
    const code = lines.slice(start + 1, end).join("\n");
    // 空いているポートを OS に選ばせて待ち受け、もう 1 つは選ばせてすぐ閉じる (閉じたポートは空いている)
    const listen = () =>
      new Promise<net.Server>((resolve) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => resolve(srv));
      });
    const held = await listen();
    const freed = await listen();
    const heldPort = (held.address() as net.AddressInfo).port;
    const freePort = (freed.address() as net.AddressInfo).port;
    await new Promise((r) => freed.close(r));
    const probe = (ports: number[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn("node", ["-e", code, ...ports.map(String)], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString("utf8");
        });
        child.on("exit", (exitCode) => resolve({ code: exitCode, out }));
      });
    try {
      expect(await probe([freePort, heldPort])).toEqual({ code: 0, out: String(heldPort) });
      expect(await probe([freePort])).toEqual({ code: 1, out: "" });
    } finally {
      await new Promise((r) => held.close(r));
    }
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

  it("ps が動かない (fork の失敗など) ときは、持ち主が生きている限り回収しない", () => {
    const r = runCase({ slot: "1", owner: liveOwner(), containers: "c0ffee", env: { HOOK_PS_FAIL: "1" } });
    expect(r.out, r.err).toContain("ACQUIRE_FAILED");
    expect(r.out).not.toContain("RUN_IN");
    expect(ownerPidOf(r.slotLock)).toBe(String(process.pid));
  });

  it("持ち主が開始時刻を書けなかったロックは、その pid のプロセスが生きている限り回収しない", () => {
    const r = runCase({ slot: "1", owner: `pid=${process.pid}\nlstart=\n`, containers: "c0ffee" });
    expect(r.out, r.err).toContain("ACQUIRE_FAILED");
    expect(r.out).not.toContain("RUN_IN");
  });

  it(
    "同時に 2 本が同じ死んだロックを回収しに来ても、取れるのは 1 本だけ (遅れて回収に来た方が、先に回収して作り直したロックを消さない)",
    async () => {
      const lock = path.join(newLockDir(), "slot-1");
      placeLock(lock, DEAD_OWNER);
      const stop = path.join(tmp, `stop-${caseNo}`);
      // B: 持ち主の確かめが遅く (ps の前に待つ)、回収の表示のあとでも待つ。A: 死んだロックを消してから作り直すまでに待つ。
      // 見張りを外してから作り直す作りだと、A が作り直すまでのあいだに B が見張りを取り、ロックが無いのを見て、
      // A の作り直したロックを消して自分も取る (2 本が同じ枠を持つ)
      const b = start(tryHarness, { ...baseEnv(), HOOK_LOCK: lock, HARNESS_STOP: stop, HOOK_PS_DELAY: "0.3", HOOK_SAY_DELAY: "1.5" });
      await sleepMs(100);
      const a = start(tryHarness, { ...baseEnv(), HOOK_LOCK: lock, HARNESS_STOP: stop, HOOK_REMKDIR_DELAY: "0.5" });
      try {
        await waitFor(() => /^(GOT|MISSED)/m.test(a.out()) && /^(GOT|MISSED)/m.test(b.out()), "2 本の結果");
        const winners = [a, b].filter((p) => /^GOT /m.test(p.out()));
        expect(winners.map((p) => p.out()), `A: ${a.out()} / B: ${b.out()}`).toHaveLength(1);
        // 取れた 1 本が、いまのロックの持ち主 (死んだ持ち主のロックは残っていない)
        const winnerPid = /pid=(\d+)/.exec(winners[0].out())?.[1];
        expect(ownerPidOf(lock)).toBe(winnerPid);
      } finally {
        fs.writeFileSync(stop, "");
        await Promise.all([a.exited, b.exited]);
      }
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "同時に何本が同じ死んだロックを取りに来ても、取れるのは 1 本だけ",
    async () => {
      const ACQUIRERS = 6;
      const lock = path.join(newLockDir(), "slot-1");
      placeLock(lock, DEAD_OWNER);
      const stop = path.join(tmp, `stop-${caseNo}`);
      const procs = Array.from({ length: ACQUIRERS }, () => start(tryHarness, { ...baseEnv(), HOOK_LOCK: lock, HARNESS_STOP: stop }));
      try {
        await waitFor(() => procs.every((p) => /^(GOT|MISSED)/m.test(p.out())), "全部の結果");
        const winners = procs.filter((p) => /^GOT /m.test(p.out()));
        expect(winners, procs.map((p) => p.out()).join(" / ")).toHaveLength(1);
        expect(ownerPidOf(lock)).toBe(/pid=(\d+)/.exec(winners[0].out())?.[1]);
      } finally {
        fs.writeFileSync(stop, "");
        await Promise.all(procs.map((p) => p.exited));
      }
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "ロックを外すのは見張りを取ってから (回収している実行が見張りを持っているあいだは外さずに待つ)",
    async () => {
      const lock = path.join(newLockDir(), "slot-1");
      const guard = `${lock}.reclaim`;
      // 生きている別の実行 (このテストのプロセス) が回収の見張りを持っている
      placeGuard(guard, liveOwner());
      const p = start(releaseHarness, { ...baseEnv(), HOOK_LOCK: lock });
      try {
        await waitFor(() => p.out().includes("READY"), "ロックを作る");
        await sleepMs(RELEASE_BLOCKED_MS);
        expect(p.out()).not.toContain("RELEASED");
        expect(fs.existsSync(lock)).toBe(true);
        // 見張りが外れたら、見張りを取って外す
        fs.rmSync(guard, { recursive: true, force: true });
        await waitFor(() => p.out().includes("RELEASED"), "ロックを外す");
        expect(fs.existsSync(lock)).toBe(false);
        expect(fs.existsSync(guard)).toBe(false);
      } finally {
        p.child.kill();
        await p.exited;
      }
    },
    RACE_TIMEOUT_MS,
  );

  it("終わるとき (Ctrl-C などを含む) は、ほかの片付けより先に見張りを外し、枠のロックはスタックを止めてから外す", () => {
    const body = extract("cleanup").split("\n").map((line) => line.trim());
    const at = (cmd: string) => body.findIndex((line) => line === cmd);
    expect(at("drop_guard"), "cleanup に drop_guard が無い").toBeGreaterThan(0);
    expect(at("drop_guard")).toBeLessThan(at("stop_server"));
    expect(at("stop_supabase")).toBeLessThan(at('release_lock "$SLOT_LOCK"'));
    expect(at('release_lock "$SLOT_LOCK"')).toBeLessThan(at('release_lock "$ART_LOCK"'));
  });

  it("持ち主の死んだ見張りが残っていても、自分のロックは外せる (見張りは消さない)", () => {
    const lock = path.join(newLockDir(), "slot-1");
    const guard = `${lock}.reclaim`;
    placeGuard(guard, DEAD_OWNER, STALE_GUARD_AGE_SEC);
    const r = spawnSync("bash", [releaseHarness], { cwd: tmp, env: { ...baseEnv(), HOOK_LOCK: lock }, encoding: "utf8" });
    expect(r.stdout, r.stderr).toContain("RELEASED");
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(guard)).toBe(true);
  });

  it("持ち主の死んだ見張りが残っていれば、死んだロックを回収せず (見張りも消さず) に知らせる", () => {
    const r = runCase({ slot: "1", owner: DEAD_OWNER, guard: { owner: DEAD_OWNER, ageSec: STALE_GUARD_AGE_SEC }, containers: "c0ffee" });
    expect(r.out, r.err).toContain("ACQUIRE_FAILED");
    expect(r.out).not.toContain("RUN_IN");
    expect(r.err).toMatch(/回収の見張り .*slot-1\.reclaim が、持ち主の死んだまま残っています/);
    expect(fs.existsSync(`${r.slotLock}.reclaim`)).toBe(true);
    expect(ownerPidOf(r.slotLock)).toBe("1");
  });

  it("作られて間もない見張りは、持ち主が死んで見えても残った跡とみなさない (取り直された直後の見張りと取り違えない)", () => {
    const r = runCase({ slot: "1", owner: DEAD_OWNER, guard: { owner: DEAD_OWNER, ageSec: 0 } });
    expect(r.out, r.err).toContain("ACQUIRE_FAILED");
    expect(r.err).not.toContain("回収の見張り");
    expect(fs.existsSync(`${r.slotLock}.reclaim`)).toBe(true);
  });

  // 見張りが残ると、その枠の持ち主の死んだロックを誰も回収できなくなる (待ちの時間切れまで待つ)。
  // シグナルは Ctrl-C と同じくプロセスグループに送る (ハーネスの子プロセスの sleep なども止まる)
  const SIGNALS: Array<[NodeJS.Signals, string]> = [
    ["SIGINT", "EXIT_SIGINT"],
    ["SIGTERM", "EXIT_SIGTERM"],
    ["SIGHUP", "EXIT_SIGHUP"],
  ];
  // acquire: 持ち主の死んだ枠のロックを回収しに行き、見張りを作った直後に届く (枠を取る後回しの区間の中)
  // release: 自分のロックを外しに行き、見張りを作った直後に届く (後回しの区間は見張りを作るところだけ)
  const GUARD_CREATED_CASES: Array<[string, NodeJS.Signals, string]> = [
    ...SIGNALS.map(([sig, exitName]): [string, NodeJS.Signals, string] => ["acquire", sig, exitName]),
    ["release", "SIGTERM", "EXIT_SIGTERM"],
  ];
  it.each(GUARD_CREATED_CASES)(
    "(%s) 見張りのファイルを作った直後 (GUARD_HELD に入れる前) に %s が届いても、見張りを残さずに終わり、ロックは次の実行が回収できる",
    async (mode, sig, exitName) => {
      const lockDir = newLockDir();
      const slotLock = path.join(lockDir, "slot-1");
      if (mode === "acquire") placeLock(slotLock, DEAD_OWNER);
      const stop = path.join(tmp, `stop-${caseNo}`);
      const p = start(
        signalHarness,
        {
          ...baseEnv(),
          HARNESS_MODE: mode,
          LOCK_DIR: lockDir,
          SLOT_CANDIDATES: "1",
          HOOK_LOCK: slotLock,
          HARNESS_STOP: stop,
          HOOK_GUARD_CREATED_DELAY: String(HOOK_PAUSE_SEC),
        },
        true,
      );
      try {
        await waitFor(() => p.out().includes("GUARD_CREATED"), "見張りを作る");
        signalGroup(p, sig);
        expect(await p.exited, p.out()).toBe(Number(constant(exitName)));
        expect(p.out()).not.toMatch(/ACQUIRED|RELEASED/);
        expect(fs.existsSync(`${slotLock}.reclaim`)).toBe(false);
        // 終わる途中なので回収はしていない (acquire: 死んだ持ち主のまま。release: 外す前に終わったので、終わったハーネスが持ち主)
        if (mode === "acquire") expect(ownerPidOf(slotLock)).toBe("1");
        const nextStop = path.join(tmp, `stop-next-${caseNo}`);
        fs.writeFileSync(nextStop, "");
        const next = spawnSync("bash", [tryHarness], { cwd: tmp, env: { ...baseEnv(), HOOK_LOCK: slotLock, HARNESS_STOP: nextStop }, encoding: "utf8" });
        expect(next.stdout, next.stderr).toMatch(/^GOT reclaimed=1 /m);
      } finally {
        fs.writeFileSync(stop, "");
        await killGroup(p);
      }
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "枠のロックを作った直後 (SLOT_LOCK に入れる前) に Ctrl-C が届いても、終わるときにそのロックを外す",
    async () => {
      const lockDir = newLockDir();
      const slotLock = path.join(lockDir, "slot-1");
      const stop = path.join(tmp, `stop-${caseNo}`);
      const p = start(
        signalHarness,
        { ...baseEnv(), HARNESS_MODE: "acquire", LOCK_DIR: lockDir, SLOT_CANDIDATES: "1", HOOK_LOCK: slotLock, HARNESS_STOP: stop, HOOK_LOCK_MADE_DELAY: String(HOOK_PAUSE_SEC) },
        true,
      );
      try {
        await waitFor(() => p.out().includes("LOCK_MADE"), "枠のロックを作る");
        signalGroup(p, "SIGINT");
        expect(await p.exited, p.out()).toBe(Number(constant("EXIT_SIGINT")));
        expect(fs.existsSync(slotLock)).toBe(false);
        expect(fs.existsSync(`${slotLock}.reclaim`)).toBe(false);
      } finally {
        fs.writeFileSync(stop, "");
        await killGroup(p);
      }
    },
    RACE_TIMEOUT_MS,
  );

  it("try_lock の呼び出しは、取ったロックを変数に入れ終えるまでを後回しの区間 (defer_signals / resume_signals) で囲む", () => {
    // 枠のロック (acquire_slot) は上のテストで動かして確かめる。結果の置き場のロックは本体にあって動かせないので、並びで確かめる
    const code = scriptLines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    const calls = code.map((line, i) => [line, i] as const).filter(([line]) => /\btry_lock "/.test(line));
    expect(calls.length, "try_lock の呼び出しが無い").toBeGreaterThan(0);
    for (const [line, i] of calls) {
      expect(code[i - 1], line).toBe("defer_signals");
      const resume = code.findIndex((l, j) => j > i && l === "resume_signals");
      expect(resume, line).toBeGreaterThan(i);
      // 区間の中で、取ったロックを変数に入れる
      expect(code.slice(i, resume).some((l) => /\b(SLOT_LOCK|ART_LOCK)="/.test(l)), line).toBe(true);
    }
  });

  // 見張りを持ってロックを外している最中 (rm の前で待つ) に Ctrl-C が届く。
  //   hold:    1 回目の Ctrl-C で終わる途中 (cleanup が SLOT_LOCK を外している最中) に、もう一度 Ctrl-C が届く。
  //            bash 3.2 は EXIT の trap の最中に INT の trap を動かさない (cleanup を最後まで終えてロックも外す)。
  //            bash 4 以降で INT の trap が動けば、exit_on_signal が見張りを外して終わる (ロックは持ち主の死んだロックとして残る)
  //   release: cleanup の外で外している最中に届く (exit_on_signal が見張りを外してから終わる)
  const MID_RELEASE_CASES: Array<[string, number]> = [
    ["hold", 2],
    ["release", 1],
  ];
  it.each(MID_RELEASE_CASES)(
    "見張りを持ってロックを外している最中に Ctrl-C が届いても、見張りを残さず、枠は次の実行が取れる (%s)",
    async (mode, interrupts) => {
      const lock = path.join(newLockDir(), "slot-1");
      const stop = path.join(tmp, `stop-${caseNo}`);
      const p = start(signalHarness, { ...baseEnv(), HARNESS_MODE: mode, HOOK_LOCK: lock, HARNESS_STOP: stop, HOOK_RM_LOCK_DELAY: String(HOOK_PAUSE_SEC) }, true);
      try {
        await waitFor(() => p.out().includes("READY"), "ロックを作る");
        if (interrupts === 2) signalGroup(p, "SIGINT");
        await waitFor(() => p.out().includes("RM_LOCK"), "見張りを持ってロックを外し始める");
        signalGroup(p, "SIGINT");
        expect(await p.exited, p.out()).toBe(Number(constant("EXIT_SIGINT")));
        expect(fs.existsSync(`${lock}.reclaim`)).toBe(false);
        // ロックは外れているか、持ち主の死んだロックとして残っている。どちらでも次の実行が取れる
        const nextStop = path.join(tmp, `stop-next-${caseNo}`);
        fs.writeFileSync(nextStop, "");
        const next = spawnSync("bash", [tryHarness], { cwd: tmp, env: { ...baseEnv(), HOOK_LOCK: lock, HARNESS_STOP: nextStop }, encoding: "utf8" });
        expect(next.stdout, next.stderr).toMatch(/^GOT reclaimed=[01] /m);
      } finally {
        fs.writeFileSync(stop, "");
        await killGroup(p);
      }
    },
    RACE_TIMEOUT_MS,
  );

  it("見張りを消す rm が Ctrl-C で消す前に止められても、やり直して見張りを残さない", () => {
    const lock = path.join(newLockDir(), "slot-1");
    const r = spawnSync("bash", [releaseHarness], { cwd: tmp, env: { ...baseEnv(), HOOK_LOCK: lock, HOOK_RM_GUARD: "killed-once" }, encoding: "utf8" });
    expect(r.stdout, r.stderr).toContain("RM_GUARD_KILLED");
    expect(r.stdout).toContain("RELEASED");
    expect(fs.existsSync(`${lock}.reclaim`)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it(
    "見張りを消した直後にシグナルで終わっても、そのあいだに別の実行が取った見張りは消さない (2 本が同時に回収に入らない)",
    async () => {
      const lock = path.join(newLockDir(), "slot-1");
      const guard = `${lock}.reclaim`;
      const stop = path.join(tmp, `stop-${caseNo}`);
      const p = start(signalHarness, { ...baseEnv(), HARNESS_MODE: "release", HOOK_LOCK: lock, HARNESS_STOP: stop, HOOK_RM_GUARD: "pause" }, true);
      try {
        await waitFor(() => p.out().includes("GUARD_REMOVED"), "見張りを消す");
        // 別の実行 (このテストのプロセス) が、空いた見張りを取る
        const other = liveOwner();
        placeGuard(guard, other);
        signalGroup(p, "SIGTERM");
        expect(await p.exited, p.out()).toBe(Number(constant("EXIT_SIGTERM")));
        expect(fs.readFileSync(guard, "utf8")).toBe(other);
        expect(fs.existsSync(lock)).toBe(false);
      } finally {
        fs.writeFileSync(stop, "");
        await killGroup(p);
        fs.rmSync(guard, { force: true });
      }
    },
    RACE_TIMEOUT_MS,
  );
});

describe("scripts/local-ci.sh: ローカル Supabase を止めたあとの残り (prune の衝突。#1616)", () => {
  const scriptLines = fs.readFileSync(path.join(ROOT, LOCAL_CI), "utf8").split("\n");
  const extract = (name: string): string => {
    const start = scriptLines.findIndex((line) => line.startsWith(`${name}() {`));
    if (start < 0) throw new Error(`${LOCAL_CI} に関数 ${name} が無い`);
    if (/\}\s*$/.test(scriptLines[start])) return scriptLines[start];
    const end = scriptLines.findIndex((line, i) => i > start && line === "}");
    if (end < 0) throw new Error(`${LOCAL_CI} の関数 ${name} の終わりが無い`);
    return scriptLines.slice(start, end + 1).join("\n");
  };
  const constant = (name: string): string => {
    const m = new RegExp(`^readonly ${name}=([0-9]+)\\b`).exec(scriptLines.find((line) => line.startsWith(`readonly ${name}=`)) ?? "");
    if (!m) throw new Error(`${LOCAL_CI} に定数 ${name} が無い`);
    return m[1];
  };
  const EXIT_RED = Number(constant("EXIT_RED"));
  // CLI の stop が別の枠の prune と重なったときに出す文言 (2026-10-15 に d256 で実測)
  const PRUNE_CONFLICT = "failed to prune containers: Error response from daemon: a prune operation is already running";
  const projectOf = (slot: string) => slotValues(slot).get("SLOT_PROJECT_ID") ?? "";

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-teardown-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // docker の代わり: FAKE_STATE の行 (「c <コンテナ ID> <project_id>」「v <ボリューム名> <project_id>」) を、
  // ラベル (label=com.supabase.cli.project=<project_id>) で絞って返す。ラベルで絞らない一覧は全部を返す
  // (絞り忘れると、ほかの枠のものまで「この枠のもの」に見える)。rm / volume rm は呼ばれた引数を FAKE_CALLS に書いてから行を消す
  const fakeDocker = [
    "fake_remove() { local kind=\"$1\" x; shift; for x; do awk -v k=\"$kind\" -v x=\"$x\" '!($1 == k && $2 == x)' \"$FAKE_STATE\" >\"$FAKE_STATE.tmp\" && mv \"$FAKE_STATE.tmp\" \"$FAKE_STATE\"; done; }",
    "fake_list() { awk -v k=\"$1\" -v p=\"$2\" -v all=\"$3\" '$1 == k && (all == 1 || $3 == p) { print $2 }' \"$FAKE_STATE\"; }",
    "docker() {",
    '  local a p="" all=1 n=0',
    '  for a; do case "$a" in label=com.supabase.cli.project=*) p="${a#label=com.supabase.cli.project=}"; all=0 ;; esac; done',
    '  case "$1" in',
    '    ps) [ ! -e "$FAKE_LS_FAIL" ] || return 1; fake_list c "$p" "$all" ;;',
    '    volume)',
    '      case "$2" in',
    '        ls) [ ! -e "$FAKE_LS_FAIL" ] || return 1; fake_list v "$p" "$all" ;;',
    '        rm) shift 2; [ "$1" != -f ] || shift; echo "VOLUME_RM $*" >>"$FAKE_CALLS"; fake_remove v "$@" ;;',
    '        *) echo "DOCKER_OTHER volume $2" >>"$FAKE_CALLS"; return 1 ;;',
    "      esac ;;",
    '    rm)',
    '      shift; [ "$1" != -f ] || shift; echo "DOCKER_RM $*" >>"$FAKE_CALLS"',
    '      [ ! -f "$FAKE_STATE.rmn" ] || n="$(cat "$FAKE_STATE.rmn")"',
    '      if [ "$n" -lt "${FAKE_RM_FAILS:-0}" ]; then echo "$((n + 1))" >"$FAKE_STATE.rmn"; return 1; fi',
    '      fake_remove c "$@" ;;',
    '    *) echo "DOCKER_OTHER $1" >>"$FAKE_CALLS"; return 1 ;;',
    "  esac",
    "}",
  ].join("\n");
  // run_in の代わり (supabase-local.sh stop の結果を FAKE_STOP で決める)
  //   ok:            CLI の stop が自分の project_id のものを全部消した
  //   prune:         やり直しても prune の衝突で失敗した (止まっただけのコンテナとボリュームが残る)
  //   prune-foreign: 同じく失敗し、そのあいだに控えていないコンテナがこの枠の project_id で作られた (他人のもの)
  //   prune-lsfail:  同じく失敗し、そのあと docker の一覧が取れなくなった
  const fakeRunIn = [
    "run_in() {",
    '  echo "RUN_IN ${*:3}" >>"$FAKE_CALLS"',
    '  case "${FAKE_STOP:-ok}" in',
    "    ok) awk -v p=\"$SLOT_PROJECT_ID\" '$3 != p' \"$FAKE_STATE\" >\"$FAKE_STATE.tmp\" && mv \"$FAKE_STATE.tmp\" \"$FAKE_STATE\"; return 0 ;;",
    `    prune) echo "${PRUNE_CONFLICT}" >>"$2"; return 1 ;;`,
    '    prune-foreign) echo "c foreign0001 $SLOT_PROJECT_ID" >>"$FAKE_STATE"; return 1 ;;',
    '    prune-lsfail) : >"$FAKE_LS_FAIL"; return 1 ;;',
    "  esac",
    "}",
  ].join("\n");
  const harness = path.join(tmp, "teardown.sh");
  fs.writeFileSync(
    harness,
    [
      "set -u -o pipefail",
      'say() { echo "SAY $*" >&2; }',
      fakeDocker,
      fakeRunIn,
      `EXIT_RED=${EXIT_RED}; EXIT_SLOT_TIMEOUT=${constant("EXIT_SLOT_TIMEOUT")}; LOG_TAIL_LINES=${constant("LOG_TAIL_LINES")}`,
      'CI_LANG="C.UTF-8"; ALL_STAGES="integration,e2e"; ONLY="integration,e2e"; MERGE=0; MERGE_STATE="-"; HEAD_SHA=test; NODE_VERSION=22',
      'FINISHED=0; SLOT_TIMED_OUT=0; DIRTY_TRACKED=0; DIRTY_UNTRACKED=0; APP_HOST_URL="http://localhost"; ENV_SLOT=""',
      'WT="$HARNESS_DIR"; ART="$HARNESS_DIR"; RESULTS="$HARNESS_DIR/results.tsv"; : >"$RESULTS"; SUPA_LOG="$HARNESS_DIR/supabase.log"',
      'SUPA_STARTED=0; SUPA_STAGE=""; OWN_STACK_SLOT=""; OWN_STACK_CONTAINERS=""; OWN_STACK_VOLUMES=""; OWN_STACK_NOTE=""',
      `. "${path.join(ROOT, SLOT_LIB)}"`,
      ...[
        "record",
        "tail_hint",
        "finish",
        "apply_slot",
        "slot_containers",
        "slot_volumes",
        "slot_stack_exists",
        "in_list",
        "remember_own_stack",
        "own_stack_only",
        "clear_own_stack",
        "check_slot_stack",
        "stop_supabase",
      ].map(extract),
      'apply_slot "$HARNESS_SLOT"',
      // integration の段と同じく、枠に残りが無いことを確かめてから起動した (ここでは FAKE_STATE に置いたものが起動したスタック)
      'if [ "${HARNESS_FRESH:-0}" = 0 ]; then',
      "  SUPA_STARTED=1; SUPA_STAGE=integration",
      "  record integration:security GREEN 1 0 0 1 1 1 -",
      "  stop_supabase",
      '  echo "AFTER_STOP STARTED=$SUPA_STARTED OWN_C=$OWN_STACK_CONTAINERS OWN_V=$OWN_STACK_VOLUMES"',
      "fi",
      // 次の段 (e2e) の前の確かめ
      'if [ "${HARNESS_NEXT:-0}" = 1 ]; then if check_slot_stack e2e; then echo "STACK_OK"; else echo "STACK_RED"; fi; fi',
      "finish",
      "",
    ].join("\n"),
  );

  let caseNo = 0;
  type Row = { kind: "c" | "v"; id: string; project: string };
  /** 起動したスタック (自分の枠) と、ほかの枠・ほかの project のもの */
  const stackOf = (slot: string, prefix: string): Row[] => [
    { kind: "c", id: `${prefix}db`, project: projectOf(slot) },
    { kind: "c", id: `${prefix}kong`, project: projectOf(slot) },
    { kind: "v", id: `supabase_db_${projectOf(slot)}`, project: projectOf(slot) },
    { kind: "v", id: `supabase_storage_${projectOf(slot)}`, project: projectOf(slot) },
  ];
  const others = (): Row[] => [
    ...stackOf("2", "s2"),
    ...stackOf("0", "s0"),
    { kind: "c", id: "otherproj01", project: "other-project" },
    { kind: "v", id: "other-project-vol", project: "other-project" },
  ];
  const runTeardown = (opts: { slot: string; state: Row[]; stop?: string; rmFails?: number; next?: boolean; fresh?: boolean }) => {
    caseNo += 1;
    const dir = path.join(tmp, `case-${caseNo}`);
    fs.mkdirSync(dir);
    const state = path.join(dir, "state");
    const calls = path.join(dir, "calls");
    fs.writeFileSync(state, opts.state.map((r) => `${r.kind} ${r.id} ${r.project}\n`).join(""));
    fs.writeFileSync(calls, "");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HARNESS_DIR: dir,
      HARNESS_SLOT: opts.slot,
      HARNESS_NEXT: opts.next ? "1" : "0",
      HARNESS_FRESH: opts.fresh ? "1" : "0",
      FAKE_STATE: state,
      FAKE_CALLS: calls,
      FAKE_LS_FAIL: path.join(dir, "ls-fail"),
      FAKE_STOP: opts.stop ?? "ok",
      FAKE_RM_FAILS: String(opts.rmFails ?? 0),
    };
    const r = spawnSync("bash", [harness], { cwd: dir, env, encoding: "utf8" });
    const rows = fs
      .readFileSync(path.join(dir, "results.tsv"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const left: Row[] = fs
      .readFileSync(state, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [kind, id, project] = line.split(" ");
        return { kind: kind as "c" | "v", id, project };
      });
    return { status: r.status, out: r.stdout, err: r.stderr, rows, left, calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) };
  };
  const red = (rows: string[][]) => rows.filter((row) => row[1] !== "GREEN");
  const sorted = (rows: Row[]) => rows.map((x) => `${x.kind} ${x.id} ${x.project}`).sort();
  const rmCalls = (calls: string[]) => calls.filter((c) => c.startsWith("DOCKER_RM") || c.startsWith("VOLUME_RM"));

  it("止めるのに成功したときは、何も消さず (docker rm を打たず)、赤にもしない", () => {
    const r = runTeardown({ slot: "1", state: [...stackOf("1", "own"), ...others()], stop: "ok" });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual(["RUN_IN bash scripts/supabase-local.sh stop"]);
    expect(red(r.rows)).toEqual([]);
    expect(sorted(r.left)).toEqual(sorted(others()));
    expect(r.out).toContain("AFTER_STOP STARTED=0");
  });

  it("prune の衝突で止めきれなかったときは、自分の枠の project_id のものだけを消して緑のまま進む (ほかの枠・ほかの project には触らない)", () => {
    const own = stackOf("1", "own");
    const r = runTeardown({ slot: "1", state: [...own, ...others()], stop: "prune" });
    expect(r.status, r.err).toBe(0);
    expect(red(r.rows)).toEqual([]);
    expect(rmCalls(r.calls)).toEqual(["DOCKER_RM owndb ownkong", `VOLUME_RM supabase_db_${projectOf("1")} supabase_storage_${projectOf("1")}`]);
    // コンテナを消してからボリュームを消す (ボリュームはコンテナが使っている間は消せない)
    expect(r.calls.findIndex((c) => c.startsWith("DOCKER_RM"))).toBeLessThan(r.calls.findIndex((c) => c.startsWith("VOLUME_RM")));
    expect(sorted(r.left)).toEqual(sorted(others()));
    // 止める前に控えたもの (この実行が起動したスタック) だけが「自分のもの」
    expect(r.out).toContain(`OWN_C=owndb ownkong OWN_V=supabase_db_${projectOf("1")} supabase_storage_${projectOf("1")}`);
    expect(r.err).toContain("この実行が起動したスタックのコンテナ / ボリュームが残っているので消します");
  });

  it("消しても残れば <段>:teardown を赤にし、終了コードを赤 (EXIT_RED) にする。ほかの枠のものは残したまま", () => {
    const r = runTeardown({ slot: "1", state: [...stackOf("1", "own"), ...others()], stop: "prune", rmFails: Number.MAX_SAFE_INTEGER });
    expect(r.status, r.err).toBe(EXIT_RED);
    const reds = red(r.rows);
    expect(reds.map((row) => row[0])).toEqual(["integration:teardown"]);
    expect(reds[0][8]).toContain(`枠 1 の project_id (${projectOf("1")}) のコンテナ / ボリュームが残っている`);
    expect(reds[0][8]).toContain("どれもこの実行が起動したスタックのもの");
    // 失敗したログの場所も備考に出す
    expect(reds[0][8]).toContain("supabase.log");
    expect(r.err).toContain("docker rm が失敗しました (owndb ownkong)");
    for (const row of others()) expect(sorted(r.left)).toContain(`${row.kind} ${row.id} ${row.project}`);
  });

  it("止めたあとに控えていないもの (他人のもの) が枠にあれば、それは消さずに赤にし、持ち主を確かめるよう知らせる", () => {
    const r = runTeardown({ slot: "1", state: [...stackOf("1", "own"), ...others()], stop: "prune-foreign" });
    expect(r.status, r.err).toBe(EXIT_RED);
    expect(rmCalls(r.calls).join("\n")).not.toContain("foreign0001");
    expect(sorted(r.left)).toEqual(sorted([...others(), { kind: "c", id: "foreign0001", project: projectOf("1") }]));
    const reds = red(r.rows);
    expect(reds.map((row) => row[0])).toEqual(["integration:teardown"]);
    expect(reds[0][8]).toContain("うち foreign0001 はこの実行が控えたものではないので消していない");
  });

  it("止めたあとに docker で一覧を取れなければ、消えたと見なさずに赤にする (何も消さない)", () => {
    const r = runTeardown({ slot: "1", state: [...stackOf("1", "own"), ...others()], stop: "prune-lsfail" });
    expect(r.status, r.err).toBe(EXIT_RED);
    expect(rmCalls(r.calls)).toEqual([]);
    expect(red(r.rows).map((row) => [row[0], row[8].includes("消えたかを確かめられない")])).toEqual([["integration:teardown", true]]);
  });

  it("枠 0 は、止めきれなくても消さず、赤にもしない (枠を使わない作業と共有している)", () => {
    const state = [...stackOf("0", "zero"), ...stackOf("2", "s2")];
    const r = runTeardown({ slot: "0", state, stop: "prune" });
    expect(r.status, r.err).toBe(0);
    expect(rmCalls(r.calls)).toEqual([]);
    expect(red(r.rows)).toEqual([]);
    expect(sorted(r.left)).toEqual(sorted(state));
    expect(r.out).toContain("AFTER_STOP STARTED=0 OWN_C= OWN_V=");
  });

  it("次の段の前 (check_slot_stack) に残っているのが、この実行が前の段で起動したスタックだけなら、片付けて進む", () => {
    // 前の段の片付けでは 1 回目の docker rm が失敗して残った (teardown は赤)。次の段の前にもう一度消して進む
    const r = runTeardown({ slot: "1", state: [...stackOf("1", "own"), ...others()], stop: "prune", rmFails: 1, next: true });
    expect(r.out, r.err).toContain("STACK_OK");
    expect(red(r.rows).map((row) => row[0])).toEqual(["integration:teardown"]);
    expect(r.status).toBe(EXIT_RED);
    expect(rmCalls(r.calls).filter((c) => c.startsWith("DOCKER_RM"))).toEqual(["DOCKER_RM owndb ownkong", "DOCKER_RM owndb ownkong"]);
    expect(sorted(r.left)).toEqual(sorted(others()));
    expect(r.err).toContain("この実行が前の段で起動したスタックが残っているので片付けます");
  });

  it("次の段の前に、この実行のスタックの残りを消せなければ、その段の setup を赤にする", () => {
    const r = runTeardown({ slot: "1", state: [...stackOf("1", "own"), ...others()], stop: "prune", rmFails: Number.MAX_SAFE_INTEGER, next: true });
    expect(r.out, r.err).toContain("STACK_RED");
    const reds = red(r.rows);
    expect(reds.map((row) => row[0])).toEqual(["integration:teardown", "e2e:setup"]);
    expect(reds[1][8]).toContain("この実行が前の段で起動したスタックの残りがあり、消せない");
    expect(r.status).toBe(EXIT_RED);
  });

  it("次の段の前に、控えていないものが 1 つでも混ざっていれば、何も消さずに今までどおり赤にする", () => {
    const r = runTeardown({ slot: "1", state: [...stackOf("1", "own"), ...others()], stop: "prune-foreign", rmFails: Number.MAX_SAFE_INTEGER, next: true });
    expect(r.out, r.err).toContain("STACK_RED");
    // docker rm を打ったのは、前の段の片付けの 1 回だけ (次の段の前には打たない)
    expect(rmCalls(r.calls).filter((c) => c.startsWith("DOCKER_RM"))).toEqual(["DOCKER_RM owndb ownkong"]);
    const reds = red(r.rows);
    expect(reds.map((row) => row[0])).toEqual(["integration:teardown", "e2e:setup"]);
    expect(reds[1][8]).toContain("ロックを取らずに手で起動したスタックなどかもしれないので消さずに赤で終える");
  });

  it("この実行がまだ何も起動していない枠に残っているものは、消さずに赤にする (他人のスタックを消さない)", () => {
    const r = runTeardown({ slot: "1", state: [...stackOf("1", "manual"), ...others()], fresh: true, next: true });
    expect(r.out, r.err).toContain("STACK_RED");
    expect(rmCalls(r.calls)).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(sorted(r.left)).toEqual(sorted([...stackOf("1", "manual"), ...others()]));
    expect(r.status).toBe(EXIT_RED);
  });

  it("枠に何も残っていなければ、次の段の前の確かめは何もせずに進む", () => {
    const r = runTeardown({ slot: "1", state: others(), fresh: true, next: true });
    expect(r.out, r.err).toContain("STACK_OK");
    expect(r.calls).toEqual([]);
    expect(red(r.rows)).toEqual([]);
  });

  it("integration / e2e の段は、ローカル Supabase を起動するときに段の名前 (SUPA_STAGE) を入れる (teardown の行の名前になる)", () => {
    for (const [fn, stage] of [
      ["stage_integration", "integration"],
      ["stage_e2e", "e2e"],
    ]) {
      const body = extract(fn)
        .split("\n")
        .map((line) => line.trim());
      const started = body.indexOf("SUPA_STARTED=1");
      expect(started, `${fn} に SUPA_STARTED=1 が無い`).toBeGreaterThan(0);
      expect(body[started + 1], fn).toBe(`SUPA_STAGE=${stage}`);
    }
  });
});

describe("scripts/supabase-local.sh: stop の prune の衝突のやり直し (#1616)", () => {
  // CLI と docker・sleep の代わりを置いた一時的な git リポジトリで、stop / stop-leftover を打つ (Docker も本物の CLI も使わない)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-local-stop-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const rel of [SUPABASE_LOCAL, SLOT_LIB, "supabase/config.toml", "supabase/baseline/manifest.json"]) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
  }
  fs.mkdirSync(path.join(tmp, "supabase/migrations"), { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: tmp });
  const PRUNE_CONFLICT = "failed to prune containers: Error response from daemon: a prune operation is already running";
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  // CLI の代わり: 呼ばれるたびに FAKE_COUNT に 1 行足し、FAKE_FAILS 回目までは FAKE_ERROR を stderr に出して FAKE_FAIL_CODE で終わる
  const fakeCli = path.join(bin, "fake-supabase");
  fs.writeFileSync(
    fakeCli,
    [
      "#!/usr/bin/env bash",
      'echo "$1" >>"$FAKE_COUNT"',
      'n="$(wc -l <"$FAKE_COUNT" | tr -d " ")"',
      'if [ "$n" -le "${FAKE_FAILS:-0}" ]; then echo "$FAKE_ERROR" >&2; exit "${FAKE_FAIL_CODE:-1}"; fi',
      'echo "FAKECLI $1 ok"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // ensure_docker の docker info だけに答える。sleep は待たずに秒数を書く
  fs.writeFileSync(path.join(bin, "docker"), '#!/usr/bin/env bash\n[ "$1" = info ]\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), '#!/usr/bin/env bash\necho "$1" >>"$FAKE_SLEEPS"\n', { mode: 0o755 });

  let caseNo = 0;
  const runStop = (opts: { cmd: string; slot?: string; fails: number; error?: string; failCode?: number; env?: Record<string, string> }) => {
    caseNo += 1;
    const count = path.join(tmp, `count-${caseNo}`);
    const sleeps = path.join(tmp, `sleeps-${caseNo}`);
    fs.writeFileSync(count, "");
    fs.writeFileSync(sleeps, "");
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      SUPABASE_CLI: fakeCli,
      LOCAL_CI_SLOT: opts.slot ?? "1",
      FAKE_COUNT: count,
      FAKE_SLEEPS: sleeps,
      FAKE_FAILS: String(opts.fails),
      FAKE_ERROR: opts.error ?? PRUNE_CONFLICT,
      FAKE_FAIL_CODE: String(opts.failCode ?? 1),
      ...opts.env,
    };
    const r = spawnSync("bash", [SUPABASE_LOCAL, opts.cmd], { cwd: tmp, env, encoding: "utf8" });
    const lines = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return { status: r.status, out: r.stdout, err: r.stderr, calls: lines(count), sleeps: lines(sleeps).map(Number) };
  };
  // stop は組み立て済みの作業ディレクトリが要る (prepare をしない)
  beforeAll(() => {
    for (const slot of ["1", "0"]) {
      const r = spawnSync("bash", [SUPABASE_LOCAL, "migrations"], {
        cwd: tmp,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_CLI: "true", LOCAL_CI_SLOT: slot },
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
    }
  });

  it("prune の衝突で失敗したら、間をおいて打ち直し、通ったら 0 で終わる (stdout は CLI のまま)", () => {
    const r = runStop({ cmd: "stop", fails: 2, env: { SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT: "1" } });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual(["stop", "stop", "stop"]);
    // n 回目の失敗のあとは単位 × n 秒待つ
    expect(r.sleeps).toEqual([1, 2]);
    expect(r.out.trim()).toBe("FAKECLI stop ok");
    expect(r.err).toContain("別の prune と重なって失敗したため");
  });

  it("既定では 5 回まで打ち、待ちは 5 秒単位 (5・10・15・20 秒)。それでも失敗したら CLI の終了コードで終わる", () => {
    const failCode = 7;
    const r = runStop({ cmd: "stop", fails: Number.MAX_SAFE_INTEGER, failCode });
    expect(r.status).toBe(failCode);
    expect(r.calls).toHaveLength(5);
    expect(r.sleeps).toEqual([5, 10, 15, 20]);
    expect(r.err).toContain("supabase stop が失敗しました (終了コード 7。5 回打った)");
  });

  it("回数の上限は環境変数で変えられる (1 なら打ち直さない)", () => {
    const three = runStop({ cmd: "stop", fails: Number.MAX_SAFE_INTEGER, env: { SUPABASE_LOCAL_STOP_RETRY_ATTEMPTS: "3", SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT: "0" } });
    expect(three.status).toBe(1);
    expect(three.calls).toHaveLength(3);
    expect(three.sleeps).toEqual([0, 0]);
    const one = runStop({ cmd: "stop", fails: Number.MAX_SAFE_INTEGER, env: { SUPABASE_LOCAL_STOP_RETRY_ATTEMPTS: "1" } });
    expect(one.status).toBe(1);
    expect(one.calls).toHaveLength(1);
    expect(one.sleeps).toEqual([]);
  });

  it("prune の衝突でない失敗は打ち直さない (打ち直しても直らない)", () => {
    const r = runStop({ cmd: "stop", fails: 1, error: "Error response from daemon: something else", failCode: 3 });
    expect(r.status).toBe(3);
    expect(r.calls).toEqual(["stop"]);
    expect(r.sleeps).toEqual([]);
  });

  it("1 回で通れば打ち直さない", () => {
    const r = runStop({ cmd: "stop", fails: 0 });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual(["stop"]);
    expect(r.sleeps).toEqual([]);
  });

  it("枠 0 の stop も同じく打ち直す", () => {
    const r = runStop({ cmd: "stop", slot: "0", fails: 1, env: { SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT: "0" } });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual(["stop", "stop"]);
  });

  it("stop-leftover も prune の衝突で打ち直す", () => {
    const r = runStop({ cmd: "stop-leftover", fails: 1, env: { SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT: "0" } });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual(["stop", "stop"]);
  });

  it("回数・待ちの環境変数が整数でない (回数は 1 以上) なら、CLI を呼ばずに 2 で止まる", () => {
    for (const env of [
      { SUPABASE_LOCAL_STOP_RETRY_ATTEMPTS: "0" },
      { SUPABASE_LOCAL_STOP_RETRY_ATTEMPTS: "abc" },
      { SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT: "-1" },
      { SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT: "1.5" },
    ]) {
      const r = runStop({ cmd: "stop", fails: 0, env });
      expect(r.status, JSON.stringify(env)).toBe(2);
      expect(r.calls, JSON.stringify(env)).toEqual([]);
    }
  });

  it("scripts/local-ci.sh は、回数・待ちの上書きの環境変数を子プロセスへ持ち込む", () => {
    const m = /^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(fs.readFileSync(path.join(ROOT, LOCAL_CI), "utf8"));
    const names = (m?.[1] ?? "").split(" ");
    expect(names).toContain("SUPABASE_LOCAL_STOP_RETRY_ATTEMPTS");
    expect(names).toContain("SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT");
  });
});

describe("このファイルの時間切れ (#1488)", () => {
  it("時間切れを個別に書いていないテストは、どれもこのファイルの時間切れ (SLOT_TEST_TIMEOUT_MS) で切れる (全体の既定の 5 秒のまま残っていない)", ({ task }) => {
    expect(testsWithUnexpectedTimeout(task.file, [SLOT_TEST_TIMEOUT_MS, RACE_TIMEOUT_MS])).toEqual([]);
  });
});
