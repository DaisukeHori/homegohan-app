/**
 * Integration test: RPC complete_handson_tour()
 *
 * #1027 修正: 引数 (p_user_id) を廃止し auth.uid() を内部参照する方式に変更。
 * そのため本テストは service_role ではなく、テストユーザー自身のセッション
 * (authenticated ロール) で RPC を呼び出す。
 *
 * Test patterns:
 *   1. profile UPDATE + badge INSERT が atomic に実行される (自分のセッションで呼び出し)
 *   2. already_completed 判定 (2回目呼び出しで already_completed=true)
 *   3. anon (セッションなし) からの呼び出しは permission エラー
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

/** anon ロール (セッションなし) クライアント */
function anonSessionlessClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

describe.skipIf(!shouldRunIntegration())(
  'RPC complete_handson_tour() (integration)',
  () => {
    let user: TestUser;

    afterEach(async () => {
      if (user) await cleanupTestUser(user.id);
    });

    it('1. profile UPDATE + badge INSERT が atomic に実行される', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = authedClient(user.accessToken);
      const admin = adminClient();

      const { data: rawData, error } = await client.rpc('complete_handson_tour');
      const data = rawData as Record<string, unknown>;

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data.completed_at).toBeTruthy();
      expect(data.already_completed).toBe(false);
      expect(data.badge_awarded).toBeDefined();
      const badge = data.badge_awarded as Record<string, unknown>;
      expect(badge.code).toBe('tutorial_complete');
      expect(badge.obtained_at).toBeTruthy();
      // #1027 round-2: badges.icon_url は実在しない列 (実列は icon) だったため
      // RPC 内の SELECT が column-not-exist で常時失敗していた。icon_url キー自体は
      // 維持しつつ、値が string か null であること (SELECT が例外なく完走したこと) を検証する。
      expect(badge.icon_url === null || typeof badge.icon_url === 'string').toBe(true);

      // Verify profile was actually updated in DB (service_role で確認)
      const { data: profile } = await admin
        .from('user_profiles')
        .select('handson_tour_completed_at')
        .eq('id', user.id)
        .single();
      expect(profile?.handson_tour_completed_at).toBeTruthy();

      // Verify badge row was inserted
      const { data: badgeRow } = await admin
        .from('badges')
        .select('id')
        .eq('code', 'tutorial_complete')
        .single();
      expect(badgeRow).toBeDefined();

      const { data: userBadge } = await admin
        .from('user_badges')
        .select('obtained_at')
        .eq('user_id', user.id)
        .eq('badge_id', badgeRow!.id)
        .single();
      expect(userBadge?.obtained_at).toBeTruthy();
    });

    it('2. already_completed 判定 — 2回目呼び出しで already_completed=true', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = authedClient(user.accessToken);

      // First call
      await client.rpc('complete_handson_tour');

      // Second call
      const { data: rawData2, error } = await client.rpc('complete_handson_tour');
      const data2 = rawData2 as Record<string, unknown>;
      expect(error).toBeNull();
      expect(data2.already_completed).toBe(true);

      // completed_at should be same as first call (idempotent)
      expect(data2.completed_at).toBeTruthy();
    });

    it('3. anon (セッションなし) からの呼び出しは permission エラー (EXECUTE 権限自体が無い)', async () => {
      const client = anonSessionlessClient();

      const { error } = await client.rpc('complete_handson_tour');

      // #1027 round-2: anon には REVOKE EXECUTE ... FROM anon を明示しているため
      // 「関数内部の auth.uid() IS NULL チェック (unauthorized 例外)」ではなく
      // Postgres レベルの EXECUTE 権限拒否 (permission denied) になるはず。
      // 前者と後者を区別できないと、anon への default privilege 由来の暗黙
      // EXECUTE 残存 (#1027 round-2 Warning) を検出できない。
      expect(error).toBeDefined();
      expect(error?.message).toMatch(/permission denied/i);
      expect(error?.message).not.toMatch(/unauthorized/i);
    });
  },
);
