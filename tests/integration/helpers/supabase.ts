/**
 * Integration test helpers for Supabase operations.
 *
 * Two API styles coexist (history: PR #839 + #840 が並列で同 helper を作成):
 *   - 関数形式 `adminClient()` (PR #839 由来、handson-tour テスト)
 *   - 定数形式 `supabaseAdmin` / `supabaseAnon` (PR #840 由来、operator テスト)
 * 両方を維持し、新規テストはどちらを使っても OK。
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   (optional) NEXT_PUBLIC_SUPABASE_ANON_KEY — supabaseAnon 用
 *
 * Safety: cleanupTestUser は created_at >= today のユーザーのみ削除する。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------
// 関数形式 (PR #839 由来) — 各呼び出し時に env を読む。lazy 評価。
// ---------------------------------------------------------------
export function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for integration tests',
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------
// 定数形式 (PR #840 由来) — モジュールロード時に env を読む。
// SUPABASE_INTEGRATION_TEST=1 でテスト実行する前提のため、
// env 不足は実行時 throw で OK。テスト未実行時は import 自体されない想定。
// ---------------------------------------------------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * Admin client (service_role) — RLS バイパス。テスト helper でのみ使用。
 * lazy: 初回参照時に env チェック (起動時 throw を避ける)。
 */
let _supabaseAdmin: SupabaseClient | null = null;
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop: string | symbol) {
    if (!_supabaseAdmin) {
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error(
          'Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local',
        );
      }
      _supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    return _supabaseAdmin[prop as keyof SupabaseClient];
  },
});

/**
 * Anon client — テストユーザーの sign-in 用 (RLS 適用)。
 */
let _supabaseAnon: SupabaseClient | null = null;
export const supabaseAnon = new Proxy({} as SupabaseClient, {
  get(_target, prop: string | symbol) {
    if (!_supabaseAnon) {
      if (!supabaseUrl) {
        throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL');
      }
      _supabaseAnon = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    return _supabaseAnon[prop as keyof SupabaseClient];
  },
});

// ---------------------------------------------------------------
// Test user lifecycle
// ---------------------------------------------------------------
export interface CreateTestUserOptions {
  email?: string;
  password?: string;
  roles?: string[];
  onboardingCompleted?: boolean;
  handsonTourCompletedAt?: string | null;
  handsonTourSkippedAt?: string | null;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
}

/**
 * Creates a fresh auth user + user_profiles row for testing.
 * The profile is inserted via adminClient so no RLS applies.
 */
export async function createTestUser(
  options: CreateTestUserOptions = {},
): Promise<TestUser> {
  const client = adminClient();

  const timestamp = Date.now();
  const email = options.email ?? `integration-test-${timestamp}@homegohan.local`;
  const password = options.password ?? `TestPass${timestamp}!`;

  // Create auth user
  const { data: authData, error: authError } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user: ${authError?.message}`);
  }

  const userId = authData.user.id;

  // Insert profile row (may already exist due to trigger, so upsert)
  const profileData: Record<string, unknown> = {
    id: userId,
    display_name: `Test User ${timestamp}`,
    onboarding_completed_at: options.onboardingCompleted
      ? new Date().toISOString()
      : null,
    handson_tour_completed_at: options.handsonTourCompletedAt ?? null,
    handson_tour_skipped_at: options.handsonTourSkippedAt ?? null,
    roles: options.roles ?? [],
  };

  const { error: profileError } = await client
    .from('user_profiles')
    .upsert(profileData, { onConflict: 'id' });

  if (profileError) {
    // Cleanup auth user before throwing
    await client.auth.admin.deleteUser(userId);
    throw new Error(`Failed to create user profile: ${profileError.message}`);
  }

  // Get access token via sign in
  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    await client.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in test user: ${signInError?.message}`);
  }

  return {
    id: userId,
    email,
    password,
    accessToken: signInData.session.access_token,
  };
}

/**
 * Cleans up a test user (auth + profile).
 * Safety guard: only deletes users created today.
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  const client = adminClient();

  // Safety: verify user was created today before deleting
  const { data: authUser } = await client.auth.admin.getUserById(userId);
  if (!authUser?.user) return;

  const createdAt = new Date(authUser.user.created_at);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  if (createdAt < todayStart) {
    console.warn(`cleanupTestUser: skipping user ${userId} created before today`);
    return;
  }

  // Delete sandbox meal rows
  await client.from('meals').delete().eq('user_id', userId).eq('is_sandbox', true);
  await client.from('user_daily_meals').delete().eq('user_id', userId).eq('is_sandbox', true);

  // Delete auth user (cascades to user_profiles via FK or trigger)
  const { error } = await client.auth.admin.deleteUser(userId);
  if (error) {
    console.error(`cleanupTestUser: failed to delete user ${userId}: ${error.message}`);
  }
}

/**
 * Returns true if integration tests should run.
 * Set SUPABASE_INTEGRATION_TEST=1 to enable.
 */
export function shouldRunIntegration(): boolean {
  return process.env.SUPABASE_INTEGRATION_TEST === '1';
}
