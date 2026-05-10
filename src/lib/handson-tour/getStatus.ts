import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

export const HandsonTourStatusResponseSchema = z.object({
  should_show: z.boolean(),
  completed_at: z.string().datetime().nullable(),
  skipped_at: z.string().datetime().nullable(),
  reason: z.enum([
    'eligible',
    'onboarding_not_completed',
    'already_completed',
    'already_skipped',
    'admin_role',
    'existing_user_auto_skip',
    'feature_disabled',
    'not_in_rollout',
  ]),
});

export type HandsonTourStatusResponse = z.infer<typeof HandsonTourStatusResponseSchema>;

const ADMIN_ROLES = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'] as const;

export async function getHandsonTourStatusInternal(userId: string): Promise<HandsonTourStatusResponse> {
  const supabase = await createClient();

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('onboarding_completed_at, handson_tour_completed_at, handson_tour_skipped_at, roles')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    throw Object.assign(new Error('profile_not_found'), { code: 'profile_not_found' });
  }

  const hasAdminRole = Array.isArray(profile.roles) &&
    profile.roles.some((r: string) => (ADMIN_ROLES as readonly string[]).includes(r));

  if (hasAdminRole) {
    return {
      should_show: false,
      completed_at: profile.handson_tour_completed_at ?? null,
      skipped_at: profile.handson_tour_skipped_at ?? null,
      reason: 'admin_role',
    };
  }

  if (!profile.onboarding_completed_at) {
    return {
      should_show: false,
      completed_at: null,
      skipped_at: null,
      reason: 'onboarding_not_completed',
    };
  }

  if (profile.handson_tour_completed_at) {
    return {
      should_show: false,
      completed_at: profile.handson_tour_completed_at,
      skipped_at: profile.handson_tour_skipped_at ?? null,
      reason: 'already_completed',
    };
  }

  if (profile.handson_tour_skipped_at) {
    return {
      should_show: false,
      completed_at: null,
      skipped_at: profile.handson_tour_skipped_at,
      reason: 'already_skipped',
    };
  }

  const { data: hasActivity } = await supabase
    .rpc('user_has_non_sandbox_activity');

  if (hasActivity) {
    const skippedAt = new Date().toISOString();
    await supabase
      .from('user_profiles')
      .update({ handson_tour_skipped_at: skippedAt })
      .eq('id', userId)
      .is('handson_tour_skipped_at', null);

    return {
      should_show: false,
      completed_at: null,
      skipped_at: skippedAt,
      reason: 'existing_user_auto_skip',
    };
  }

  return {
    should_show: true,
    completed_at: null,
    skipped_at: null,
    reason: 'eligible',
  };
}
