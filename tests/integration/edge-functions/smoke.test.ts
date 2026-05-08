/**
 * Supabase Edge Functions smoke tests
 *
 * 対象 function (7 個):
 *   1. generate-hint           — requireAuth (Supabase JWT)
 *   2. analyze-fridge          — requireAuth (Supabase JWT)
 *   3. generate-health-insights — Authorization header → 401
 *   4. analyze-meal-photo      — Authorization header → 401
 *   5. knowledge-gpt           — Authorization header → 401, GET → 405
 *   6. normalize-shopping-list — 認証なし、ingredients 配列必須
 *   7. regenerate-shopping-list-v2 — 認証なし(内部 service role)、必須フィールド → 400
 *
 * 実行前提:
 *   SUPABASE_INTEGRATION_TEST=1
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';
import { shouldRunIntegration } from '../helpers/supabase';

// ---------------------------------------------------------------------------
// テスト実行ガード
// ---------------------------------------------------------------------------
if (!shouldRunIntegration()) {
  describe.skip('Edge Functions smoke (SUPABASE_INTEGRATION_TEST=1 でスキップ解除)', () => {
    it.skip('skipped', () => {});
  });
} else {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  // ---------------------------------------------------------------------------
  // テストユーザーのライフサイクル
  // ---------------------------------------------------------------------------
  let testUserAccessToken: string;
  let testUserId: string;

  beforeAll(async () => {
    const adminClient: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: ws as unknown as typeof WebSocket },
    });

    const ts = Date.now();
    const email = `edge-smoke-${ts}@homegohan.test`;
    const password = `SmokePass${ts}!`;

    // auth ユーザー作成
    const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (authError || !authData.user) {
      throw new Error(`Failed to create test user: ${authError?.message}`);
    }
    testUserId = authData.user.id;

    // user_profiles 作成 (NOT NULL: nickname, age_group, gender)
    const { error: profileError } = await adminClient.from('user_profiles').upsert(
      {
        id: testUserId,
        nickname: `SmokeUser${ts}`,
        age_group: '30s',
        gender: 'other',
        roles: [],
      },
      { onConflict: 'id' },
    );
    if (profileError) {
      await adminClient.auth.admin.deleteUser(testUserId);
      throw new Error(`Failed to create user profile: ${profileError.message}`);
    }

    // アクセストークン取得
    const { data: signInData, error: signInError } = await adminClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signInData.session) {
      await adminClient.auth.admin.deleteUser(testUserId);
      throw new Error(`Failed to sign in test user: ${signInError?.message}`);
    }
    testUserAccessToken = signInData.session.access_token;
  });

  afterAll(async () => {
    if (!testUserId) return;
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: ws as unknown as typeof WebSocket },
    });
    await adminClient.auth.admin.deleteUser(testUserId);
  });

  // ---------------------------------------------------------------------------
  // ヘルパー
  // ---------------------------------------------------------------------------
  function invoke(
    functionName: string,
    options: {
      method?: string;
      body?: unknown;
      authToken?: string | null;
    } = {},
  ): Promise<Response> {
    const { method = 'POST', body, authToken } = options;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken !== null && authToken !== undefined) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    return fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // 1. generate-hint
  // ---------------------------------------------------------------------------
  describe('generate-hint', () => {
    it('未認証 → 401', async () => {
      const res = await invoke('generate-hint', { body: {} });
      expect([401, 403]).toContain(res.status);
    });

    it('不正トークン → 401', async () => {
      const res = await invoke('generate-hint', {
        body: {},
        authToken: 'invalid.jwt.token',
      });
      expect([401, 403]).toContain(res.status);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. analyze-fridge
  // ---------------------------------------------------------------------------
  describe('analyze-fridge', () => {
    it('未認証 → 401', async () => {
      const res = await invoke('analyze-fridge', { body: {} });
      expect([401, 403]).toContain(res.status);
    });

    it('認証あり + imageUrl 欠落 → 400', async () => {
      const res = await invoke('analyze-fridge', {
        body: {},
        authToken: testUserAccessToken,
      });
      // imageUrl 必須のため 400 が返る
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. generate-health-insights
  // ---------------------------------------------------------------------------
  describe('generate-health-insights', () => {
    it('未認証 → 401', async () => {
      const res = await invoke('generate-health-insights', { body: {} });
      expect([401, 403]).toContain(res.status);
    });

    it('不正トークン → 401', async () => {
      const res = await invoke('generate-health-insights', {
        body: {},
        authToken: 'bad_token_here',
      });
      expect([401, 403]).toContain(res.status);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. analyze-meal-photo
  // ---------------------------------------------------------------------------
  describe('analyze-meal-photo', () => {
    it('未認証 → 401', async () => {
      const res = await invoke('analyze-meal-photo', { body: {} });
      expect([401, 403]).toContain(res.status);
    });

    it('不正トークン → 401', async () => {
      const res = await invoke('analyze-meal-photo', {
        body: {},
        authToken: 'invalid.token.value',
      });
      expect([401, 403]).toContain(res.status);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. knowledge-gpt
  // ---------------------------------------------------------------------------
  describe('knowledge-gpt', () => {
    it('未認証 → 401', async () => {
      const res = await invoke('knowledge-gpt', { body: { messages: [] } });
      expect([401, 403]).toContain(res.status);
    });

    it('GET メソッド → 405', async () => {
      const res = await invoke('knowledge-gpt', {
        method: 'GET',
        authToken: testUserAccessToken,
      });
      expect(res.status).toBe(405);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. normalize-shopping-list
  //    config.toml に verify_jwt 設定なし = デフォルト true (JWT ゲートウェイ認証)
  //    → 未認証リクエストはゲートウェイが 401 を返す
  // ---------------------------------------------------------------------------
  describe('normalize-shopping-list', () => {
    it('未認証 → 401 (gateway JWT guard)', async () => {
      const res = await invoke('normalize-shopping-list', { body: {} });
      expect([401, 403]).toContain(res.status);
    });

    it('認証あり + ingredients なし → 400', async () => {
      const res = await invoke('normalize-shopping-list', {
        body: {},
        authToken: testUserAccessToken,
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toHaveProperty('error');
    });

    it('認証あり + ingredients 空配列 → 200 (空リスト返却)', async () => {
      const res = await invoke('normalize-shopping-list', {
        body: { ingredients: [] },
        authToken: testUserAccessToken,
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty('items');
      expect(json.items).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. regenerate-shopping-list-v2
  //    config.toml に verify_jwt 設定なし = デフォルト true (JWT ゲートウェイ認証)
  //    → 未認証リクエストはゲートウェイが 401 を返す
  // ---------------------------------------------------------------------------
  describe('regenerate-shopping-list-v2', () => {
    it('未認証 → 401 (gateway JWT guard)', async () => {
      const res = await invoke('regenerate-shopping-list-v2', { body: {} });
      expect([401, 403]).toContain(res.status);
    });

    it('認証あり + 必須フィールド欠落 (空 body) → 400', async () => {
      const res = await invoke('regenerate-shopping-list-v2', {
        body: {},
        authToken: testUserAccessToken,
      });
      // requestId / userId / startDate / endDate が必須
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toHaveProperty('error');
    });

    it('認証あり + requestId だけ渡す → 400 (残り必須フィールド欠落)', async () => {
      const res = await invoke('regenerate-shopping-list-v2', {
        body: { requestId: 'test-only-no-side-effect' },
        authToken: testUserAccessToken,
      });
      expect(res.status).toBe(400);
    });
  });
}
