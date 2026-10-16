// @vitest-environment node
/**
 * tests/e2e/helpers/membership.ts の cleanup (e2e の後片付け) の単体テスト (#1103 項目 10)
 *
 * organizations.owner_id は NOT NULL で、外部キーは auth.users への ON DELETE RESTRICT。持ち主のユーザーは組織を消した後でないと消せない。
 * 一方、組織の DELETE は user_profiles.organization_id だけを ON DELETE SET NULL で外し、org_role は残すので、
 * 所属している利用者が 1 人でも残っていると CHECK user_profiles_org_consistency (両方 NULL か両方あり) に反して失敗する。
 * cleanup は次の順で動くことを確かめる:
 *   1. 消す組織に所属している利用者の organization_id / org_role を NULL に戻す
 *   2. 組織を消す
 *   3. ユーザーを消す
 * そして 1・2 が失敗したらユーザーを消さずに例外にし、3 の失敗 (deleteUser は error を返す) も例外にする
 * (以前は失敗を console.warn で捨て、持ち主と組織が残っていた)。
 *
 * 実 DB の制約 (CHECK と RESTRICT) との組み合わせは tests/integration/security/e2e-org-cleanup-helper.test.ts が確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteUser = vi.fn<(userId: string) => Promise<{ error: { message: string } | null }>>();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: { deleteUser } } }),
}));
// tests/e2e/helpers/membership.ts は import 時に .env.local を読む。テストの外の値を持ち込まない
vi.mock("dotenv", () => ({ config: vi.fn() }));

const SUPABASE_URL = "http://supabase.test";
const SERVICE_ROLE_KEY = "service-role-key-for-unit-test";
/** CHECK に反したときの PostgREST の応答の status (HTTP 400 Bad Request) */
const HTTP_BAD_REQUEST = 400;
const HTTP_NO_CONTENT = 204;

type Call = { method: string; url: string; body: unknown };

/** fetch の呼び出しを記録する。respond で個々の応答を差し替える */
function stubFetch(respond: (call: Call) => Response = () => new Response(null, { status: HTTP_NO_CONTENT })): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

async function loadCleanup() {
  const mod = await import("./e2e/helpers/membership");
  return mod.cleanup;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  deleteUser.mockReset();
  deleteUser.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("cleanup (e2e の後片付け) — 所属を外す → 組織 → ユーザーの順", () => {
  it("所属を外す PATCH を、組織の DELETE より前に、消す組織すべてを対象に 1 回送る", async () => {
    const calls = stubFetch();
    const cleanup = await loadCleanup();

    await cleanup({ orgIds: ["org-a", "org-b"], userIds: ["owner-1", "member-1"] });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PATCH ${SUPABASE_URL}/rest/v1/user_profiles?organization_id=in.(org-a,org-b)`,
      `DELETE ${SUPABASE_URL}/rest/v1/organizations?id=eq.org-a`,
      `DELETE ${SUPABASE_URL}/rest/v1/organizations?id=eq.org-b`,
    ]);
    // organization_id と org_role を両方 NULL にする (片方だけだと CHECK user_profiles_org_consistency に反する)
    expect(calls[0].body).toEqual({ organization_id: null, org_role: null });
    expect(deleteUser.mock.calls.map(([id]) => id)).toEqual(["owner-1", "member-1"]);
  });

  it("ユーザーは、組織の DELETE がすべて終わった後に消す (持ち主は owner_id の RESTRICT で先には消せない)", async () => {
    const order: string[] = [];
    stubFetch((call) => {
      order.push(`${call.method} ${call.url.split("/rest/v1/")[1]}`);
      return new Response(null, { status: HTTP_NO_CONTENT });
    });
    deleteUser.mockImplementation(async (id) => {
      order.push(`deleteUser ${id}`);
      return { error: null };
    });
    const cleanup = await loadCleanup();

    await cleanup({ orgIds: ["org-a"], userIds: ["owner-1"] });

    expect(order).toEqual([
      "PATCH user_profiles?organization_id=in.(org-a)",
      "DELETE organizations?id=eq.org-a",
      "deleteUser owner-1",
    ]);
  });

  it("組織の DELETE が失敗したら、ユーザーを消さずに例外にする (warn で続けない)", async () => {
    stubFetch((call) =>
      call.method === "DELETE"
        ? new Response('{"code":"23514","message":"violates check constraint \\"user_profiles_org_consistency\\""}', {
            status: HTTP_BAD_REQUEST,
          })
        : new Response(null, { status: HTTP_NO_CONTENT }),
    );
    const cleanup = await loadCleanup();

    await expect(cleanup({ orgIds: ["org-a"], userIds: ["owner-1"] })).rejects.toThrow(
      /org DELETE 失敗 \(orgId: org-a, status: 400\).*user_profiles_org_consistency/,
    );
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("所属を外す PATCH が失敗したら、組織もユーザーも消さずに例外にする", async () => {
    const calls = stubFetch((call) =>
      call.method === "PATCH"
        ? new Response("boom", { status: HTTP_BAD_REQUEST })
        : new Response(null, { status: HTTP_NO_CONTENT }),
    );
    const cleanup = await loadCleanup();

    await expect(cleanup({ orgIds: ["org-a"], userIds: ["owner-1"] })).rejects.toThrow(
      /所属の解除に失敗 \(orgIds: org-a, status: 400\): boom/,
    );
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("deleteUser が error を返したら (例外ではなく戻り値)、残りのユーザーも消したうえで例外にする", async () => {
    stubFetch();
    deleteUser.mockImplementation(async (id) =>
      id === "owner-1" ? { error: { message: "violates foreign key constraint organizations_owner_id_fkey" } } : { error: null },
    );
    const cleanup = await loadCleanup();

    await expect(cleanup({ orgIds: ["org-a"], userIds: ["owner-1", "member-1"] })).rejects.toThrow(
      /deleteUser 失敗 \(userId: owner-1\): violates foreign key constraint organizations_owner_id_fkey/,
    );
    expect(deleteUser.mock.calls.map(([id]) => id)).toEqual(["owner-1", "member-1"]);
  });

  it("組織を渡さなければ REST を呼ばず、ユーザーだけを消す", async () => {
    const calls = stubFetch();
    const cleanup = await loadCleanup();

    await cleanup({ userIds: ["user-1"] });

    expect(calls).toEqual([]);
    expect(deleteUser.mock.calls.map(([id]) => id)).toEqual(["user-1"]);
  });
});
