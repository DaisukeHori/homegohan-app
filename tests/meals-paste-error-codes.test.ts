/**
 * #1634 POST /api/meals/paste — DB (paste_meal_to_family) が投げた語を取り違えない
 *
 * 以前の route は rpcError.message.includes('NOT_IN_FAMILY') を includes('TARGET_NOT_IN_FAMILY') より先に見ていたので、
 * DB の 'TARGET_NOT_IN_FAMILY' (貼り付けの先が同じ家族にいない) が 403 NOT_IN_FAMILY に化け、
 * 本来の 400 USER_NOT_IN_FAMILY が返らなかった。いまは例外の文の語を完全一致で引く。
 * 実 DB を通した確認は tests/integration/rls/paste-meal-errors.test.ts。
 * migration 20261015110000_paste_meal_reject_missing_source.sql で、存在しない元の行も NOT_MEAL_OWNER で断るようにした
 * (ここでは route の対応だけを見る)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
}));

const { POST } = await import('@/app/api/meals/paste/route');

const SOURCE_MEAL_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222';

function pasteRequest() {
  return new Request('http://localhost/api/meals/paste', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_meal_id: SOURCE_MEAL_ID, target_user_ids: [TARGET_USER_ID] }),
  });
}

async function pasteWithDbError(message: string): Promise<{ status: number; code: string; body: Record<string, unknown> }> {
  fakeSupabase = createFakeSupabase({}, [{ data: null, error: { message, code: 'P0001' } }]);
  fakeSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  const res = await POST(pasteRequest());
  const body = (await res.json()) as { error: { code: string } } & Record<string, unknown>;
  return { status: res.status, code: body.error.code, body };
}

/** paste_meal_to_family (DB) が RAISE EXCEPTION で投げる語 → この API が返す status と code */
const EXPECTED: ReadonlyArray<{ dbWord: string; status: number; code: string }> = [
  { dbWord: 'NOT_MEAL_OWNER', status: 403, code: MembershipErrorCode.INSUFFICIENT_PERMISSION },
  { dbWord: 'MEAL_HIDDEN', status: 403, code: MembershipErrorCode.MEAL_HIDDEN },
  { dbWord: 'MEAL_SANDBOX', status: 403, code: MembershipErrorCode.MEAL_SANDBOX },
  { dbWord: 'NOT_IN_FAMILY', status: 403, code: MembershipErrorCode.NOT_IN_FAMILY },
  { dbWord: 'TARGET_NOT_IN_FAMILY', status: 400, code: MembershipErrorCode.USER_NOT_IN_FAMILY },
];

describe('POST /api/meals/paste — DB の例外の語の判定 (#1634)', () => {
  it('TARGET_NOT_IN_FAMILY は 400 USER_NOT_IN_FAMILY (403 NOT_IN_FAMILY に化けない)', async () => {
    const res = await pasteWithDbError('TARGET_NOT_IN_FAMILY');
    expect(res.status).toBe(400);
    expect(res.code).toBe(MembershipErrorCode.USER_NOT_IN_FAMILY);
    expect(res.body).not.toHaveProperty('data');
  });

  it('NOT_IN_FAMILY (呼んだ人が家族にいない) は 403 NOT_IN_FAMILY のまま', async () => {
    const res = await pasteWithDbError('NOT_IN_FAMILY');
    expect(res.status).toBe(403);
    expect(res.code).toBe(MembershipErrorCode.NOT_IN_FAMILY);
  });

  it.each(EXPECTED)('DB の $dbWord は $status $code', async ({ dbWord, status, code }) => {
    const res = await pasteWithDbError(dbWord);
    expect(res.status).toBe(status);
    expect(res.code).toBe(code);
  });

  it.each(EXPECTED)('前置き付きの文 (ERROR: $dbWord) でも $status $code', async ({ dbWord, status, code }) => {
    const res = await pasteWithDbError(`ERROR: ${dbWord}`);
    expect(res.status).toBe(status);
    expect(res.code).toBe(code);
  });

  it('ある語が別の語の一部になっている組すべてで、長い語が短い語に取り違えられない', async () => {
    const pairs = EXPECTED.flatMap((shorter) =>
      EXPECTED.filter((longer) => longer.dbWord !== shorter.dbWord && longer.dbWord.includes(shorter.dbWord)).map((longer) => ({
        shorter,
        longer,
      })),
    );
    // 少なくとも NOT_IN_FAMILY ⊂ TARGET_NOT_IN_FAMILY の組がある (この組が #1634 の取り違え)
    expect(pairs.map(({ shorter, longer }) => `${shorter.dbWord} ⊂ ${longer.dbWord}`)).toContain('NOT_IN_FAMILY ⊂ TARGET_NOT_IN_FAMILY');
    for (const { longer } of pairs) {
      const res = await pasteWithDbError(longer.dbWord);
      expect(res.code, longer.dbWord).toBe(longer.code);
      expect(res.status, longer.dbWord).toBe(longer.status);
    }
  });

  it('表に無い語 (語の一部にだけ表の語を含むもの) は表の語に当てず、500 RPC_FAILED', async () => {
    const res = await pasteWithDbError('SOMETHING_NOT_IN_FAMILY_ELSE');
    expect(res.status).toBe(500);
    expect(res.code).toBe(MembershipErrorCode.RPC_FAILED);
  });

  it('DB の NOT_AUTHENTICATED は従来どおり対応表 (mapPgErrorToHttp) で 401 NOT_AUTHENTICATED', async () => {
    const res = await pasteWithDbError('NOT_AUTHENTICATED');
    expect(res.status).toBe(401);
    expect(res.code).toBe(MembershipErrorCode.NOT_AUTHENTICATED);
  });
});
