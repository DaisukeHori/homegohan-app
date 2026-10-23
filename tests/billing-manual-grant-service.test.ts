/**
 * 手動のプラン付与 (billing/02 §8.3) の service のテスト (#1797 段 B)。repository は偽物に差し替える。
 * 設計書 §13.1 のテスト 9〜14・55。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ManualGrantError, type ManualPlanGrantResult, type ManualPlanRevokeResult, type ManualPlanView } from '@/lib/billing/manual-grant';
import { ManualGrantRpcError, createManualGrantRepository, type ManualGrantRepository } from '@/lib/billing/manual-grant-repository';
import { expiresAtOf, getManualPlanView, grantManualPlan, revokeManualPlan } from '@/lib/billing/manual-grant-service';
import { countPlanSubscribers, totalPlanSubscribers, type SubscriberCountClient } from '@/lib/super-admin/plan-subscribers';
import { createFakePlanSubscribersDb } from './helpers/fake-plan-subscribers-db';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const SUBSCRIPTION_ID = '33333333-3333-4333-8333-333333333333';

const GRANT_RESULT: ManualPlanGrantResult = {
  subscription_id: SUBSCRIPTION_ID,
  user_id: TARGET_ID,
  plan_key: 'pro',
  status: 'active',
  expires_at: null,
};
const REVOKE_RESULT: ManualPlanRevokeResult = {
  subscription_id: SUBSCRIPTION_ID,
  user_id: TARGET_ID,
  plan_key: 'pro',
  status_from: 'active',
  status_to: 'cancelled',
};

function fakeRepository(overrides: Partial<ManualGrantRepository> = {}) {
  const repository = {
    userExists: vi.fn(async () => true),
    listGrantablePlans: vi.fn(async () => []),
    findLiveSubscription: vi.fn(async () => null),
    listHistory: vi.fn(async () => []),
    grant: vi.fn(async () => GRANT_RESULT),
    revoke: vi.fn(async () => REVOKE_RESULT),
    ...overrides,
  } satisfies ManualGrantRepository;
  return repository;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ManualGrantError) return error.code;
    throw error;
  }
  throw new Error('ManualGrantError が投げられなかった');
}

describe('expiresAtOf', () => {
  it('expiresAtOf returns the next day JST 00:00 (2026-12-31 → 2026-12-31T15:00:00.000Z)', () => {
    expect(expiresAtOf('2026-12-31')).toBe('2026-12-31T15:00:00.000Z');
    // 月またぎ・うるう日
    expect(expiresAtOf('2026-10-31')).toBe('2026-10-31T15:00:00.000Z');
    expect(expiresAtOf('2028-02-29')).toBe('2028-02-29T15:00:00.000Z');
  });
});

describe('grantManualPlan', () => {
  it('grantManualPlan: OP_SELF_MODIFY when actor equals target (before touching the repository), NOT_FOUND when the user does not exist, passes expiresAt null for no expiry and the converted timestamp otherwise', async () => {
    // 自分自身: repository に触れる前に断る (二重の守り)
    const selfRepository = fakeRepository();
    expect(await codeOf(grantManualPlan({ repository: selfRepository }, { userId: ACTOR_ID, actorId: ACTOR_ID, planKey: 'pro', expiresOn: null }))).toBe('OP_SELF_MODIFY');
    expect(selfRepository.userExists).not.toHaveBeenCalled();
    expect(selfRepository.grant).not.toHaveBeenCalled();

    // 利用者がいない: grant まで進まない
    const missingRepository = fakeRepository({ userExists: vi.fn(async () => false) });
    expect(await codeOf(grantManualPlan({ repository: missingRepository }, { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'pro', expiresOn: null }))).toBe('NOT_FOUND');
    expect(missingRepository.userExists).toHaveBeenCalledWith(TARGET_ID);
    expect(missingRepository.grant).not.toHaveBeenCalled();

    // 期限なし: expiresAt は null
    const noExpiryRepository = fakeRepository();
    await expect(grantManualPlan({ repository: noExpiryRepository }, { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'pro', expiresOn: null })).resolves.toEqual(GRANT_RESULT);
    expect(noExpiryRepository.grant).toHaveBeenCalledTimes(1);
    expect(noExpiryRepository.grant).toHaveBeenCalledWith({ userId: TARGET_ID, planKey: 'pro', expiresAt: null });

    // 期限あり: 翌日の JST 0 時
    const expiryRepository = fakeRepository();
    await grantManualPlan({ repository: expiryRepository }, { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'family_pro', expiresOn: '2026-12-31' });
    expect(expiryRepository.grant).toHaveBeenCalledWith({ userId: TARGET_ID, planKey: 'family_pro', expiresAt: '2026-12-31T15:00:00.000Z' });
  });

  it('grantManualPlan maps ManualGrantRpcError codes to ManualGrantError (BILL_LIVE_ROW_CONFLICT → OP_SUBSCRIPTION_ALREADY_ACTIVE, BILL_PLAN_NOT_GRANTABLE → OP_PLAN_NOT_GRANTABLE, BILL_MANUAL_EXPIRES_AT_PAST → OP_INVALID_INPUT, BILL_UNKNOWN_USER → NOT_FOUND) and rethrows other errors', async () => {
    const cases = [
      ['BILL_LIVE_ROW_CONFLICT', 'OP_SUBSCRIPTION_ALREADY_ACTIVE'],
      ['BILL_PLAN_NOT_GRANTABLE', 'OP_PLAN_NOT_GRANTABLE'],
      ['BILL_MANUAL_EXPIRES_AT_PAST', 'OP_INVALID_INPUT'],
      ['BILL_UNKNOWN_USER', 'NOT_FOUND'],
    ] as const;
    for (const [rpcCode, apiCode] of cases) {
      const repository = fakeRepository({
        grant: vi.fn(async () => {
          throw new ManualGrantRpcError(rpcCode, 'detail');
        }),
      });
      expect(await codeOf(grantManualPlan({ repository }, { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'pro', expiresOn: null })), rpcCode).toBe(apiCode);
    }
    // 業務エラーでない例外はそのまま投げ直す (route が 500 にする)
    const boom = new Error('connection reset');
    const failing = fakeRepository({
      grant: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(grantManualPlan({ repository: failing }, { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'pro', expiresOn: null })).rejects.toBe(boom);
    // userExists の失敗も投げ直す (NOT_FOUND に化けさせない)
    const lookupFailing = fakeRepository({
      userExists: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(grantManualPlan({ repository: lookupFailing }, { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'pro', expiresOn: null })).rejects.toBe(boom);
  });
});

describe('revokeManualPlan', () => {
  it('revokeManualPlan: OP_SELF_MODIFY when actor equals target (before touching the repository) / NOT_FOUND / BILL_MANUAL_ROW_NOT_FOUND → OP_NO_MANUAL_SUBSCRIPTION', async () => {
    const selfRepository = fakeRepository();
    expect(await codeOf(revokeManualPlan({ repository: selfRepository }, { userId: ACTOR_ID, actorId: ACTOR_ID }))).toBe('OP_SELF_MODIFY');
    expect(selfRepository.userExists).not.toHaveBeenCalled();
    expect(selfRepository.revoke).not.toHaveBeenCalled();

    const missingRepository = fakeRepository({ userExists: vi.fn(async () => false) });
    expect(await codeOf(revokeManualPlan({ repository: missingRepository }, { userId: TARGET_ID, actorId: ACTOR_ID }))).toBe('NOT_FOUND');
    expect(missingRepository.revoke).not.toHaveBeenCalled();

    const noManualRepository = fakeRepository({
      revoke: vi.fn(async () => {
        throw new ManualGrantRpcError('BILL_MANUAL_ROW_NOT_FOUND', TARGET_ID);
      }),
    });
    expect(await codeOf(revokeManualPlan({ repository: noManualRepository }, { userId: TARGET_ID, actorId: ACTOR_ID }))).toBe('OP_NO_MANUAL_SUBSCRIPTION');

    const okRepository = fakeRepository();
    await expect(revokeManualPlan({ repository: okRepository }, { userId: TARGET_ID, actorId: ACTOR_ID })).resolves.toEqual(REVOKE_RESULT);
    expect(okRepository.revoke).toHaveBeenCalledWith(TARGET_ID);

    // 業務エラーでない例外は投げ直す
    const boom = new Error('connection reset');
    const failing = fakeRepository({
      revoke: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(revokeManualPlan({ repository: failing }, { userId: TARGET_ID, actorId: ACTOR_ID })).rejects.toBe(boom);
  });
});

describe('getManualPlanView', () => {
  it('getManualPlanView returns current, plans and history from the repository and NOT_FOUND for an unknown user', async () => {
    const view: ManualPlanView = {
      current: {
        subscription_id: SUBSCRIPTION_ID,
        plan_key: 'pro',
        status: 'active',
        source: 'manual',
        starts_at: '2026-10-17T00:00:00.000Z',
        expires_at: null,
      },
      plans: [{ plan_key: 'pro', display_name: 'プロ', plan_type: 'personal', max_members: null }],
      history: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          action_type: 'admin.billing.manual_grant',
          actor_id: ACTOR_ID,
          created_at: '2026-10-17T00:00:00.000Z',
          plan_key: 'pro',
          expires_at: null,
          reason: '検証用の付与',
        },
      ],
    };
    const repository = fakeRepository({
      findLiveSubscription: vi.fn(async () => view.current),
      listGrantablePlans: vi.fn(async () => view.plans),
      listHistory: vi.fn(async () => view.history),
    });
    await expect(getManualPlanView({ repository }, TARGET_ID)).resolves.toEqual(view);
    expect(repository.findLiveSubscription).toHaveBeenCalledWith(TARGET_ID);
    expect(repository.listHistory).toHaveBeenCalledWith(TARGET_ID);

    // 利用者が無ければ 3 本の読み取りに進まない
    const missingRepository = fakeRepository({ userExists: vi.fn(async () => false) });
    expect(await codeOf(getManualPlanView({ repository: missingRepository }, TARGET_ID))).toBe('NOT_FOUND');
    expect(missingRepository.findLiveSubscription).not.toHaveBeenCalled();
    expect(missingRepository.listGrantablePlans).not.toHaveBeenCalled();
    expect(missingRepository.listHistory).not.toHaveBeenCalled();
  });
});

describe('manual-grant-repository.ts のソース走査', () => {
  it('manual-grant-repository.ts has no direct insert/update/upsert on personal_subscriptions (writes go through the 2 RPCs)', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/billing/manual-grant-repository.ts'), 'utf8');
    // 書き込みの呼び口が一つも無い (personal_subscriptions を読む SELECT だけ)
    expect(source).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    // 書く入口は 2 本の RPC だけ
    const rpcNames = [...source.matchAll(/\.rpc\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect([...rpcNames].sort()).toEqual(['billing_grant_manual_subscription', 'billing_revoke_manual_subscription']);
    // personal_subscriptions を読む箇所は存在する (走査が空振りしていないことの番兵)
    expect(source).toContain(".from('personal_subscriptions')");
  });
});

describe('countPlanSubscribers: 手動付与の行 (S19)', () => {
  /** 数える対象のプラン (個人の pro。組織の件数も数えるプラン) */
  const PRO_PLAN = { plan_key: 'pro', plan_type: 'personal' } as const;

  it('countPlanSubscribers counts a live manual row (stripe_subscription_id null) of the plan, so deprecating that plan is refused (S19)', async () => {
    // 偽の client は知らない絞り込みのメソッドで例外を投げるので、stripe_subscription_id で絞る変更が入れば赤になる
    const { client } = createFakePlanSubscribersDb({
      tables: {
        personal_subscriptions: [{ plan_key: 'pro', status: 'active', stripe_subscription_id: null, iap_store: null }],
      },
    });
    const counts = await countPlanSubscribers(client as unknown as SubscriberCountClient, PRO_PLAN);
    expect(counts.personal_subscriptions).toBe(1);
    expect(totalPlanSubscribers(counts)).toBeGreaterThanOrEqual(1);

    // 取り消し済みの手動付与の行は数えない (廃止を止め続けない)
    const { client: cancelledClient } = createFakePlanSubscribersDb({
      tables: {
        personal_subscriptions: [{ plan_key: 'pro', status: 'cancelled', stripe_subscription_id: null, iap_store: null }],
      },
    });
    const cancelledCounts = await countPlanSubscribers(cancelledClient as unknown as SubscriberCountClient, PRO_PLAN);
    expect(cancelledCounts.personal_subscriptions).toBe(0);

    // billing/03 §7.1: ストアの契約 (I 行) も live なら同じく数える (出どころを見ない)
    const { client: storeClient } = createFakePlanSubscribersDb({
      tables: {
        personal_subscriptions: [{ plan_key: 'pro', status: 'trialing', stripe_subscription_id: null, iap_store: 'app_store' }],
      },
    });
    expect((await countPlanSubscribers(storeClient as unknown as SubscriberCountClient, PRO_PLAN)).personal_subscriptions).toBe(1);
  });
});

describe('billing/03 §8.6: 手動付与の画面が読む live な契約の出どころ (findLiveSubscription)', () => {
  it('findLiveSubscription reads iap_store and reports source stripe / manual / store for S / M / I rows', async () => {
    const base = { id: '44444444-4444-4444-8444-444444444444', plan_key: 'pro', status: 'active', starts_at: '2026-10-01T00:00:00.000Z', current_period_end: null };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, stripe_subscription_id: 'sub_1', iap_store: null }, 'stripe'],
      [{ ...base, stripe_subscription_id: null, iap_store: null }, 'manual'],
      [{ ...base, stripe_subscription_id: null, iap_store: 'app_store' }, 'store'],
      [{ ...base, stripe_subscription_id: null, iap_store: 'play_store' }, 'store'],
    ];
    for (const [row, source] of cases) {
      const selects: string[] = [];
      const chain = {
        select: (columns: string) => {
          selects.push(columns);
          return chain;
        },
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
      };
      const admin = { from: () => chain };
      const repository = createManualGrantRepository(admin as unknown as Parameters<typeof createManualGrantRepository>[0]);
      expect(await repository.findLiveSubscription(TARGET_ID), source).toMatchObject({ subscription_id: base.id, source });
      expect(selects[0]).toContain('iap_store');
    }
  });
});
