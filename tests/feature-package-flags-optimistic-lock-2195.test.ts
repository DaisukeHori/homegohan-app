/**
 * #2195 V4: 機能パッケージの編集 (PATCH /api/super-admin/feature-packages/[id]) の機能フラグの一覧の楽観ロック
 *
 * 以前の route は、本文の feature_flags (配列全体) を条件なしでそのまま書いていた。古い画面の一覧のまま basic のパッケージを保存すると、
 * 画面を開いたあとに機能フラグの作成 (POST /api/super-admin/flags が append_flag_to_feature_package で basic に足す。updated_at も now() にする)
 * が足したキーが一覧から消え、フラグの削除の「使用中か」の検査を素通りした。
 *
 * 直したあとの不変条件:
 *  - feature_flags を送るときは、画面が読んだ時点の updated_at (expected_updated_at) が要る。無い・日時の形でないときは
 *    400 OP_INVALID_INPUT (書かず、監査も残さない)
 *  - expected_updated_at を送った更新は、DB の updated_at がその値のままのときだけ書く条件つき (.eq('updated_at', 読んだ値))。
 *    読んでから書くまでに別の操作が変えていたら 0 行 → 読み直して、無ければ 404、あれば 409 CONFLICT_STALE_DATA
 *    (書かず、監査も残さない)。読み直しの DB の失敗は 500
 *  - feature_flags を送らない更新 (表示名など) は、今までどおり条件なしで書く
 *
 * 別の操作は、route が feature_packages の更新を DB に送る直前に割り込ませて再現する
 * (schema-checked-db は route が付けた .eq の条件を実際に当てるので、条件の付け忘れは 200 と書き込みで見える)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type Row, type SchemaDb } from './helpers/schema-checked-db';
import {
  FEATURE_PACKAGE_EXPECTED_UPDATED_AT_FORMAT_MESSAGE,
  FEATURE_PACKAGE_EXPECTED_UPDATED_AT_REQUIRED_MESSAGE,
} from '@/lib/super-admin/feature-packages-schemas';
import { STALE_DATA_ERROR_CODE } from '@/lib/admin/api-error-message';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

/** 運営 (super_admin) のセッションの client と service_role の client が見る DB (機能パッケージと監査ログ) */
let db: SchemaDb;

/** 読んでから書くまでの間に割り込む処理 (別の操作)。route が feature_packages の更新を送る直前に 1 回だけ実行する */
let beforeTargetUpdate: (() => PromiseLike<unknown>) | null = null;

/** true なら、feature_packages の更新を送ったあとの読み込み (0 行のあとの読み直し) を DB の失敗にする */
let failReadsAfterTargetUpdate = false;
/** feature_packages の更新を送り終えたか */
let targetUpdateSent = false;

/** 読み直しの DB の失敗 (本文に出てはいけない生の文) */
const REREAD_FAILURE = { code: '08006', message: 'connection reset by peer', details: null, hint: null };

const TARGET_TABLE = 'feature_packages';

function interleavingFrom(table: string) {
  const query = db.from(table);
  if (table !== TARGET_TABLE) return query;
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

const { PATCH: patchPackageRoute } = await import('@/app/api/super-admin/feature-packages/[id]/route');

const PACKAGE_ID = '00000000-0000-4000-8000-000000002195';
const ACTOR = { id: '00000000-0000-4000-8000-000000000001', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

/** 画面が GET で読んだ時点の updated_at (PostgREST が返す形。マイクロ秒と時差つき) */
const READ_UPDATED_AT = '2026-11-01T09:30:00.123456+00:00';
/** 別の操作 (機能フラグの作成の append_flag_to_feature_package) が書いた updated_at */
const APPENDED_UPDATED_AT = '2026-11-01T09:31:00.654321+00:00';
/** 画面を開いたあとに機能フラグの作成が basic に足したキー */
const APPENDED_FLAG = 'flag_appended_later';

function packageRow(overrides: Row = {}): Row {
  return {
    id: PACKAGE_ID,
    package_key: 'basic',
    display_name: '基本機能',
    description: null,
    feature_flags: ['flag_a', 'flag_b'],
    display_order: 1,
    status: 'active',
    created_at: '2026-10-01T00:00:00+00:00',
    updated_at: READ_UPDATED_AT,
    ...overrides,
  };
}

function setup(pkg: Row | null = packageRow()) {
  db = createSchemaDb({
    tables: {
      feature_packages: pkg ? [pkg] : [],
      admin_audit_logs: [],
    },
  });
}

function patchPackage(body: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/super-admin/feature-packages/${PACKAGE_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
  return patchPackageRoute(request, { params: Promise.resolve({ id: PACKAGE_ID }) });
}

/** 機能フラグの作成 (append_flag_to_feature_package) と同じ書き込み: キーを 1 つ足し、updated_at を新しくする */
function appendFlagConcurrently() {
  const current = (db.rows(TARGET_TABLE).find((row) => row.id === PACKAGE_ID)?.feature_flags ?? []) as string[];
  return db
    .from(TARGET_TABLE)
    .update({ feature_flags: [...current, APPENDED_FLAG], updated_at: APPENDED_UPDATED_AT })
    .eq('id', PACKAGE_ID);
}

const packageNow = () => db.rows(TARGET_TABLE).find((row) => row.id === PACKAGE_ID);
const auditRows = () => db.rows('admin_audit_logs');
const updates = () => db.recorded(TARGET_TABLE, 'update');
const json = (res: Response) => res.json() as Promise<{ data?: Row; error?: { code: string; message: string } }>;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ACTOR);
  beforeTargetUpdate = null;
  failReadsAfterTargetUpdate = false;
  targetUpdateSent = false;
});

describe('機能フラグの一覧を変えるときは、画面が読んだ updated_at が要る', () => {
  it('expected_updated_at が無ければ 400 OP_INVALID_INPUT で、書かず監査も残さない', async () => {
    setup();
    const res = await patchPackage({ feature_flags: ['flag_a'] });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error?.code).toBe('OP_INVALID_INPUT');
    expect(body.error?.message).toBe(FEATURE_PACKAGE_EXPECTED_UPDATED_AT_REQUIRED_MESSAGE);
    expect(updates()).toHaveLength(0);
    expect(packageNow()?.feature_flags).toEqual(['flag_a', 'flag_b']);
    expect(auditRows()).toHaveLength(0);
  });

  it.each([
    ['日時でない文字列', 'yesterday'],
    ['時差の無い日時', '2026-11-01T09:30:00'],
    ['数', 1730453400],
  ])('expected_updated_at が %s なら 400 OP_INVALID_INPUT で、DB に渡さない', async (_label, value) => {
    setup();
    const res = await patchPackage({ feature_flags: ['flag_a'], expected_updated_at: value });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error?.code).toBe('OP_INVALID_INPUT');
    if (typeof value === 'string') expect(body.error?.message).toBe(FEATURE_PACKAGE_EXPECTED_UPDATED_AT_FORMAT_MESSAGE);
    expect(updates()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('読んだ updated_at のままなら 200 で書き、更新は id と読んだ updated_at を条件にする。監査の changes に条件の値を入れない', async () => {
    setup();
    const res = await patchPackage({ feature_flags: ['flag_a', 'flag_c'], expected_updated_at: READ_UPDATED_AT });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toMatchObject({ id: PACKAGE_ID, feature_flags: ['flag_a', 'flag_c'] });
    // 書いた行の updated_at は新しい値 (次の保存の条件になる)
    expect(body.data?.updated_at).not.toBe(READ_UPDATED_AT);
    expect(packageNow()?.feature_flags).toEqual(['flag_a', 'flag_c']);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].eq).toEqual([
      ['id', PACKAGE_ID],
      ['updated_at', READ_UPDATED_AT],
    ]);
    expect(auditRows()).toHaveLength(1);
    const changes = (auditRows()[0].details as { changes: Record<string, unknown> }).changes;
    expect(changes).toMatchObject({ feature_flags: ['flag_a', 'flag_c'] });
    expect(changes).not.toHaveProperty('expected_updated_at');
  });
});

describe('画面が読んだあとに別の操作が機能パッケージを変えていた', () => {
  it('機能フラグの作成が basic にキーを足していた: 409 CONFLICT_STALE_DATA で、足されたキーを消さず、監査も残さない', async () => {
    setup();
    beforeTargetUpdate = appendFlagConcurrently;
    // 画面は開いたときの一覧 (flag_a, flag_b) から flag_b を外した一覧を送る
    const res = await patchPackage({ feature_flags: ['flag_a'], expected_updated_at: READ_UPDATED_AT });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe(STALE_DATA_ERROR_CODE);
    // 状態の変更だけとは限らないので、状態の文にしない
    expect(body.error?.message).toBe('別の操作で機能パッケージが先に変わりました。読み込み直してください');
    expect(packageNow()?.feature_flags).toEqual(['flag_a', 'flag_b', APPENDED_FLAG]);
    expect(packageNow()?.updated_at).toBe(APPENDED_UPDATED_AT);
    expect(auditRows()).toHaveLength(0);
  });

  it('別の運営が先に表示名を保存していた (updated_at が変わった): 409 で、機能フラグも表示名も書かない', async () => {
    setup();
    beforeTargetUpdate = () =>
      db.from(TARGET_TABLE).update({ display_name: '別の名前', updated_at: APPENDED_UPDATED_AT }).eq('id', PACKAGE_ID);
    const res = await patchPackage({
      display_name: '新しい名前',
      feature_flags: ['flag_b'],
      expected_updated_at: READ_UPDATED_AT,
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe(STALE_DATA_ERROR_CODE);
    expect(packageNow()).toMatchObject({ display_name: '別の名前', feature_flags: ['flag_a', 'flag_b'] });
    expect(auditRows()).toHaveLength(0);
  });

  it('読んでから書くまでにパッケージが消された: 404 OP_PACKAGE_NOT_FOUND で、監査も残さない', async () => {
    setup();
    beforeTargetUpdate = () => db.from(TARGET_TABLE).delete().eq('id', PACKAGE_ID);
    const res = await patchPackage({ feature_flags: ['flag_a'], expected_updated_at: READ_UPDATED_AT });
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('OP_PACKAGE_NOT_FOUND');
    expect(auditRows()).toHaveLength(0);
  });

  it('条件で 0 行のあとの読み直しが DB の失敗なら 500 (409 / 404 にしない・生の文を出さない)', async () => {
    setup();
    beforeTargetUpdate = appendFlagConcurrently;
    failReadsAfterTargetUpdate = true;
    const res = await patchPackage({ feature_flags: ['flag_a'], expected_updated_at: READ_UPDATED_AT });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain(REREAD_FAILURE.message);
    expect(packageNow()?.feature_flags).toEqual(['flag_a', 'flag_b', APPENDED_FLAG]);
    expect(auditRows()).toHaveLength(0);
  });

  it('状態の変更と一緒に送ったときは、読んだ status と読んだ updated_at の両方を条件にする', async () => {
    setup();
    const res = await patchPackage({ status: 'deprecated', feature_flags: ['flag_a'], expected_updated_at: READ_UPDATED_AT });
    expect(res.status).toBe(200);
    expect(updates()[0].eq).toEqual([
      ['id', PACKAGE_ID],
      ['status', 'active'],
      ['updated_at', READ_UPDATED_AT],
    ]);
  });
});

describe('機能フラグを送らない更新', () => {
  it('表示名だけの更新は expected_updated_at が無くても 200 で、条件をつけない (別の操作が足したキーにも触れない)', async () => {
    setup();
    beforeTargetUpdate = appendFlagConcurrently;
    const res = await patchPackage({ display_name: '新しい名前' });
    expect(res.status).toBe(200);
    expect(packageNow()).toMatchObject({ display_name: '新しい名前', feature_flags: ['flag_a', 'flag_b', APPENDED_FLAG] });
    expect(updates()[0].eq).toEqual([['id', PACKAGE_ID]]);
    expect(auditRows()).toHaveLength(1);
  });

  it('条件をつけない更新で行が無ければ、読み直さずに 404', async () => {
    setup(null);
    const res = await patchPackage({ display_name: '新しい名前' });
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('OP_PACKAGE_NOT_FOUND');
    expect(db.recorded(TARGET_TABLE, 'select')).toHaveLength(0);
  });
});
