/**
 * #1167 バッチ専用の Edge Function の認証 (_shared/auth.ts の requireServiceRole)
 *
 * バッチ専用の関数 (aggregate-org-stats など) は、これまで CRON_SECRET / SERVICE_ROLE_SECRET だけを受け付けていた。
 * 組織ダッシュボードの「Refresh Data」は、ブラウザから関数を直接呼ぶ(CORS を開けないと呼べない)のをやめて、
 * Next.js の API ルートが権限を確認したうえで、サーバーから関数を呼ぶ形にした (POST /api/org/stats/refresh)。
 * Next.js が持っているのは CRON_SECRET ではなく service role key なので、
 * regenerate-embeddings / stripe-price-sync が関数の中でやっているのと同じく、service role key の完全一致も許可する。
 *
 * 既存の受け付け方 (CRON_SECRET / SERVICE_ROLE_SECRET) と、拒否する場合は変えない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireServiceRole } from "../supabase/functions/_shared/auth.ts";

let env: Record<string, string | undefined> = {};

beforeEach(() => {
  env = {};
  vi.stubGlobal("Deno", { env: { get: (key: string) => env[key] } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CRON_SECRET = "cron-secret-for-test";
const SERVICE_ROLE_KEY = "service-role-key-for-test";
const SERVICE_ROLE_JWT = "service-role-jwt-for-test";

function requestWith(authorization?: string): Request {
  return new Request("https://example.supabase.co/functions/v1/aggregate-org-stats", {
    method: "POST",
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

async function errorOf(res: Response | null): Promise<{ status: number; body: unknown }> {
  expect(res).not.toBeNull();
  return { status: res!.status, body: await res!.json() };
}

describe("requireServiceRole: 従来の受け付け方 (変えていない)", () => {
  it("SR-1: CRON_SECRET と一致する Bearer は通る", () => {
    env.CRON_SECRET = CRON_SECRET;
    expect(requireServiceRole(requestWith(`Bearer ${CRON_SECRET}`))).toBeNull();
  });

  it("SR-2: CRON_SECRET が未設定なら SERVICE_ROLE_SECRET と比べる", () => {
    env.SERVICE_ROLE_SECRET = "service-role-secret-for-test";
    expect(requireServiceRole(requestWith("Bearer service-role-secret-for-test"))).toBeNull();
  });

  it("SR-3: CRON_SECRET が設定されていれば、SERVICE_ROLE_SECRET は受け付けない (CRON_SECRET が優先)", async () => {
    env.CRON_SECRET = CRON_SECRET;
    env.SERVICE_ROLE_SECRET = "service-role-secret-for-test";
    const res = requireServiceRole(requestWith("Bearer service-role-secret-for-test"));
    expect(await errorOf(res)).toEqual({ status: 401, body: { error: "Unauthorized" } });
  });

  it("SR-4: 違う値・Authorization ヘッダー無し・Bearer 以外は 401", async () => {
    env.CRON_SECRET = CRON_SECRET;
    for (const authorization of ["Bearer wrong", undefined, CRON_SECRET, `Basic ${CRON_SECRET}`, "Bearer "]) {
      const res = requireServiceRole(requestWith(authorization));
      expect(await errorOf(res)).toEqual({ status: 401, body: { error: "Unauthorized" } });
    }
  });

  it("SR-5: 秘密が何も設定されていなければ、service role key 以外は 503 (設定漏れを成功にしない)", async () => {
    const res = requireServiceRole(requestWith("Bearer anything"));
    expect(await errorOf(res)).toEqual({ status: 503, body: { error: "Service not configured" } });
  });
});

describe("requireServiceRole: service role key の完全一致も許可する (#1167)", () => {
  it("SR-6: SUPABASE_SERVICE_ROLE_KEY と一致する Bearer は通る (CRON_SECRET が設定されていても)", () => {
    env.CRON_SECRET = CRON_SECRET;
    env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    expect(requireServiceRole(requestWith(`Bearer ${SERVICE_ROLE_KEY}`))).toBeNull();
  });

  it("SR-7: SERVICE_ROLE_JWT (Edge Function の Secret に入れた service role の JWT) とも一致すれば通る", () => {
    env.CRON_SECRET = CRON_SECRET;
    env.SUPABASE_SERVICE_ROLE_KEY = "platform-injected-key";
    env.SERVICE_ROLE_JWT = SERVICE_ROLE_JWT;
    expect(requireServiceRole(requestWith(`Bearer ${SERVICE_ROLE_JWT}`))).toBeNull();
    expect(requireServiceRole(requestWith("Bearer platform-injected-key"))).toBeNull();
  });

  it("SR-8: CRON_SECRET / SERVICE_ROLE_SECRET が未設定でも、service role key なら通る (503 にしない)", () => {
    env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    expect(requireServiceRole(requestWith(`Bearer ${SERVICE_ROLE_KEY}`))).toBeNull();
  });

  it("SR-9: Bearer の綴りの大文字小文字や余分な空白は許す (regenerate-embeddings と同じ)", () => {
    env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    expect(requireServiceRole(requestWith(`bearer   ${SERVICE_ROLE_KEY}  `))).toBeNull();
  });

  it("SR-12: 認証方式 (Bearer) を付けずに service role key だけを送っても通さない", async () => {
    env.CRON_SECRET = CRON_SECRET;
    env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    env.SERVICE_ROLE_JWT = SERVICE_ROLE_JWT;
    for (const authorization of [
      SERVICE_ROLE_KEY,
      SERVICE_ROLE_JWT,
      `Basic ${SERVICE_ROLE_KEY}`,
      `Token ${SERVICE_ROLE_KEY}`,
      `Bearer${SERVICE_ROLE_KEY}`,
    ]) {
      const res = requireServiceRole(requestWith(authorization));
      expect(await errorOf(res), `Authorization: "${authorization}" が通ってはいけない`).toEqual({
        status: 401,
        body: { error: "Unauthorized" },
      });
    }
  });

  it("SR-10: service role key と違う値は通さない。署名を検証していない JWT のペイロードの role は信用しない", async () => {
    env.CRON_SECRET = CRON_SECRET;
    env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
    const forged = `eyJhbGciOiJIUzI1NiJ9.${payload}.forged-signature`;
    for (const token of [forged, `${SERVICE_ROLE_KEY}x`, SERVICE_ROLE_KEY.slice(0, -1)]) {
      const res = requireServiceRole(requestWith(`Bearer ${token}`));
      expect(await errorOf(res)).toEqual({ status: 401, body: { error: "Unauthorized" } });
    }
  });

  it("SR-11: 環境変数が空文字のときに、空の Bearer が通ってしまわない", async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = "";
    env.SERVICE_ROLE_JWT = "";
    env.CRON_SECRET = CRON_SECRET;
    for (const authorization of ["Bearer ", "Bearer", ""]) {
      const res = requireServiceRole(requestWith(authorization));
      expect(res, `Authorization: "${authorization}" が通ってはいけない`).not.toBeNull();
      expect(res!.status).toBe(401);
    }

    // 秘密が何も設定されていないときも、空の Bearer は 503 のまま (通らない)
    env.CRON_SECRET = undefined;
    const res = requireServiceRole(requestWith("Bearer "));
    expect(await errorOf(res)).toEqual({ status: 503, body: { error: "Service not configured" } });
  });
});
