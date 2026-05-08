// Analytics Zod schemas + ヘルパー
// Canonical: docs/design/family/09-onboarding-handson-tour/22-analytics.md §2

import { z } from 'zod';

// ============================================================
// §2.2 共通 properties
// ============================================================

const CommonPropertiesSchema = z.object({
  user_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  platform: z.enum(['web', 'ios', 'android']),
  app_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  session_id: z.string().uuid().optional(),
  trace_id: z.string().optional(),
});

export { CommonPropertiesSchema };

// ============================================================
// §2.3 各 event schema (11 イベント)
// ============================================================

export const HandsonTourEventSchemas = {
  // ====== trigger ======
  handson_tour_eligible: CommonPropertiesSchema.extend({
    entry_source: z.enum(['auto', 'settings_force']),
  }),

  // ====== progression ======
  handson_tour_started: CommonPropertiesSchema.extend({
    entry_source: z.enum(['auto', 'settings_force']),
  }),

  handson_tour_step_viewed: CommonPropertiesSchema.extend({
    step: z.number().int().min(0).max(5),
    sub_step: z.string().optional(),
  }),

  handson_tour_step_completed: CommonPropertiesSchema.extend({
    step: z.number().int().min(0).max(5),
    dwell_ms: z.number().int().nonnegative(),
  }),

  handson_tour_skipped: CommonPropertiesSchema.extend({
    step: z.number().int().min(-1).max(4),
    reason: z.enum([
      'user_action',
      'hard_back',
      'admin_role',
      'existing_user',
      'feature_disabled',
      'not_in_rollout',
    ]),
  }),

  // ====== completion ======
  handson_tour_completed: CommonPropertiesSchema.extend({
    total_duration_ms: z.number().int().nonnegative(),
    step_skipped_count: z.number().int().min(0).max(4),
    badge_awarded: z.literal('tutorial_complete'),
    already_completed: z.boolean(),
  }),

  // ====== error ======
  handson_tour_step_error: CommonPropertiesSchema.extend({
    step: z.number().int().min(0).max(5),
    sub_step: z.string().optional(),
    error_code: z.string(),
    error_message: z.string().max(500),
    http_status: z.number().int().optional(),
  }),

  // ====== re-engagement ======
  handson_tour_force_replayed: CommonPropertiesSchema.extend({
    previous_completed_at: z.string().datetime().nullable(),
  }),

  // ====== performance ======
  web_vitals_lcp: CommonPropertiesSchema.extend({
    value_ms: z.number(),
    page: z.string(),
  }),

  web_vitals_cls: CommonPropertiesSchema.extend({
    value: z.number(),
    page: z.string(),
  }),

  web_vitals_fid: CommonPropertiesSchema.extend({
    value_ms: z.number(),
    page: z.string(),
  }),
} as const;

// ============================================================
// 型エクスポート
// ============================================================

export type HandsonTourEventName = keyof typeof HandsonTourEventSchemas;

export type HandsonTourEventPayload<T extends HandsonTourEventName> = z.infer<
  (typeof HandsonTourEventSchemas)[T]
>;

// ============================================================
// Analytics injector interface
// PostHog SDK は Web/Mobile が個別に inject する。
// 共通 package はインターフェースのみ定義し、具体実装を持たない。
// ============================================================

export interface AnalyticsAdapter {
  capture(eventName: string, payload: Record<string, unknown>): void;
}

let _adapter: AnalyticsAdapter | null = null;

/**
 * analytics adapter を注入する。
 * Web: posthog-js、Mobile: posthog-react-native を注入する想定。
 */
export function setAnalyticsAdapter(adapter: AnalyticsAdapter): void {
  _adapter = adapter;
}

/**
 * analytics イベントを発火する。
 * dev モードでは Zod schema による検証を実施する。
 * adapter 未注入の場合は no-op。
 */
export function fireAnalytics<T extends HandsonTourEventName>(
  eventName: T,
  payload: HandsonTourEventPayload<T>,
): void {
  if (process.env['NODE_ENV'] === 'development') {
    HandsonTourEventSchemas[eventName].parse(payload);
  }

  if (_adapter) {
    _adapter.capture(eventName, payload as Record<string, unknown>);
  }
}
