/**
 * #1127 プランの契約者数 (src/lib/super-admin/plan-subscribers.ts) のテスト
 *
 * 契約者がいるプランを廃止できなくするための数え方を確かめる。
 *   - 数えるのは「契約が終わっていないもの」だけ (終了済み・解散済み・別プランは数えない)
 *   - 数えられなかったときは 0 件にせず例外にする (確認できなかったことを契約者なしと取り違えない)
 *
 * 偽クライアント (tests/helpers/fake-plan-subscribers-db.ts) は eq / in の絞り込みを実際に行の上で適用するので、
 * 絞り込みの付け忘れ・列名の取り違えは、件数の食い違いとして現れる。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES,
  ORG_SUBSCRIPTION_PLAN_ROW_NOTE,
  PlanSubscriberCountError,
  countPlanSubscribers,
  countsOrganizationsFor,
  isOrganizationsCounted,
  planHasSubscribersMessage,
  totalPlanSubscribers,
  type SubscriberCountClient,
} from '@/lib/super-admin/plan-subscribers';
import { ORG_PLAN_VALUES } from '@/lib/org-plans';
import { createFakePlanSubscribersDb, queryOf, type FakePlanSubscribersDbOptions } from './helpers/fake-plan-subscribers-db';

const PLAN_KEY = 'pro';
/** 数える対象のプラン (個人の pro。組織の件数も数える) */
const PLAN = { plan_key: PLAN_KEY, plan_type: 'personal' } as const;

function clientOf(options: FakePlanSubscribersDbOptions = {}) {
  const db = createFakePlanSubscribersDb(options);
  return { ...db, admin: db.client as unknown as SubscriberCountClient };
}

describe('countPlanSubscribers: 数える対象 (#1127)', () => {
  it('契約者が 1 人もいなければ、3 種類とも 0 件', async () => {
    const { admin } = clientOf();
    await expect(countPlanSubscribers(admin, PLAN)).resolves.toEqual({
      personal_subscriptions: 0,
      family_groups: 0,
      organizations: 0,
    });
  });

  it('個人契約は、契約が終わっていない 5 つの status を数える', async () => {
    const { admin } = clientOf({
      tables: {
        personal_subscriptions: ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES.map((status) => ({ plan_key: PLAN_KEY, status })),
      },
    });
    const counts = await countPlanSubscribers(admin, PLAN);
    expect(counts.personal_subscriptions).toBe(5);
    expect([...ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES].sort()).toEqual(['active', 'grace', 'past_due', 'paused', 'trialing']);
  });

  it('個人契約: 終了済み (cancelled / expired) と、別プランの契約は数えない', async () => {
    const { admin } = clientOf({
      tables: {
        personal_subscriptions: [
          { plan_key: PLAN_KEY, status: 'cancelled' },
          { plan_key: PLAN_KEY, status: 'expired' },
          { plan_key: 'family_basic', status: 'active' },
          { plan_key: PLAN_KEY, status: 'active' },
        ],
      },
    });
    expect((await countPlanSubscribers(admin, PLAN)).personal_subscriptions).toBe(1);
  });

  it('家族グループ: active だけを数える。解散済み (dissolved) と別プランは数えない', async () => {
    const { admin } = clientOf({
      tables: {
        family_groups: [
          { plan_key: PLAN_KEY, status: 'active' },
          { plan_key: PLAN_KEY, status: 'active' },
          { plan_key: PLAN_KEY, status: 'dissolved' },
          { plan_key: 'family_basic', status: 'active' },
        ],
      },
    });
    expect((await countPlanSubscribers(admin, PLAN)).family_groups).toBe(2);
  });

  it('組織: plan 列が plan_key と一致する active だけを数える。解散済みと別プランは数えない', async () => {
    // organizations にあるのは plan_key ではなく plan 列。plan_key 列で絞る実装なら、この行は 1 件も一致しない
    const { admin } = clientOf({
      tables: {
        organizations: [
          { plan: PLAN_KEY, status: 'active' },
          { plan: PLAN_KEY, status: 'active' },
          { plan: PLAN_KEY, status: 'dissolved' },
          { plan: 'org_starter', status: 'active' },
        ],
      },
    });
    expect((await countPlanSubscribers(admin, PLAN)).organizations).toBe(2);
  });

  it('3 種類の契約者をテーブルごとに別々に数える', async () => {
    const { admin } = clientOf({
      tables: {
        personal_subscriptions: [
          { plan_key: PLAN_KEY, status: 'trialing' },
          { plan_key: PLAN_KEY, status: 'active' },
        ],
        family_groups: [{ plan_key: PLAN_KEY, status: 'active' }],
        organizations: [
          { plan: PLAN_KEY, status: 'active' },
          { plan: PLAN_KEY, status: 'active' },
          { plan: PLAN_KEY, status: 'active' },
        ],
      },
    });
    await expect(countPlanSubscribers(admin, PLAN)).resolves.toEqual({
      personal_subscriptions: 2,
      family_groups: 1,
      organizations: 3,
    });
  });

  it('件数だけを取る (head: true / count: exact)。行の中身は読まず、読むテーブルは 3 つだけ', async () => {
    const { admin, queries } = clientOf({
      tables: { personal_subscriptions: [{ plan_key: PLAN_KEY, status: 'active', user_id: 'u-1' }] },
    });
    await countPlanSubscribers(admin, PLAN);

    expect(queries.map((q) => q.table).sort()).toEqual(['family_groups', 'organizations', 'personal_subscriptions']);
    for (const query of queries) {
      expect(query.columns).toBe('id');
      expect(query.options).toEqual({ count: 'exact', head: true });
    }
  });

  it('plan_key で絞る (個人契約・家族は plan_key 列、組織は plan 列)。終了済みを外す絞り込みも付ける', async () => {
    const { admin, queries } = clientOf();
    await countPlanSubscribers(admin, PLAN);

    const personal = queryOf(queries, 'personal_subscriptions');
    expect(personal.eq).toEqual([['plan_key', PLAN_KEY]]);
    expect(personal.in).toEqual([['status', ['trialing', 'active', 'paused', 'past_due', 'grace']]]);

    const family = queryOf(queries, 'family_groups');
    expect(family.eq).toEqual(expect.arrayContaining([['plan_key', PLAN_KEY], ['status', 'active']]));
    expect(family.eq).toHaveLength(2);

    const organizations = queryOf(queries, 'organizations');
    expect(organizations.eq).toEqual(expect.arrayContaining([['plan', PLAN_KEY], ['status', 'active']]));
    expect(organizations.eq).toHaveLength(2);
  });
});

describe('countPlanSubscribers: 数えられなかったとき (確認できなかったことを 0 件にしない)', () => {
  it.each([
    ['personal_subscriptions', '42P01'],
    ['family_groups', '42703'],
    ['organizations', 'PGRST301'],
  ] as const)('%s の取得が DB エラーなら、テーブルとエラーコードを持つ PlanSubscriberCountError を投げる', async (table, code) => {
    const { admin } = clientOf({ errors: { [table]: { message: 'boom: secret detail', code } } });

    const error = await countPlanSubscribers(admin, PLAN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlanSubscriberCountError);
    expect((error as PlanSubscriberCountError).table).toBe(table);
    expect((error as PlanSubscriberCountError).pgCode).toBe(code);
  });

  it('件数が返らない (count が null) ときも、0 件にせず投げる', async () => {
    const { admin } = clientOf({ nullCount: ['family_groups'] });

    const error = await countPlanSubscribers(admin, PLAN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlanSubscriberCountError);
    expect((error as PlanSubscriberCountError).table).toBe('family_groups');
  });

  it.each([['空文字', ''], ['undefined', undefined], ['null', null]])(
    'plan_key が %s なら、どの契約者にも一致して 0 件になる前に投げる (DB は読まない)',
    async (_label, planKey) => {
      const { admin, from } = clientOf();

      await expect(countPlanSubscribers(admin, { plan_key: planKey as unknown as string, plan_type: 'personal' })).rejects.toBeInstanceOf(PlanSubscriberCountError);
      expect(from).not.toHaveBeenCalled();
    },
  );
});

describe('totalPlanSubscribers / planHasSubscribersMessage', () => {
  it('合計は 3 種類の足し算', () => {
    expect(totalPlanSubscribers({ personal_subscriptions: 2, family_groups: 1, organizations: 4 })).toBe(7);
    expect(totalPlanSubscribers({ personal_subscriptions: 0, family_groups: 0, organizations: 0 })).toBe(0);
  });

  it('件数が 1 以上の種類だけを内訳に並べる', () => {
    const message = planHasSubscribersMessage(
      { personal_subscriptions: 3, family_groups: 0, organizations: 1 },
      { canUnpublish: false },
    );
    expect(message).toContain('契約者がいるため、このプランは廃止できません');
    expect(message).toContain('個人契約 3 件・組織 1 件');
    expect(message).not.toContain('家族グループ');
  });

  it('公開中のプランには「非公開にする」の案内を足し、非公開のプランには足さない', () => {
    const counts = { personal_subscriptions: 1, family_groups: 0, organizations: 0 };
    expect(planHasSubscribersMessage(counts, { canUnpublish: true })).toContain('「非公開にする」');
    expect(planHasSubscribersMessage(counts, { canUnpublish: false })).not.toContain('非公開');
  });

  it('どちらの文面も、契約が終わってからもう一度廃止する案内で終わる', () => {
    const counts = { personal_subscriptions: 0, family_groups: 2, organizations: 0 };
    for (const canUnpublish of [true, false]) {
      expect(planHasSubscribersMessage(counts, { canUnpublish })).toMatch(/契約がすべて終了してから、もう一度廃止してください。$/);
    }
  });
});

describe('組織のプランの行 (plan_type = org の org_*) では、組織の件数を数えない (#1912)', () => {
  /** 組織のプランの行。organizations.plan (standard / premium / enterprise) とは一致しないので、数えると常に 0 件になる */
  const ORG_ROW = { plan_key: 'org_starter', plan_type: 'org' } as const;

  it('countsOrganizationsFor: org_* の行だけ数えない。個人・家族と、組織の段階と同じ key の行は数える', () => {
    expect(countsOrganizationsFor(ORG_ROW)).toBe(false);
    expect(countsOrganizationsFor({ plan_key: 'org_enterprise', plan_type: 'org' })).toBe(false);
    expect(countsOrganizationsFor({ plan_key: 'pro', plan_type: 'personal' })).toBe(true);
    expect(countsOrganizationsFor({ plan_key: 'family_basic', plan_type: 'family' })).toBe(true);
    for (const orgPlanValue of ORG_PLAN_VALUES) {
      // organizations.plan と同じ値の行は、組織の利用者の判定に使われるので数える
      expect(countsOrganizationsFor({ plan_key: orgPlanValue, plan_type: 'org' })).toBe(true);
    }
  });

  it('org_* の行では organizations を読まず、内訳に organizations のキーを入れない (0 と見せない)', async () => {
    const { admin, queries } = clientOf({
      tables: { organizations: [{ plan: ORG_ROW.plan_key, status: 'active' }] },
    });

    const counts = await countPlanSubscribers(admin, ORG_ROW);

    expect(queries.map((q) => q.table).sort()).toEqual(['family_groups', 'personal_subscriptions']);
    expect(counts).toEqual({ personal_subscriptions: 0, family_groups: 0 });
    expect('organizations' in counts).toBe(false);
    expect(isOrganizationsCounted(counts)).toBe(false);
  });

  it('org_* の行でも、個人契約と家族グループはこれまでどおり数える', async () => {
    const { admin } = clientOf({
      tables: {
        personal_subscriptions: [{ plan_key: ORG_ROW.plan_key, status: 'active' }],
        family_groups: [
          { plan_key: ORG_ROW.plan_key, status: 'active' },
          { plan_key: ORG_ROW.plan_key, status: 'dissolved' },
        ],
      },
    });

    await expect(countPlanSubscribers(admin, ORG_ROW)).resolves.toEqual({ personal_subscriptions: 1, family_groups: 1 });
  });

  it('org_* の行では organizations を読まないので、organizations の DB エラーで止まらない', async () => {
    const { admin } = clientOf({ errors: { organizations: { message: 'boom', code: '42P01' } } });

    await expect(countPlanSubscribers(admin, ORG_ROW)).resolves.toEqual({ personal_subscriptions: 0, family_groups: 0 });
  });

  it('個人・家族のプランは、これまでどおり organizations も数える (キーがあり 0 件も数値)', async () => {
    for (const plan of [PLAN, { plan_key: 'family_basic', plan_type: 'family' }]) {
      const { admin, queries } = clientOf();
      const counts = await countPlanSubscribers(admin, plan);
      expect(counts.organizations).toBe(0);
      expect(isOrganizationsCounted(counts)).toBe(true);
      expect(queries.map((q) => q.table).sort()).toEqual(['family_groups', 'organizations', 'personal_subscriptions']);
    }
  });

  it('合計は、数えていない組織を足さない (個人と家族だけ)', () => {
    expect(totalPlanSubscribers({ personal_subscriptions: 2, family_groups: 1 })).toBe(3);
    expect(totalPlanSubscribers({ personal_subscriptions: 0, family_groups: 0 })).toBe(0);
  });

  it('止める文面: 組織の件数を出さず、注記を出す', () => {
    const message = planHasSubscribersMessage({ personal_subscriptions: 1, family_groups: 0 }, { canUnpublish: true });

    expect(message).toContain('個人契約 1 件');
    expect(message).not.toMatch(/組織 \d+ 件/);
    expect(message).toContain(ORG_SUBSCRIPTION_PLAN_ROW_NOTE);
    expect(message).toMatch(/契約がすべて終了してから、もう一度廃止してください。$/);
  });

  it('個人・家族のプランの文面には、注記を出さない', () => {
    const message = planHasSubscribersMessage(
      { personal_subscriptions: 1, family_groups: 0, organizations: 0 },
      { canUnpublish: false },
    );
    expect(message).not.toContain(ORG_SUBSCRIPTION_PLAN_ROW_NOTE);
  });

  it('注記は、組織の段階 (standard / premium / enterprise) とは無関係で、組織の利用者の判定に使われないことを書く', () => {
    for (const orgPlanValue of ORG_PLAN_VALUES) {
      expect(ORG_SUBSCRIPTION_PLAN_ROW_NOTE).toContain(orgPlanValue);
    }
    expect(ORG_SUBSCRIPTION_PLAN_ROW_NOTE).toContain('とは無関係');
    expect(ORG_SUBSCRIPTION_PLAN_ROW_NOTE).toContain('組織の利用者の判定に使われません');
  });
});
