import type { SupabaseClient } from '@supabase/supabase-js';

export const FEATURE_FLAG_KEY = 'feature_flags';

export const DEFAULT_FEATURE_FLAGS = {
  ai_chat_enabled: true,
  meal_photo_analysis: true,
  recipe_generation: true,
  weekly_menu_generation: true,
  health_insights: true,
  comparison_feature: true,
  organization_features: true,
  maintenance_mode: false,
  menu_generation_v5_wrapped: true,
  menu_generation_v5_direct: true,
};

export type FeatureFlags = typeof DEFAULT_FEATURE_FLAGS;

export async function loadFeatureFlags(
  supabase: Pick<SupabaseClient, 'from'>,
): Promise<FeatureFlags> {
  const { data: setting } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', FEATURE_FLAG_KEY)
    .single();

  return { ...DEFAULT_FEATURE_FLAGS, ...(setting?.value ?? {}) };
}
