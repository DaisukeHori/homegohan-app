// @vitest-environment node
/**
 * #1148 AI 相談のアクション実行 (consultation-action-executor.ts) の献立生成が、
 * エンジン (v4 / v5) を feature_flags の menu_generation_v5_wrapped (isFeatureEnabled) で決めること。
 *
 * 以前は system_settings をログイン中のユーザー自身の権限で読んでいたため、admin / super_admin 以外は
 * 値が読めず、いつも v5 だった。今は feature_flags をサーバー側で読むので、全ユーザーに効く。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
  invokeWithRetry: vi.fn(),
}));

vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string) => h.isFeatureEnabled(key, userId),
}));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  invokeGenerateMenuV4WithRetry: (...args: unknown[]) => h.invokeWithRetry(...args),
  markWeeklyMenuRequestFailed: vi.fn(async () => undefined),
}));
vi.mock('@/lib/v4-target-slots', () => ({
  resolveExistingTargetSlots: vi.fn(async ({ targetSlots }: { targetSlots: unknown[] }) => targetSlots),
}));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), withUser: vi.fn() }) }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

import { runConsultationAction, type ConsultationActionRow } from '@/lib/ai/consultation-action-executor';

const USER = { id: 'user-1' };

function makeSupabase() {
  const inserts: Array<Record<string, unknown>> = [];
  const invoke = vi.fn(async (_name: string, _options: unknown) => ({ data: null, error: null }));

  const supabase = {
    from: (table: string) => {
      const chain: any = new Proxy(() => undefined, {
        get(_target, prop) {
          if (prop === 'then') {
            const result =
              table === 'weekly_menu_requests'
                ? { data: { id: 'request-1' }, error: null }
                : { data: { family_size: 1 }, error: null };
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve(result).then(resolve, reject);
          }
          if (prop === 'insert') {
            return (payload: Record<string, unknown>) => {
              if (table === 'weekly_menu_requests') inserts.push(payload);
              return chain;
            };
          }
          return () => chain;
        },
        apply: () => chain,
      });
      return chain;
    },
    functions: { invoke },
  };
  return { supabase, inserts, invoke };
}

function generateDayMenuAction(): ConsultationActionRow {
  return {
    id: 'action-1',
    action_type: 'generate_day_menu',
    action_params: { date: '2026-10-09' },
    ai_consultation_sessions: { user_id: USER.id },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // invokeGenerateMenuV4WithRetry は、渡された invoke を 1 回呼んで成功を返す
  h.invokeWithRetry.mockImplementation(async ({ invoke }: { invoke: () => Promise<unknown> }) => {
    await invoke();
    return { ok: true, attempts: 1, data: null };
  });
});

describe('runConsultationAction: generate_day_menu のエンジン切り替え (#1148)', () => {
  it('menu_generation_v5_wrapped が ON なら generate-menu-v5 を呼び、リクエスト行の mode は v5', async () => {
    h.isFeatureEnabled.mockImplementation(async (key: string) => key === 'menu_generation_v5_wrapped');
    const { supabase, inserts, invoke } = makeSupabase();

    const outcome = await runConsultationAction(supabase, USER, generateDayMenuAction());

    expect(outcome.success).toBe(true);
    expect(h.isFeatureEnabled).toHaveBeenCalledWith('menu_generation_v5_wrapped', USER.id);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('generate-menu-v5');
    expect(inserts[0].mode).toBe('v5');
  });

  it('OFF なら generate-menu-v4 を呼び、リクエスト行の mode は v4', async () => {
    h.isFeatureEnabled.mockResolvedValue(false);
    const { supabase, inserts, invoke } = makeSupabase();

    const outcome = await runConsultationAction(supabase, USER, generateDayMenuAction());

    expect(outcome.success).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('generate-menu-v4');
    expect(inserts[0].mode).toBe('v4');
  });

  it('menu_generation_v5_direct (汎用の API 用) だけが ON でも、AI 相談は v4 のまま', async () => {
    h.isFeatureEnabled.mockImplementation(async (key: string) => key === 'menu_generation_v5_direct');
    const { supabase, invoke } = makeSupabase();

    await runConsultationAction(supabase, USER, generateDayMenuAction());

    expect(invoke.mock.calls[0][0]).toBe('generate-menu-v4');
  });

  it('system_settings (旧の置き場) は読まない', async () => {
    h.isFeatureEnabled.mockResolvedValue(true);
    const tablesRead: string[] = [];
    const { supabase } = makeSupabase();
    const original = supabase.from;
    supabase.from = (table: string) => {
      tablesRead.push(table);
      return original(table);
    };

    await runConsultationAction(supabase, USER, generateDayMenuAction());

    expect(tablesRead).not.toContain('system_settings');
    expect(tablesRead).not.toContain('feature_flags');
  });
});
