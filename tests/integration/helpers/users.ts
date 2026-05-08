/**
 * Test user creation and cleanup helpers
 * Creates real Supabase auth users with operator roles for integration testing
 */
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
  const { error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .upsert(
      {
        id: userId,
        display_name: `Test ${params.roles.join('+')}`,
        roles: params.roles,
      },
      { onConflict: 'id' }
    );

  if (profileError) {
    // Cleanup auth user on failure
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to upsert profile for ${params.email}: ${profileError.message}`);
  }

  // Sign in to get JWT
  const { data: signInData, error: signInError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: params.email,
  });

  if (signInError || !signInData) {
    // Fall back to password sign-in via anon client
  }

  // Use sign in with password via admin to get access token
  const signInResult = await supabaseAdmin.auth.signInWithPassword({
    email: params.email,
    password,
  });

  if (signInResult.error || !signInResult.data.session) {
    throw new Error(`Failed to sign in test user ${params.email}: ${signInResult.error?.message}`);
  }

  return {
    userId,
    email: params.email,
    jwt: signInResult.data.session.access_token,
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
