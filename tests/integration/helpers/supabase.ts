/**
 * Integration test helpers for Supabase operations.
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Safety: Only deletes test users created today (created_at >= today).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
