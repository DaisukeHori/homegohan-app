/**
 * Integration test: RPC user_has_non_sandbox_activity()
 *
 * 本番の関数は引数を取らず、内部で auth.uid() を参照して「自分の」行だけを判定する
 * (「他人の情報漏洩なし」が設計意図)。そのため service_role で p_user_id を渡す呼び方は
 * できず (PGRST202)、テストユーザー自身のセッション (authenticated ロール) で呼び出す。
 *
 * Test patterns:
 *   1. meals に non-sandbox あり → true
 *   2. user_daily_meals に non-sandbox あり → true
 *   3. sandbox の行だけ (meals / user_daily_meals とも) → false
 *   4. 行が 1 つも無い → false
 *   5. 他人の non-sandbox activity は見えない (自分のセッションの行だけを判定する)
 *
 * 本番スキーマの注意:
 *   - meals に dish_name 列は無い (必須列は user_id / eaten_at / meal_type)
 *   - user_daily_meals の日付列は day_date (date ではない)
 *   存在しない列を渡すと INSERT が失敗して行が入らず、「false になるはず」のテストが
 *   空振りで通ってしまうため、INSERT の失敗はその場で落とす (#857)。
 *
 * Requires: SUPABASE_INTEGRATION_TEST=1
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterEach } from 'vitest';
import ws from 'ws';
import {
  shouldRunIntegration,
  createTestUser,
  cleanupTestUser,
  adminClient,
  type TestUser,
} from '../helpers/supabase';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** JWT 付き認証済みクライアントを返す (authenticated ロール、auth.uid() が自分の id になる) */
function authedClient(accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** そのユーザー自身のセッションで RPC を呼び、判定結果を返す */
async function hasNonSandboxActivity(user: TestUser): Promise<boolean> {
  const { data, error } = await authedClient(user.accessToken).rpc('user_has_non_sandbox_activity');
  expect(error).toBeNull();
  return data as boolean;
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

/** meals に 1 行 INSERT する (失敗したらその場で落とす) */
async function insertMeal(
  client: SupabaseClient,
  userId: string,
  isSandbox: boolean,
): Promise<void> {
  const { error } = await client.from('meals').insert({
    user_id: userId,
    eaten_at: new Date().toISOString(),
    meal_type: 'breakfast',
    is_sandbox: isSandbox,
  });
  expect(error).toBeNull();
}

/** user_daily_meals に 1 行 INSERT する (失敗したらその場で落とす) */
async function insertDailyMeal(
  client: SupabaseClient,
  userId: string,
  isSandbox: boolean,
): Promise<void> {
  const { error } = await client.from('user_daily_meals').insert({
    user_id: userId,
    day_date: today(),
    is_sandbox: isSandbox,
  });
  expect(error).toBeNull();
}

describe.skipIf(!shouldRunIntegration())(
  'RPC user_has_non_sandbox_activity() (integration)',
  () => {
    // 1 テストで複数ユーザーを作る場合があるため配列で持つ
    let users: TestUser[] = [];

    async function newUser(): Promise<TestUser> {
      const user = await createTestUser({ onboardingCompleted: true });
      users.push(user);
      return user;
    }

    afterEach(async () => {
      const client = adminClient();
      for (const user of users) {
        // Clean up test data before user deletion
        await client.from('meals').delete().eq('user_id', user.id);
        await client.from('user_daily_meals').delete().eq('user_id', user.id);
        await cleanupTestUser(user.id);
      }
      users = [];
    });

    it('1. meals に non-sandbox あり → true', async () => {
      const user = await newUser();
      await insertMeal(adminClient(), user.id, false);

      expect(await hasNonSandboxActivity(user)).toBe(true);
    });

    it('2. user_daily_meals に non-sandbox あり → true', async () => {
      const user = await newUser();
      await insertDailyMeal(adminClient(), user.id, false);

      expect(await hasNonSandboxActivity(user)).toBe(true);
    });

    it('3. sandbox の行だけ (meals / user_daily_meals とも) → false', async () => {
      const user = await newUser();
      const client = adminClient();

      // sandbox の行は「既存ユーザーの活動」に数えない (ハンズオン中の投入データのため)
      await insertMeal(client, user.id, true);
      await insertDailyMeal(client, user.id, true);

      expect(await hasNonSandboxActivity(user)).toBe(false);
    });

    it('4. 行が 1 つも無い → false', async () => {
      const user = await newUser();

      expect(await hasNonSandboxActivity(user)).toBe(false);
    });

    it('5. 他人の non-sandbox activity は見えない (自分のセッションの行だけを判定する)', async () => {
      const withActivity = await newUser();
      const withoutActivity = await newUser();
      await insertMeal(adminClient(), withActivity.id, false);

      // 行を持つ本人には true、行を持たない別ユーザーには false
      // (他人の行が見えると、新規ユーザーなのに既存ユーザー扱いでハンズオンが出なくなる)
      expect(await hasNonSandboxActivity(withActivity)).toBe(true);
      expect(await hasNonSandboxActivity(withoutActivity)).toBe(false);
    });
  },
);
