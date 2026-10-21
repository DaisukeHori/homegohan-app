// @vitest-environment node
/**
 * E2E の利用者への有料プランの手動付与 (billing/03 §16.1 の E2E の行) の番兵。
 *
 * billing/03 の migration から、
 *   - 家族プランの契約の無い代表者のグループ (free) には代表者以外のメンバーを足せない (family_members_billing_plan_gate)
 *   - 無料の利用者の献立の作成は 1 日 3 回 (ai_plan_feature_caps の free / menu_generation)
 * になった。段 A だけがマージされた main でも E2E (local-ci の e2e:playwright) が緑であるよう、
 *   1. tests/e2e/helpers/billing-plan.ts の grantManualPlanForE2e が billing_grant_manual_subscription を正しい引数で呼ぶ
 *   2. tests/e2e の、service_role で family_groups を直接 INSERT する道具は、INSERT の数以上 grantManualPlanForE2e を呼び、
 *      plan_key: "free" を書かない (billing/01 のトリガーが代表者の契約から決める)
 *   3. w5-3 の、本物の献立の作成の API へ無料の上限より多く送るテストは、pro を付与した利用者 (paidApiUserTest) で送る
 * を確かめる。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  E2E_FAMILY_PLAN_KEY,
  E2E_PAID_PERSONAL_PLAN_KEY,
  grantManualPlanForE2e,
} from "./e2e/helpers/billing-plan";

const ROOT = path.resolve(__dirname, "..");
const E2E_DIR = path.join(ROOT, "tests/e2e");
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const W53_SPEC = path.join(E2E_DIR, "w5-3-menu-gen-adversarial.spec.ts");

const SUPABASE_URL = "http://supabase.example.test";
const SERVICE_ROLE = "service-role-for-this-test";
const USER_ID = "00000000-0000-4000-8000-000000001912";
/** fetch の偽物が返す失敗のステータス (PostgREST が P0001 を返すときの 400) */
const HTTP_BAD_REQUEST = 400;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * コメントを除く (文字列の中の "//" や "/*" ("**\/api/**" の glob など) は残す)。
 * 文字列 (' " `) の中かどうかを 1 文字ずつ追う。テンプレートの ${...} の中の入れ子は見ない (この番兵が読むファイルには無い)
 */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".output")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 最後の migration が決めた free の献立の作成の 1 日の上限 (ai_plan_feature_caps の ('free', 'menu_generation', N)) */
function freeMenuGenerationCap(): number {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
  let cap: number | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const m of sql.matchAll(/\(\s*'free'\s*,\s*'menu_generation'\s*,\s*(\d+)\s*\)/g)) cap = Number(m[1]);
  }
  if (cap === null) throw new Error("ai_plan_feature_caps の free / menu_generation の行が migration に無い");
  return cap;
}

describe("grantManualPlanForE2e (tests/e2e/helpers/billing-plan.ts)", () => {
  it("service_role で billing_grant_manual_subscription に p_user_id・p_plan_key・p_expires_at = null を送る", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await grantManualPlanForE2e(USER_ID, E2E_FAMILY_PLAN_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SUPABASE_URL}/rest/v1/rpc/billing_grant_manual_subscription`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(SERVICE_ROLE);
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_ROLE}`);
    expect(JSON.parse(String(init.body))).toEqual({
      p_user_id: USER_ID,
      p_plan_key: "family_basic",
      p_expires_at: null,
    });
  });

  it("失敗の応答 (BILL_LIVE_ROW_CONFLICT など) は、ステータスと本文の先頭を付けて例外にする (黙って進めない)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"message":"BILL_LIVE_ROW_CONFLICT"}', { status: HTTP_BAD_REQUEST })),
    );

    await expect(grantManualPlanForE2e(USER_ID, E2E_PAID_PERSONAL_PLAN_KEY)).rejects.toThrow(
      /billing_grant_manual_subscription\(.*pro\) 失敗 \(400\): .*BILL_LIVE_ROW_CONFLICT/,
    );
  });

  it("環境変数が無ければ、何が足りないかが分かる例外で止まる", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(grantManualPlanForE2e(USER_ID, E2E_FAMILY_PLAN_KEY)).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("家族の fixture が付与するのは家族プラン、w5-3 が付与するのは個人の pro", () => {
    expect(E2E_FAMILY_PLAN_KEY).toBe("family_basic");
    expect(E2E_PAID_PERSONAL_PLAN_KEY).toBe("pro");
  });
});

describe("tests/e2e の家族の直接の組み立ては、代表者に家族プランを付与してから作る", () => {
  /** service_role の REST で family_groups を INSERT する呼び出し (クエリ文字列の無い URL = POST。GET / PATCH / DELETE は ?id=eq. を付ける) */
  const DIRECT_GROUP_INSERT = /\/rest\/v1\/family_groups`/g;
  const GRANT_CALL = /\bgrantManualPlanForE2e\(/g;
  const sources = listTsFiles(E2E_DIR)
    .filter((file) => file !== path.join(E2E_DIR, "helpers/billing-plan.ts"))
    .map((file) => ({ rel: path.relative(ROOT, file), code: stripComments(readFileSync(file, "utf8")) }));

  it("family_groups を直接 INSERT する道具が 1 つ以上ある (番兵が空振りしていない)", () => {
    const inserting = sources.filter((s) => (s.code.match(DIRECT_GROUP_INSERT) ?? []).length > 0).map((s) => s.rel);
    expect(inserting).toEqual(
      expect.arrayContaining([
        "tests/e2e/fixtures/fresh-family.ts",
        "tests/e2e/helpers/membership-family.ts",
        "tests/e2e/helpers/membership-paste.ts",
      ]),
    );
  });

  it("family_groups を直接 INSERT するファイルは、INSERT の数以上 grantManualPlanForE2e を呼ぶ", () => {
    const missing = sources
      .map((s) => ({
        rel: s.rel,
        inserts: (s.code.match(DIRECT_GROUP_INSERT) ?? []).length,
        grants: (s.code.match(GRANT_CALL) ?? []).length,
      }))
      .filter((s) => s.inserts > 0 && s.grants < s.inserts);
    expect(missing).toEqual([]);
  });

  it('plan_key: "free" を直接書かない (billing/01 のトリガーが代表者の契約から決め、書いても上書きされる)', () => {
    const offenders = sources.filter((s) => /plan_key\s*:\s*["']free["']/.test(s.code)).map((s) => s.rel);
    expect(offenders).toEqual([]);
  });
});

describe("w5-3: 無料の献立の作成の上限より多く本物の API へ送るテストは、pro を付与した利用者で送る", () => {
  const REAL_GENERATION_POST = /\.request\.post\(\s*"\/api\/ai\/menu\/(?:weekly\/request|v4\/generate)"/g;
  const code = stripComments(readFileSync(W53_SPEC, "utf8"));
  /** テストの宣言 (apiUserTest / paidApiUserTest / test) ごとに本文を切り出す */
  const blocks = [...code.matchAll(/^(paidApiUserTest|apiUserTest|test)\("([^"]+)"/gm)].map((m, i, all) => ({
    kind: m[1],
    title: m[2],
    body: code.slice(m.index ?? 0, all[i + 1]?.index ?? code.length),
  }));

  it("テストを切り出せている (番兵が空振りしていない)", () => {
    expect(blocks.some((b) => b.title.includes("A-3"))).toBe(true);
    expect(blocks.some((b) => b.title.includes("C-12"))).toBe(true);
  });

  it("本物の生成の API への送信をループで繰り返すか、無料の上限より多く書いたテストは paidApiUserTest", () => {
    const cap = freeMenuGenerationCap();
    const offenders = blocks
      .filter((b) => {
        const posts = (b.body.match(REAL_GENERATION_POST) ?? []).length;
        const loops = posts > 0 && /\bfor\s*\(/.test(b.body);
        return posts > 0 && (loops || posts > cap);
      })
      .filter((b) => b.kind !== "paidApiUserTest")
      .map((b) => b.title);
    expect(offenders).toEqual([]);
  });

  it("A-3・C-12 は paidApiUserTest で宣言されている", () => {
    for (const label of ["A-3", "C-12"]) {
      const block = blocks.find((b) => b.title.includes(label));
      expect(block?.kind, label).toBe("paidApiUserTest");
    }
  });
});
