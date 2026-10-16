/**
 * Test user creation and cleanup helpers
 * Creates real Supabase auth users with operator roles for integration testing
 */
import { signInForIntegration } from './mfa';
import { retryIdempotentSetup } from './setup-transient-retry';
import { supabaseAdmin } from './supabase';

export interface TestUser {
  userId: string;
  email: string;
  jwt: string;
  roles: string[];
}

/**
 * Create a test user in Supabase auth with specified roles assigned in user_profiles.
 * Email uses pattern e2e-operator-{role}-{timestamp}@homegohan.test
 */
export async function createTestUserWithRoles(params: {
  email: string;
  roles: string[];
  password?: string;
}): Promise<TestUser> {
  const password = params.password ?? 'TestPass!2026';

  // Create auth user via admin API
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: params.email,
    password,
    email_confirm: true,
  });

  if (authError || !authData.user) {
    throw new Error(`Failed to create test user ${params.email}: ${authError?.message}`);
  }

  const userId = authData.user.id;

  // Upsert user_profiles with roles
  // user_profiles の必須列は nickname / age_group / gender (display_name 列は存在しない)
  // 既知の行 (id) の upsert なので、ゲートウェイの一時的な失敗のときだけやり直す (#1779。helpers/setup-transient-retry.ts)
  const { error: profileError } = await retryIdempotentSetup(supabaseAdmin, 'createTestUserWithRoles: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: userId,
        nickname: `Test ${params.roles.join('+')}`,
        age_group: '30s',
        gender: 'other',
        roles: params.roles,
      },
      { onConflict: 'id' },
    ),
  );

  if (profileError) {
    // Cleanup auth user on failure
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to upsert profile for ${params.email}: ${profileError.message}`);
  }

  // Sign in to get JWT。必須ロール (運営の MFA の対象) なら TOTP を登録・確認して aal2 の JWT にする
  // (段 B から運営の入口は aal2 だけを通す。docs/design/cross/12-operator-mfa.md §22.4.1)
  const jwt = await signInForIntegration({ email: params.email, password, roles: params.roles });

  return {
    userId,
    email: params.email,
    jwt,
    roles: params.roles,
  };
}

/**
 * Delete a test user from auth and profiles (cleanup)
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  // Delete profile first (FK constraint)
  await supabaseAdmin.from('user_profiles').delete().eq('id', userId);
  // Delete auth user
  await supabaseAdmin.auth.admin.deleteUser(userId);
}

/**
 * Clean up audit logs created by a specific actor (for test isolation)
 */
export async function cleanupAuditLogs(actorId: string): Promise<void> {
  await supabaseAdmin.from('admin_audit_logs').delete().eq('actor_id', actorId);
}

/**
 * Get test user email with unique timestamp suffix
 */
export function testEmail(role: string, ts: number): string {
  return `e2e-operator-${role}-${ts}@homegohan.test`;
}
