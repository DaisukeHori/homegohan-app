/**
 * #1196 cron 共有シークレットの照合 (supabase/functions/_shared/cron-secret.ts と、それを使う Edge Functions の requireServiceRole)
 *
 * シークレットの入れ替え中は、新しい値 (CRON_SECRET) と旧い値 (CRON_SECRET_PREVIOUS) の両方を受け付ける。
 * それ以外の振る舞い (Bearer の書き方、未設定のときの 503、一致しないときの 401) は、これまでの
 * `authHeader !== \`Bearer ${secret}\`` の比較と同じにする。
 *
 * 値はすべてテスト用のダミー。本物のシークレットは使わない。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { requireServiceRole } from "../supabase/functions/_shared/auth.ts";
import {
  checkCronSecret,
  timingSafeEqualBytes,
} from "../supabase/functions/_shared/cron-secret.ts";

// auth.ts の requireAuth が使う createClient を読み込まないための差し替え (requireServiceRole では使わない)
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

const NEW_SECRET = "dummy-new-cron-secret-0123456789abcdef";
const OLD_SECRET = "dummy-old-cron-secret-fedcba9876543210";

const bearer = (secret: string) => `Bearer ${secret}`;

describe("checkCronSecret (#1196)", () => {
  it("CS-1: 現行のシークレットなら通る (matched: current)", async () => {
    await expect(checkCronSecret(bearer(NEW_SECRET), { current: NEW_SECRET })).resolves.toEqual({
      ok: true,
      matched: "current",
    });
  });

  it("CS-2: 入れ替え中は、旧いシークレット (previous) でも通る (matched: previous)", async () => {
    const secrets = { current: NEW_SECRET, previous: OLD_SECRET };
    await expect(checkCronSecret(bearer(NEW_SECRET), secrets)).resolves.toEqual({ ok: true, matched: "current" });
    await expect(checkCronSecret(bearer(OLD_SECRET), secrets)).resolves.toEqual({ ok: true, matched: "previous" });
  });

  it("CS-3: 現行でも旧でもない値は unauthorized (同じ長さ・短い・長い・先頭だけ一致・末尾だけ一致)", async () => {
    const secrets = { current: NEW_SECRET, previous: OLD_SECRET };
    const wrongValues = [
      "x".repeat(NEW_SECRET.length),
      "x",
      NEW_SECRET.slice(0, -1),
      `${NEW_SECRET}x`,
      `${NEW_SECRET}${OLD_SECRET}`,
      `${NEW_SECRET.slice(0, 10)}${"x".repeat(NEW_SECRET.length - 10)}`,
      `${"x".repeat(NEW_SECRET.length - 10)}${NEW_SECRET.slice(-10)}`,
      "x".repeat(10_000),
    ];
    for (const wrong of wrongValues) {
      await expect(checkCronSecret(bearer(wrong), secrets), wrong.slice(0, 20)).resolves.toEqual({
        ok: false,
        reason: "unauthorized",
      });
    }
  });

  it("CS-4: Authorization ヘッダーがない (null / undefined / 空文字) なら unauthorized", async () => {
    const secrets = { current: NEW_SECRET, previous: OLD_SECRET };
    for (const missing of [null, undefined, ""]) {
      await expect(checkCronSecret(missing, secrets)).resolves.toEqual({ ok: false, reason: "unauthorized" });
    }
  });

  it("CS-5: 現行が未設定・空文字・null なら not_configured。旧い値に一致していても通さない", async () => {
    for (const current of [undefined, null, ""]) {
      const secrets = { current, previous: OLD_SECRET };
      for (const header of [null, "", "Bearer ", bearer("anything"), bearer(OLD_SECRET)]) {
        await expect(checkCronSecret(header, secrets)).resolves.toEqual({ ok: false, reason: "not_configured" });
      }
    }
    // 旧い値も無い場合も同じ
    await expect(checkCronSecret(bearer(NEW_SECRET), { current: undefined })).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("CS-6: 旧いシークレットが未設定・空文字・null のときは無視する。ヘッダーなし・空のトークンを通さない", async () => {
    for (const previous of [undefined, null, ""]) {
      const secrets = { current: NEW_SECRET, previous };
      // 空の previous から `Bearer ${previous}` を作ると "Bearer " になる。それに一致させない
      for (const header of [null, undefined, "", "Bearer", "Bearer ", "Bearer  ", "bearer "]) {
        await expect(checkCronSecret(header, secrets), String(header)).resolves.toEqual({
          ok: false,
          reason: "unauthorized",
        });
      }
      // 現行は通常どおり通る
      await expect(checkCronSecret(bearer(NEW_SECRET), secrets)).resolves.toEqual({ ok: true, matched: "current" });
    }
  });

  it("CS-7: Bearer の書き方は今までと同じ (大文字小文字を読み替えず、空白を補わず、スキームなしを通さない)", async () => {
    const secrets = { current: NEW_SECRET, previous: OLD_SECRET };
    for (const secret of [NEW_SECRET, OLD_SECRET]) {
      const rejected = [
        secret, // スキームなし
        `bearer ${secret}`,
        `BEARER ${secret}`,
        `Basic ${secret}`,
        `Token ${secret}`,
        `Bearer  ${secret}`, // 空白が 2 つ
        ` Bearer ${secret}`,
        `Bearer ${secret} `,
        `Bearer\t${secret}`,
        `Bearer ${secret}\n`,
      ];
      for (const header of rejected) {
        await expect(checkCronSecret(header, secrets), JSON.stringify(header)).resolves.toEqual({
          ok: false,
          reason: "unauthorized",
        });
      }
    }
  });

  it("CS-8: 現行と旧が同じ値でも、現行として扱う", async () => {
    await expect(
      checkCronSecret(bearer(NEW_SECRET), { current: NEW_SECRET, previous: NEW_SECRET }),
    ).resolves.toEqual({ ok: true, matched: "current" });
  });

  it("CS-9: 日本語など ASCII 以外を含む値でも照合できる", async () => {
    const secret = "秘密のシークレット-🔑-テスト";
    await expect(checkCronSecret(bearer(secret), { current: secret })).resolves.toEqual({ ok: true, matched: "current" });
    await expect(checkCronSecret(bearer("秘密のシークレット-🔑-テスヨ"), { current: secret })).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("CS-10: 結果が何であっても SHA-256 を同じ回数だけ計算する (一致した時点で止めない)", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const counts: number[] = [];
      const cases: Array<[string, { current: string; previous?: string }]> = [
        [bearer(NEW_SECRET), { current: NEW_SECRET, previous: OLD_SECRET }], // 現行に一致
        [bearer(OLD_SECRET), { current: NEW_SECRET, previous: OLD_SECRET }], // 旧に一致
        [bearer("wrong"), { current: NEW_SECRET, previous: OLD_SECRET }], // どちらにも不一致
        [bearer(NEW_SECRET), { current: NEW_SECRET }], // 旧が未設定
        [bearer(NEW_SECRET), { current: NEW_SECRET, previous: "" }], // 旧が空文字
        [bearer("wrong"), { current: NEW_SECRET }], // 旧が未設定で不一致
      ];
      for (const [header, secrets] of cases) {
        digest.mockClear();
        await checkCronSecret(header, secrets);
        counts.push(digest.mock.calls.length);
      }
      // ヘッダー 1 回 + 現行 1 回 + 旧 1 回
      expect(counts).toEqual([3, 3, 3, 3, 3, 3]);
    } finally {
      digest.mockRestore();
    }
  });

  it("CS-11: 戻り値にシークレットの値を含めない", async () => {
    const results = [
      await checkCronSecret(bearer(NEW_SECRET), { current: NEW_SECRET, previous: OLD_SECRET }),
      await checkCronSecret(bearer(OLD_SECRET), { current: NEW_SECRET, previous: OLD_SECRET }),
      await checkCronSecret(bearer("wrong"), { current: NEW_SECRET, previous: OLD_SECRET }),
      await checkCronSecret(null, { current: undefined, previous: OLD_SECRET }),
    ];
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(NEW_SECRET);
    expect(serialized).not.toContain(OLD_SECRET);
  });
});

describe("timingSafeEqualBytes (#1196)", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);

  it("TB-1: 同じバイト列なら true (空どうしも true)", () => {
    expect(timingSafeEqualBytes(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
    expect(timingSafeEqualBytes(bytes(), bytes())).toBe(true);
  });

  it("TB-2: どの位置が違っても false (先頭・中間・末尾)", () => {
    expect(timingSafeEqualBytes(bytes(9, 2, 3), bytes(1, 2, 3))).toBe(false);
    expect(timingSafeEqualBytes(bytes(1, 9, 3), bytes(1, 2, 3))).toBe(false);
    expect(timingSafeEqualBytes(bytes(1, 2, 9), bytes(1, 2, 3))).toBe(false);
  });

  it("TB-3: 長さが違えば、片方がもう片方の接頭辞でも false", () => {
    expect(timingSafeEqualBytes(bytes(1, 2), bytes(1, 2, 3))).toBe(false);
    expect(timingSafeEqualBytes(bytes(1, 2, 3), bytes(1, 2))).toBe(false);
    expect(timingSafeEqualBytes(bytes(), bytes(0))).toBe(false);
    expect(timingSafeEqualBytes(bytes(0), bytes())).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Edge Functions の requireServiceRole
// ─────────────────────────────────────────────

type EnvName = "CRON_SECRET" | "CRON_SECRET_PREVIOUS" | "SERVICE_ROLE_SECRET";

describe("requireServiceRole (#1196)", () => {
  let env: Partial<Record<EnvName, string>>;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    env = {};
    vi.stubGlobal("Deno", { env: { get: (name: string) => env[name as EnvName] } });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  function request(authorization?: string): Request {
    return new Request("http://localhost/functions/v1/import-lawson-catalog?debug=1", {
      method: "POST",
      headers: authorization === undefined ? {} : { authorization },
    });
  }

  async function expectResponse(res: Response | null, status: number, error: string) {
    expect(res).not.toBeNull();
    expect(res!.status).toBe(status);
    expect(res!.headers.get("Content-Type")).toBe("application/json");
    await expect(res!.json()).resolves.toEqual({ error });
  }

  it("RS-1: 現行のシークレットなら null (認証成功)。警告は出さない", async () => {
    env.CRON_SECRET = NEW_SECRET;
    expect(await requireServiceRole(request(bearer(NEW_SECRET)))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("RS-2: 入れ替え中は CRON_SECRET_PREVIOUS (旧い値) でも通り、旧い値で認証されたことを警告に残す", async () => {
    env.CRON_SECRET = NEW_SECRET;
    env.CRON_SECRET_PREVIOUS = OLD_SECRET;

    expect(await requireServiceRole(request(bearer(NEW_SECRET)))).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    expect(await requireServiceRole(request(bearer(OLD_SECRET)))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("CRON_SECRET_PREVIOUS");
    // どの関数がまだ旧い値で呼ばれているかが分かるようにパスは出す。クエリと秘密の値は出さない
    expect(message).toContain("/functions/v1/import-lawson-catalog");
    expect(message).not.toContain("debug=1");
    expect(message).not.toContain(OLD_SECRET);
    expect(message).not.toContain(NEW_SECRET);
  });

  it("RS-3: どちらでもない値は 401 Unauthorized", async () => {
    env.CRON_SECRET = NEW_SECRET;
    env.CRON_SECRET_PREVIOUS = OLD_SECRET;
    await expectResponse(await requireServiceRole(request(bearer("wrong"))), 401, "Unauthorized");
    await expectResponse(await requireServiceRole(request(bearer(NEW_SECRET.slice(0, -1)))), 401, "Unauthorized");
    expect(warn).not.toHaveBeenCalled();
  });

  it("RS-4: Authorization ヘッダーがなければ 401 Unauthorized", async () => {
    env.CRON_SECRET = NEW_SECRET;
    env.CRON_SECRET_PREVIOUS = OLD_SECRET;
    await expectResponse(await requireServiceRole(request()), 401, "Unauthorized");
  });

  it("RS-5: CRON_SECRET が未設定なら、今までどおり 503 Service not configured", async () => {
    await expectResponse(await requireServiceRole(request(bearer(NEW_SECRET))), 503, "Service not configured");
    await expectResponse(await requireServiceRole(request()), 503, "Service not configured");
  });

  it("RS-6: CRON_SECRET が空文字なら 503 (今までと同じ。?? は空文字を未設定とみなさないので SERVICE_ROLE_SECRET には落ちない)", async () => {
    env.CRON_SECRET = "";
    env.SERVICE_ROLE_SECRET = NEW_SECRET;
    await expectResponse(await requireServiceRole(request(bearer(NEW_SECRET))), 503, "Service not configured");
  });

  it("RS-7: CRON_SECRET_PREVIOUS だけが設定されていても 503 (旧い値だけで通る状態にしない)", async () => {
    env.CRON_SECRET_PREVIOUS = OLD_SECRET;
    await expectResponse(await requireServiceRole(request(bearer(OLD_SECRET))), 503, "Service not configured");
    expect(warn).not.toHaveBeenCalled();
  });

  it("RS-8: 空文字の CRON_SECRET_PREVIOUS は無視する。ヘッダーなし・空のトークンは 401", async () => {
    env.CRON_SECRET = NEW_SECRET;
    env.CRON_SECRET_PREVIOUS = "";
    await expectResponse(await requireServiceRole(request()), 401, "Unauthorized");
    await expectResponse(await requireServiceRole(request("Bearer ")), 401, "Unauthorized");
    await expectResponse(await requireServiceRole(request("")), 401, "Unauthorized");
    expect(await requireServiceRole(request(bearer(NEW_SECRET)))).toBeNull();
  });

  it("RS-9: CRON_SECRET が無いときだけ、別名の SERVICE_ROLE_SECRET を現行として使う (今までと同じ)", async () => {
    env.SERVICE_ROLE_SECRET = NEW_SECRET;
    expect(await requireServiceRole(request(bearer(NEW_SECRET)))).toBeNull();
    await expectResponse(await requireServiceRole(request(bearer("wrong"))), 401, "Unauthorized");

    // CRON_SECRET があるときは SERVICE_ROLE_SECRET を使わない (今までと同じ)
    env.CRON_SECRET = OLD_SECRET;
    await expectResponse(await requireServiceRole(request(bearer(NEW_SECRET))), 401, "Unauthorized");
    expect(await requireServiceRole(request(bearer(OLD_SECRET)))).toBeNull();
  });

  it("RS-10: SERVICE_ROLE_SECRET を現行として使っている場合も、CRON_SECRET_PREVIOUS で入れ替えられる", async () => {
    env.SERVICE_ROLE_SECRET = NEW_SECRET;
    env.CRON_SECRET_PREVIOUS = OLD_SECRET;
    expect(await requireServiceRole(request(bearer(NEW_SECRET)))).toBeNull();
    expect(await requireServiceRole(request(bearer(OLD_SECRET)))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("RS-11: Bearer の書き方は今までと同じ (小文字の bearer やスキームなしは 401)", async () => {
    env.CRON_SECRET = NEW_SECRET;
    env.CRON_SECRET_PREVIOUS = OLD_SECRET;
    for (const secret of [NEW_SECRET, OLD_SECRET]) {
      await expectResponse(await requireServiceRole(request(`bearer ${secret}`)), 401, "Unauthorized");
      await expectResponse(await requireServiceRole(request(secret)), 401, "Unauthorized");
      await expectResponse(await requireServiceRole(request(`Bearer  ${secret}`)), 401, "Unauthorized");
    }
  });
});
