/**
 * src/__tests__/lib/super-admin/evaluate-flag.test.ts
 *
 * #1029: feature flags API が no-op でフラグ機構全体が無効化されていた問題の修正。
 * evaluateFlag (DB I/O を含まない純粋関数) が percentage/plan/role/org ロールアウト
 * および constraints を実際に判定することを検証する。
 */
import { describe, it, expect } from 'vitest';
import { evaluateFlag, type FeatureFlagRecord, type UserFlagContext } from '@/lib/super-admin/evaluate-flag';

function makeFlag(overrides: Partial<FeatureFlagRecord> = {}): FeatureFlagRecord {
  return {
    key: 'test_flag',
    enabled: true,
    rollout_strategy: null,
    constraints: null,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<UserFlagContext> = {}): UserFlagContext {
  return {
    userId: 'user-1',
    planKey: 'free',
    roles: ['user'],
    organizationId: null,
    accountCreatedAt: null,
    ...overrides,
  };
}

describe('evaluateFlag — 基本', () => {
  it('flag が存在しない (null) 場合は無効 (fail-closed)', () => {
    expect(evaluateFlag(null, makeCtx())).toBe(false);
  });

  it('enabled=false は rollout_strategy に関わらず常に無効', () => {
    const flag = makeFlag({ enabled: false, rollout_strategy: { type: 'all' } });
    expect(evaluateFlag(flag, makeCtx())).toBe(false);
  });

  it('enabled=true かつ rollout_strategy=null は全ユーザーで有効', () => {
    const flag = makeFlag({ enabled: true, rollout_strategy: null });
    expect(evaluateFlag(flag, makeCtx())).toBe(true);
  });

  it("rollout_strategy.type='all' は全ユーザーで有効", () => {
    const flag = makeFlag({ rollout_strategy: { type: 'all' } });
    expect(evaluateFlag(flag, makeCtx())).toBe(true);
  });
});

describe('evaluateFlag — percentage ロールアウト', () => {
  it('value=0 は常に無効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'percentage', value: 0 } });
    for (let i = 0; i < 50; i++) {
      expect(evaluateFlag(flag, makeCtx({ userId: `user-${i}` }))).toBe(false);
    }
  });

  it('value=100 は常に有効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'percentage', value: 100 } });
    for (let i = 0; i < 50; i++) {
      expect(evaluateFlag(flag, makeCtx({ userId: `user-${i}` }))).toBe(true);
    }
  });

  it('同一ユーザー・同一フラグへの判定は決定的 (何度呼んでも同じ結果)', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'percentage', value: 42 } });
    const ctx = makeCtx({ userId: 'stable-user' });
    const first = evaluateFlag(flag, ctx);
    for (let i = 0; i < 10; i++) {
      expect(evaluateFlag(flag, ctx)).toBe(first);
    }
  });

  it('value を増やすと有効判定はモノトニックに増える (percentage を上げても既存の有効ユーザーは無効化されない)', () => {
    const userIds = Array.from({ length: 200 }, (_, i) => `user-${i}`);
    const enabledAt = (value: number) => {
      const flag = makeFlag({ rollout_strategy: { type: 'percentage', value } });
      return new Set(userIds.filter((id) => evaluateFlag(flag, makeCtx({ userId: id }))));
    };

    const at10 = enabledAt(10);
    const at50 = enabledAt(50);
    const at90 = enabledAt(90);

    for (const id of at10) expect(at50.has(id)).toBe(true);
    for (const id of at50) expect(at90.has(id)).toBe(true);
  });

  it('十分なユーザー数では実測有効率が指定 % に近い値になる (統計的検証)', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'percentage', value: 25 } });
    const userIds = Array.from({ length: 2000 }, (_, i) => `stat-user-${i}`);
    const enabledCount = userIds.filter((id) => evaluateFlag(flag, makeCtx({ userId: id }))).length;
    const ratio = enabledCount / userIds.length;
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.3);
  });
});

describe('evaluateFlag — plan ロールアウト', () => {
  it('ユーザーの planKey が rollout.plans に含まれれば有効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'plan', plans: ['pro', 'family_pro'] } });
    expect(evaluateFlag(flag, makeCtx({ planKey: 'pro' }))).toBe(true);
  });

  it('ユーザーの planKey が rollout.plans に含まれなければ無効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'plan', plans: ['pro', 'family_pro'] } });
    expect(evaluateFlag(flag, makeCtx({ planKey: 'free' }))).toBe(false);
  });

  it('planKey が未設定 (null) の場合は無効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'plan', plans: ['pro'] } });
    expect(evaluateFlag(flag, makeCtx({ planKey: null }))).toBe(false);
  });
});

describe('evaluateFlag — role ロールアウト', () => {
  it('ユーザーの roles のいずれかが rollout.roles に含まれれば有効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'role', roles: ['admin', 'super_admin'] } });
    expect(evaluateFlag(flag, makeCtx({ roles: ['user', 'admin'] }))).toBe(true);
  });

  it('ユーザーの roles が rollout.roles と重複しなければ無効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'role', roles: ['admin', 'super_admin'] } });
    expect(evaluateFlag(flag, makeCtx({ roles: ['user'] }))).toBe(false);
  });

  it('roles が未設定 (undefined) の場合は無効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'role', roles: ['admin'] } });
    expect(evaluateFlag(flag, makeCtx({ roles: undefined }))).toBe(false);
  });
});

describe('evaluateFlag — org ロールアウト', () => {
  it('ユーザーの organizationId が rollout.org_ids に含まれれば有効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'org', org_ids: ['org-1', 'org-2'] } });
    expect(evaluateFlag(flag, makeCtx({ organizationId: 'org-1' }))).toBe(true);
  });

  it('organizationId が null の場合は無効', () => {
    const flag = makeFlag({ rollout_strategy: { type: 'org', org_ids: ['org-1'] } });
    expect(evaluateFlag(flag, makeCtx({ organizationId: null }))).toBe(false);
  });
});

describe('evaluateFlag — constraints', () => {
  it('min_user_age_days 未満のアカウントは無効', () => {
    const flag = makeFlag({ constraints: { min_user_age_days: 30 } });
    const recentAccount = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(evaluateFlag(flag, makeCtx({ accountCreatedAt: recentAccount }))).toBe(false);
  });

  it('min_user_age_days 以上のアカウントは有効', () => {
    const flag = makeFlag({ constraints: { min_user_age_days: 30 } });
    const oldAccount = new Date(Date.now() - 60 * 86_400_000).toISOString();
    expect(evaluateFlag(flag, makeCtx({ accountCreatedAt: oldAccount }))).toBe(true);
  });

  it('exclude_plans に含まれる plan は無効', () => {
    const flag = makeFlag({ constraints: { exclude_plans: ['free'] } });
    expect(evaluateFlag(flag, makeCtx({ planKey: 'free' }))).toBe(false);
  });

  it('include_plans が指定されている場合、含まれない plan は無効', () => {
    const flag = makeFlag({ constraints: { include_plans: ['pro'] } });
    expect(evaluateFlag(flag, makeCtx({ planKey: 'free' }))).toBe(false);
    expect(evaluateFlag(flag, makeCtx({ planKey: 'pro' }))).toBe(true);
  });

  it('include_roles が指定されている場合、含まれない role は無効', () => {
    const flag = makeFlag({ constraints: { include_roles: ['admin'] } });
    expect(evaluateFlag(flag, makeCtx({ roles: ['user'] }))).toBe(false);
    expect(evaluateFlag(flag, makeCtx({ roles: ['user', 'admin'] }))).toBe(true);
  });

  it('constraints と rollout_strategy の両方を満たす必要がある (AND 条件)', () => {
    const flag = makeFlag({
      constraints: { exclude_plans: ['free'] },
      rollout_strategy: { type: 'percentage', value: 100 },
    });
    // constraints で弾かれる
    expect(evaluateFlag(flag, makeCtx({ planKey: 'free' }))).toBe(false);
    // constraints は通るが rollout 100% なので有効
    expect(evaluateFlag(flag, makeCtx({ planKey: 'pro' }))).toBe(true);
  });
});
