/**
 * #2064 R2: PATCH /api/super-admin/coupons/[id] と PATCH /api/super-admin/feature-packages/[id] の状態の遷移の検査
 *
 * 以前の route は、本文の status を今の status を読まずにそのまま書き、毎回監査ログを残していた。
 * そのため、画面からは出せない遷移 (期限切れのクーポンの再開 expired → active・廃止したパッケージの取り消し deprecated → active)
 * や同じ状態への変更 (active → active) が 200 で通り、監査ログが残った。別の操作で expired にされたクーポンも、
 * 古い画面の「再開する」で active に戻せた。
 *
 * 直したあとの不変条件 (A/B テストの PATCH (#2059) と同じ形):
 *  - 状態を変えるときは今の status を読み、遷移表 (画面のボタンと同じ。クーポン active → paused・paused → active /
 *    機能パッケージ active → deprecated) に無い変更 (同じ状態への変更を含む) は 409 OP_COUPON_INVALID_TRANSITION /
 *    OP_FEATURE_PACKAGE_INVALID_TRANSITION で断る (書かず、監査ログも残さない)
 *  - 状態の更新は読んだ status のままのときだけ書く条件つき。読んでから書くまでに別の操作が状態を変えていたら 0 行で
 *    409 CONFLICT_STALE_DATA (書かず、監査も残さない)。行が消えていたら 404
 *  - status を送らない更新 (表示名など) は遷移の検査をしない (従来どおり)
 *
 * 別の操作は、route が対象のテーブルの更新を DB に送る直前に割り込ませて再現する
 * (schema-checked-db は route が付けた .eq の条件を実際に当てるので、条件の付け忘れは 200 と書き込みで見える)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type Row, type SchemaDb } from './helpers/schema-checked-db';
import {
  COUPON_INVALID_TRANSITION_ERROR_CODE,
  COUPON_STATUSES,
  COUPON_STATUS_TRANSITIONS,
  isAllowedCouponStatusTransition,
} from '@/lib/super-admin/coupons-schemas';
import {
  FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE,
  FEATURE_PACKAGE_STATUSES,
  FEATURE_PACKAGE_STATUS_TRANSITIONS,
  isAllowedFeaturePackageStatusTransition,
} from '@/lib/super-admin/feature-packages-schemas';
import { STALE_DATA_ERROR_CODE } from '@/lib/admin/api-error-message';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

/** 運営 (super_admin) のセッションの client と service_role の client が見る DB (クーポン・機能パッケージと監査ログ) */
let db: SchemaDb;

/** 読んでから書くまでの間に割り込む処理 (別の操作)。route が対象のテーブルの更新を送る直前に 1 回だけ実行する */
let beforeTargetUpdate: (() => PromiseLike<unknown>) | null = null;

/** true なら、対象のテーブルの更新を送ったあとの読み込み (0 行のあとの読み直し) を DB の失敗にする */
let failReadsAfterTargetUpdate = false;
/** 対象のテーブルの更新を送り終えたか */
let targetUpdateSent = false;

/** 読み直しの DB の失敗 (本文に出てはいけない生の文) */
const REREAD_FAILURE = { code: '08006', message: 'connection reset by peer', details: null, hint: null };

const TARGET_TABLES = new Set(['coupons', 'feature_packages']);

function interleavingFrom(table: string) {
  const query = db.from(table);
  if (!TARGET_TABLES.has(table)) return query;
  let isUpdate = false;
  const update = query.update.bind(query);
  query.update = (values) => {
    isUpdate = true;
    return update(values);
  };
  type Result = Awaited<ReturnType<typeof query.single>>;
  const wrap = (terminal: () => Promise<Result>) => async (): Promise<Result> => {
    if (isUpdate && beforeTargetUpdate) {
      const interleave = beforeTargetUpdate;
      beforeTargetUpdate = null;
      await interleave();
    }
    if (!isUpdate && failReadsAfterTargetUpdate && targetUpdateSent) {
      return { data: null, error: REREAD_FAILURE, count: null };
    }
    const result = await terminal();
    if (isUpdate) targetUpdateSent = true;
    return result;
  };
  query.single = wrap(query.single.bind(query));
  query.maybeSingle = wrap(query.maybeSingle.bind(query));
  return query;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ from: interleavingFrom }),
  getSupabaseAdmin: () => ({ from: interleavingFrom }),
}));

const { PATCH: patchCouponRoute } = await import('@/app/api/super-admin/coupons/[id]/route');
const { PATCH: patchPackageRoute } = await import('@/app/api/super-admin/feature-packages/[id]/route');

const COUPON_ID = '00000000-0000-4000-8000-000000002064';
const PACKAGE_ID = '00000000-0000-4000-8000-000000020640';
const ACTOR = { id: '00000000-0000-4000-8000-000000000001', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

function couponRow(overrides: Row = {}): Row {
  return {
    id: COUPON_ID,
    code: 'WINTER2064',
    display_name: '冬のクーポン',
    discount_type: 'fixed',
    discount_value: 500,
    applicable_plans: [],
    applicable_to: 'all',
    valid_from: '2026-10-01T00:00:00.000Z',
    valid_until: '2026-12-31T14:59:59.999Z',
    max_uses: 100,
    uses_count: 3,
    per_user_limit: 1,
    duration_months: null,
    gross_margin_preview_jpy: null,
    status: 'active',
    created_by: ACTOR.id,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function packageRow(overrides: Row = {}): Row {
  return {
    id: PACKAGE_ID,
    package_key: 'pkg_2064',
    display_name: '基本パッケージ',
    description: '基本の機能',
    feature_flags: ['flag_a', 'flag_b'],
    display_order: 2,
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function setup(rows: { coupon?: Row | null; pkg?: Row | null } = {}, options: { errors?: Record<string, { message: string; code?: string }> } = {}) {
  db = createSchemaDb({
    tables: {
      coupons: rows.coupon ? [rows.coupon] : [],
      feature_packages: rows.pkg ? [rows.pkg] : [],
      admin_audit_logs: [],
    },
    errors: options.errors,
  });
}

function patchRequest(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

function patchCoupon(body: Record<string, unknown>) {
  return patchCouponRoute(patchRequest(`/api/super-admin/coupons/${COUPON_ID}`, body), {
    params: Promise.resolve({ id: COUPON_ID }),
  });
}

function patchPackage(body: Record<string, unknown>) {
  return patchPackageRoute(patchRequest(`/api/super-admin/feature-packages/${PACKAGE_ID}`, body), {
    params: Promise.resolve({ id: PACKAGE_ID }),
  });
}

const couponNow = () => db.rows('coupons').find((row) => row.id === COUPON_ID);
const packageNow = () => db.rows('feature_packages').find((row) => row.id === PACKAGE_ID);
const auditRows = () => db.rows('admin_audit_logs');
const json = (res: Response) => res.json() as Promise<Record<string, any>>;

/** クーポンの画面のボタンが送る遷移 (詳細: 一時停止・再開する) */
const COUPON_ALLOWED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['active', 'paused'],
  ['paused', 'active'],
];
/** 機能パッケージの画面のボタンが送る遷移 (詳細: 廃止する) */
const PACKAGE_ALLOWED_PAIRS: ReadonlyArray<readonly [string, string]> = [['active', 'deprecated']];

function deniedPairs(statuses: readonly string[], allowed: ReadonlyArray<readonly [string, string]>) {
  return statuses.flatMap((from) =>
    statuses.filter((to) => !allowed.some(([f, t]) => f === from && t === to)).map((to) => [from, to] as const),
  );
}

/** 3 つの状態の総当たり (9 通り) のうち、遷移表に無いもの (同じ状態への変更を含む 7 通り) */
const COUPON_DENIED_PAIRS = deniedPairs(['active', 'paused', 'expired'], COUPON_ALLOWED_PAIRS);
/** 2 つの状態の総当たり (4 通り) のうち、遷移表に無いもの (同じ状態への変更を含む 3 通り) */
const PACKAGE_DENIED_PAIRS = deniedPairs(['active', 'deprecated'], PACKAGE_ALLOWED_PAIRS);

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ACTOR);
  beforeTargetUpdate = null;
  failReadsAfterTargetUpdate = false;
  targetUpdateSent = false;
});

describe('遷移表', () => {
  it('クーポン: 許す遷移は画面のボタンと同じ 2 つだけ (active → paused・paused → active)。expired は終端', () => {
    expect(COUPON_STATUSES).toEqual(['active', 'paused', 'expired']);
    const allowed = COUPON_STATUSES.flatMap((from) => COUPON_STATUS_TRANSITIONS[from].map((to) => [from, to]));
    expect(allowed).toEqual(COUPON_ALLOWED_PAIRS.map(([from, to]) => [from, to]));
    expect(COUPON_STATUS_TRANSITIONS.expired).toEqual([]);
    expect(COUPON_DENIED_PAIRS).toHaveLength(7);
    for (const [from, to] of COUPON_DENIED_PAIRS) {
      expect(isAllowedCouponStatusTransition(from, to as (typeof COUPON_STATUSES)[number]), `${from} → ${to}`).toBe(false);
    }
    for (const [from, to] of COUPON_ALLOWED_PAIRS) {
      expect(isAllowedCouponStatusTransition(from, to as (typeof COUPON_STATUSES)[number]), `${from} → ${to}`).toBe(true);
    }
  });

  it('機能パッケージ: 許す遷移は画面のボタンと同じ 1 つだけ (active → deprecated)。deprecated は終端', () => {
    expect(FEATURE_PACKAGE_STATUSES).toEqual(['active', 'deprecated']);
    const allowed = FEATURE_PACKAGE_STATUSES.flatMap((from) => FEATURE_PACKAGE_STATUS_TRANSITIONS[from].map((to) => [from, to]));
    expect(allowed).toEqual(PACKAGE_ALLOWED_PAIRS.map(([from, to]) => [from, to]));
    expect(FEATURE_PACKAGE_STATUS_TRANSITIONS.deprecated).toEqual([]);
    expect(PACKAGE_DENIED_PAIRS).toHaveLength(3);
    for (const [from, to] of PACKAGE_DENIED_PAIRS) {
      expect(isAllowedFeaturePackageStatusTransition(from, to as (typeof FEATURE_PACKAGE_STATUSES)[number]), `${from} → ${to}`).toBe(false);
    }
    expect(isAllowedFeaturePackageStatusTransition('active', 'deprecated')).toBe(true);
  });

  it('DB に知らない status が入っていたら、どこへも変えない', () => {
    for (const to of COUPON_STATUSES) {
      expect(isAllowedCouponStatusTransition('archived', to)).toBe(false);
    }
    for (const to of FEATURE_PACKAGE_STATUSES) {
      expect(isAllowedFeaturePackageStatusTransition('archived', to)).toBe(false);
    }
  });
});

describe('クーポン: 遷移表にある変更', () => {
  it.each(COUPON_ALLOWED_PAIRS)('%s → %s は 200 で書き、監査ログを 1 行残す。更新は読んだ status を条件にする', async (from, to) => {
    setup({ coupon: couponRow({ status: from }) });
    const res = await patchCoupon({ status: to });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id: COUPON_ID, status: to });
    expect(couponNow()?.status).toBe(to);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].details).toMatchObject({ changes: { status: to } });
    const update = db.recorded('coupons', 'update');
    expect(update).toHaveLength(1);
    expect(update[0].eq).toEqual([
      ['id', COUPON_ID],
      ['status', from],
    ]);
  });
});

describe('クーポン: 遷移表に無い変更 (同じ状態への変更・期限切れからの再開・期限切れへの変更)', () => {
  it.each(COUPON_DENIED_PAIRS)('%s → %s は 409 OP_COUPON_INVALID_TRANSITION で断り、書かず監査も残さない', async (from, to) => {
    setup({ coupon: couponRow({ status: from }) });
    const res = await patchCoupon({ status: to });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe(COUPON_INVALID_TRANSITION_ERROR_CODE);
    expect(body.error.code).toBe('OP_COUPON_INVALID_TRANSITION');
    // 状態は「画面の名前 (値)」の形で括弧に入れる (英字の値を括弧の外に出さない)
    expect(body.error.message).toContain(`(${from}) から`);
    expect(body.error.message).toContain(`(${to}) へは変えられません`);
    expect(couponNow()?.status).toBe(from);
    expect(db.recorded('coupons', 'update')).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('期限切れのクーポンの再開 (expired → active) の文は日本語の状態の名前で、変えられる遷移を添える', async () => {
    setup({ coupon: couponRow({ status: 'expired' }) });
    const res = await patchCoupon({ status: 'active' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toBe(
      'クーポンの状態は 期限切れ (expired) から 有効 (active) へは変えられません (変えられるのは 有効 (active) → 停止中 (paused)・停止中 (paused) → 有効 (active) だけです)',
    );
  });

  it('二度押し (active → paused を続けて 2 本) は、2 本目が 409 で、監査ログは 1 行だけ', async () => {
    setup({ coupon: couponRow({ status: 'active' }) });
    const first = await patchCoupon({ status: 'paused' });
    const second = await patchCoupon({ status: 'paused' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect((await json(second)).error.code).toBe(COUPON_INVALID_TRANSITION_ERROR_CODE);
    expect(couponNow()?.status).toBe('paused');
    expect(auditRows()).toHaveLength(1);
  });

  it('状態と一緒に送った表示名も書かない (遷移が断られたら本文のどの項目も書かない)', async () => {
    setup({ coupon: couponRow({ status: 'expired', display_name: '元の名前' }) });
    const res = await patchCoupon({ status: 'active', display_name: '新しい名前' });
    expect(res.status).toBe(409);
    expect(couponNow()).toMatchObject({ status: 'expired', display_name: '元の名前' });
    expect(auditRows()).toHaveLength(0);
  });
});

describe('クーポン: 読んでから書くまでに別の操作が状態を変えた (2 つのタブ・2 人で同時に押した)', () => {
  it('paused → active の間に別の操作が期限切れにしていた: 409 CONFLICT_STALE_DATA。期限切れのクーポンは再開されない', async () => {
    setup({ coupon: couponRow({ status: 'paused' }) });
    beforeTargetUpdate = () => db.from('coupons').update({ status: 'expired' }).eq('id', COUPON_ID);
    const res = await patchCoupon({ status: 'active' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe(STALE_DATA_ERROR_CODE);
    expect(couponNow()?.status).toBe('expired');
    expect(auditRows()).toHaveLength(0);
  });

  it('active → paused の間に別の操作が一時停止していた: 409 CONFLICT_STALE_DATA。監査は残さない', async () => {
    setup({ coupon: couponRow({ status: 'active' }) });
    beforeTargetUpdate = () => db.from('coupons').update({ status: 'paused' }).eq('id', COUPON_ID);
    const res = await patchCoupon({ status: 'paused' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe(STALE_DATA_ERROR_CODE);
    expect(couponNow()?.status).toBe('paused');
    expect(auditRows()).toHaveLength(0);
  });

  it('読んでから書くまでにクーポンが消された: 404 OP_COUPON_NOT_FOUND で、監査も残さない', async () => {
    setup({ coupon: couponRow({ status: 'active' }) });
    beforeTargetUpdate = () => db.from('coupons').delete().eq('id', COUPON_ID);
    const res = await patchCoupon({ status: 'paused' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('OP_COUPON_NOT_FOUND');
    expect(auditRows()).toHaveLength(0);
  });

  it('条件で 0 行のあとの読み直しが DB の失敗なら 500 (409 / 404 にしない)', async () => {
    setup({ coupon: couponRow({ status: 'active' }) });
    beforeTargetUpdate = () => db.from('coupons').update({ status: 'paused' }).eq('id', COUPON_ID);
    failReadsAfterTargetUpdate = true;
    const res = await patchCoupon({ status: 'paused' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain(REREAD_FAILURE.message);
    expect(couponNow()?.status).toBe('paused');
    expect(auditRows()).toHaveLength(0);
  });
});

describe('クーポン: status を送らない更新', () => {
  it('表示名だけの更新は、期限切れのクーポンでも遷移の検査をせずに 200 (従来どおり。条件をつけない)', async () => {
    setup({ coupon: couponRow({ status: 'expired', display_name: '元の名前' }) });
    const res = await patchCoupon({ display_name: '新しい名前' });
    expect(res.status).toBe(200);
    expect(couponNow()).toMatchObject({ status: 'expired', display_name: '新しい名前' });
    expect(auditRows()).toHaveLength(1);
    expect(db.recorded('coupons', 'update')[0].eq).toEqual([['id', COUPON_ID]]);
  });
});

describe('機能パッケージ: 遷移表にある変更', () => {
  it('active → deprecated は 200 で書き、監査ログを 1 行残す。更新は読んだ status を条件にする', async () => {
    setup({ pkg: packageRow({ status: 'active' }) });
    const res = await patchPackage({ status: 'deprecated' });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id: PACKAGE_ID, status: 'deprecated' });
    expect(packageNow()?.status).toBe('deprecated');
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].details).toMatchObject({ changes: { status: 'deprecated' } });
    const update = db.recorded('feature_packages', 'update');
    expect(update).toHaveLength(1);
    expect(update[0].eq).toEqual([
      ['id', PACKAGE_ID],
      ['status', 'active'],
    ]);
  });
});

describe('機能パッケージ: 遷移表に無い変更 (同じ状態への変更・廃止の取り消し)', () => {
  it.each(PACKAGE_DENIED_PAIRS)('%s → %s は 409 OP_FEATURE_PACKAGE_INVALID_TRANSITION で断り、書かず監査も残さない', async (from, to) => {
    setup({ pkg: packageRow({ status: from }) });
    const res = await patchPackage({ status: to });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe(FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE);
    expect(body.error.code).toBe('OP_FEATURE_PACKAGE_INVALID_TRANSITION');
    expect(body.error.message).toContain(`(${from}) から`);
    expect(body.error.message).toContain(`(${to}) へは変えられません`);
    expect(packageNow()?.status).toBe(from);
    expect(db.recorded('feature_packages', 'update')).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('廃止の取り消し (deprecated → active) の文は日本語の状態の名前で、変えられる遷移を添える', async () => {
    setup({ pkg: packageRow({ status: 'deprecated' }) });
    const res = await patchPackage({ status: 'active' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toBe(
      '機能パッケージの状態は 廃止 (deprecated) から 有効 (active) へは変えられません (変えられるのは 有効 (active) → 廃止 (deprecated) だけです)',
    );
  });

  it('状態と一緒に送った表示名も書かない', async () => {
    setup({ pkg: packageRow({ status: 'deprecated', display_name: '元の名前' }) });
    const res = await patchPackage({ status: 'active', display_name: '新しい名前' });
    expect(res.status).toBe(409);
    expect(packageNow()).toMatchObject({ status: 'deprecated', display_name: '元の名前' });
    expect(auditRows()).toHaveLength(0);
  });
});

describe('機能パッケージ: 読んでから書くまでに別の操作が状態を変えた', () => {
  it('active → deprecated の間に別の操作が廃止していた: 409 CONFLICT_STALE_DATA。監査は残さない', async () => {
    setup({ pkg: packageRow({ status: 'active' }) });
    beforeTargetUpdate = () => db.from('feature_packages').update({ status: 'deprecated' }).eq('id', PACKAGE_ID);
    const res = await patchPackage({ status: 'deprecated' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe(STALE_DATA_ERROR_CODE);
    expect(packageNow()?.status).toBe('deprecated');
    expect(auditRows()).toHaveLength(0);
  });

  it('読んでから書くまでにパッケージが消された: 404 OP_PACKAGE_NOT_FOUND で、監査も残さない', async () => {
    setup({ pkg: packageRow({ status: 'active' }) });
    beforeTargetUpdate = () => db.from('feature_packages').delete().eq('id', PACKAGE_ID);
    const res = await patchPackage({ status: 'deprecated' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('OP_PACKAGE_NOT_FOUND');
    expect(auditRows()).toHaveLength(0);
  });

  it('条件で 0 行のあとの読み直しが DB の失敗なら 500 (409 / 404 にしない)', async () => {
    setup({ pkg: packageRow({ status: 'active' }) });
    beforeTargetUpdate = () => db.from('feature_packages').update({ status: 'deprecated' }).eq('id', PACKAGE_ID);
    failReadsAfterTargetUpdate = true;
    const res = await patchPackage({ status: 'deprecated' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain(REREAD_FAILURE.message);
    expect(auditRows()).toHaveLength(0);
  });
});

describe('機能パッケージ: 状態を読めないとき・行が無いとき', () => {
  it('行が無ければ 404 で、更新を送らない', async () => {
    setup({ pkg: null });
    const res = await patchPackage({ status: 'deprecated' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('OP_PACKAGE_NOT_FOUND');
    expect(db.recorded('feature_packages', 'update')).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('今の状態の読み込みが DB の失敗なら 500 (404 にしない・遷移を検査せずに書かない)', async () => {
    setup({ pkg: packageRow({ status: 'active' }) }, { errors: { feature_packages: { message: 'connection reset by peer', code: '08006' } } });
    const res = await patchPackage({ status: 'deprecated' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain('connection reset by peer');
    expect(auditRows()).toHaveLength(0);
  });
});

describe('機能パッケージ: status を送らない更新', () => {
  it('表示名だけの更新は、廃止したパッケージでも遷移の検査をせずに 200 (従来どおり。条件をつけない)', async () => {
    setup({ pkg: packageRow({ status: 'deprecated', display_name: '元の名前' }) });
    const res = await patchPackage({ display_name: '新しい名前' });
    expect(res.status).toBe(200);
    expect(packageNow()).toMatchObject({ status: 'deprecated', display_name: '新しい名前' });
    expect(auditRows()).toHaveLength(1);
    expect(db.recorded('feature_packages', 'select')).toHaveLength(0);
    expect(db.recorded('feature_packages', 'update')[0].eq).toEqual([['id', PACKAGE_ID]]);
  });
});
