/**
 * #1157 (T23) GET /api/super-admin/logs — 運用ログ (app_logs) の閲覧 (結合テスト: Next の API ルート + 実 Supabase)
 *
 * 単体テスト (tests/super-admin-logs-route.test.ts) は app_logs のフェイクで動く。フェイクでは確かめられない、
 * 実際の PostgREST / PostgreSQL での次のことを、実 DB に種をまいて route を呼んで確かめる。
 *   - 認可: super_admin だけ 200。admin も一般ユーザーも 403、未認証は 401
 *   - app_logs の RLS (本人の行だけ読める: #1171) を越えて、他人の行も user_id が NULL の行も読める
 *     (route が service role を使う理由。これが効かないと、運用者は自分のログしか見えない)
 *   - 絞り込み (level / source / user_id / request_id / from / to) が実 DB で効く。日時はマイクロ秒まで比べる
 *   - カーソルの or=(created_at.lt.X,and(created_at.eq.X,id.lt.Y)) が PostgREST に通り、
 *     timestamptz のマイクロ秒・同時刻の行があっても、全行が重複も欠落もなく 1 回ずつ出る
 *   - select する列がすべて実在する (存在しない列だと 42703 で 500 になる: #1306)
 *   - 画面 /super-admin/logs: super_admin だけが開ける (レイアウトの権限ガード)。admin・一般ユーザー・未認証はログインへ戻される。
 *     ページが実際にコンパイルされ、サーバーで描画される
 *
 * 種の app_logs は 2033 年の日時と専用の function_name で入れる。本物のログや他のテストと混ざらないし、
 * 後片付けで「このテストが入れた行だけ」を消せる。
 *
 * 実行 (ローカル Supabase + ローカルの Next dev サーバが必要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   INTEGRATION_BASE_URL=http://localhost:3000 \
 *     npx vitest run --config vitest.integration.config.ts tests/integration/security/super-admin-logs.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

// このテストはローカルの dev サーバだけを対象にする (本番や共有環境へ誤って向けない。JWT を送るため)。
// apiCall ヘルパー (tests/integration/helpers/api.ts) と同じ順序で接続先を決める。
const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const baseHost = new URL(BASE_URL).hostname;
if (baseHost !== 'localhost' && baseHost !== '127.0.0.1') {
  throw new Error(
    `INTEGRATION_BASE_URL (未設定なら NEXT_PUBLIC_APP_URL) はローカルの dev サーバを指してください (現在: ${BASE_URL})`,
  );
}

const TS = Date.now();
const email = (label: string) => `sec-1157-${label}-${TS}@homegohan.test`;
/** function_name の印。この実行が入れた行だけを特定する */
const MARK = `sec-1157-logs-${TS}`;
/** 前回の実行が途中で落ちて残した行の掃除用 */
const MARK_ANY = 'sec-1157-logs-';

let superAdminUser: TestUser;
let adminUser: TestUser;
let generalUser: TestUser;

interface Seed {
  label: string;
  /** PostgreSQL が返す形 (マイクロ秒) で入れる */
  created_at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'api-route' | 'edge-function' | 'client';
  /** 'general' | 'admin' はテストユーザー。null は user_id が NULL の行 (cron など) */
  owner: 'general' | 'admin' | null;
  request_id: string;
  /** 同時刻の行の並び (id の大きい順) を決めるため、id を固定する */
  id: string;
}

const id = (n: number) => `11570000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * 新しい順は g, f, c3, c2, c1, b, a。
 *   - a と b: 同じミリ秒でマイクロ秒だけ違う (ミリ秒に丸めるカーソルだと、片方が飛ぶ)
 *   - c1 / c2 / c3: まったく同じ時刻 (id の大きい順 c3, c2, c1 になる)
 */
const SEEDS: Seed[] = [
  { label: 'a', created_at: '2033-03-01T00:00:00.000100+00:00', level: 'error', source: 'api-route', owner: 'general', request_id: `${MARK}-a`, id: id(1) },
  { label: 'b', created_at: '2033-03-01T00:00:00.000200+00:00', level: 'warn', source: 'edge-function', owner: null, request_id: `${MARK}-b`, id: id(2) },
  { label: 'c1', created_at: '2033-03-01T00:00:01+00:00', level: 'error', source: 'client', owner: null, request_id: `${MARK}-shared`, id: id(11) },
  { label: 'c2', created_at: '2033-03-01T00:00:01+00:00', level: 'info', source: 'api-route', owner: 'general', request_id: `${MARK}-c2`, id: id(12) },
  { label: 'c3', created_at: '2033-03-01T00:00:01+00:00', level: 'error', source: 'api-route', owner: null, request_id: `${MARK}-shared`, id: id(13) },
  { label: 'f', created_at: '2033-03-01T00:00:02+00:00', level: 'debug', source: 'edge-function', owner: null, request_id: `${MARK}-f`, id: id(21) },
  { label: 'g', created_at: '2033-03-01T00:00:03.999999+00:00', level: 'error', source: 'api-route', owner: 'admin', request_id: `${MARK}-g`, id: id(31) },
];
const NEWEST_FIRST = ['g', 'f', 'c3', 'c2', 'c1', 'b', 'a'];

const labelOf = (rowId: string) => SEEDS.find((s) => s.id === rowId)?.label ?? `?(${rowId})`;

interface LogRow {
  id: string;
  created_at: string;
  level: string;
  source: string;
  function_name: string | null;
  user_id: string | null;
  request_id: string | null;
  message: string;
  error_message: string | null;
  error_stack: string | null;
  metadata: unknown;
}

interface LogsBody {
  data: LogRow[];
  meta: { limit: number; has_more: boolean; next_cursor: string | null };
}

const base = `/api/super-admin/logs?function_name=${encodeURIComponent(MARK)}`;

/** 種の行だけを対象に route を呼ぶ。応答の行を label の並びで返す */
async function labels(query = '', jwt = superAdminUser.jwt) {
  const res = await apiCall<LogsBody>('GET', `${base}${query}`, jwt);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { labels: res.body.data.map((row) => labelOf(row.id)), meta: res.body.meta, rows: res.body.data };
}

/** next_cursor が null になるまで読み、各ページの label を返す */
async function readAllPages(query: string, maxPages = 20) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i += 1) {
    const { labels: page, meta } = await labels(cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query);
    pages.push(page);
    cursor = meta.next_cursor;
    if (!cursor) return pages;
  }
  throw new Error('ページ送りが終わらない');
}

beforeAll(async () => {
  // 前回の実行が途中で落ちて残した行を掃除する
  await supabaseAdmin.from('app_logs').delete().like('function_name', `${MARK_ANY}%`);

  [superAdminUser, adminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: email('sa'), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: email('admin'), roles: ['admin'] }),
    createTestUserWithRoles({ email: email('gen'), roles: ['user'] }),
  ]);

  // 一般ユーザーを「初期設定済み」にする。初期設定前のユーザーは、ミドルウェアが画面の権限ガードより先に
  // /onboarding/welcome へ送ってしまう (admin / super_admin は送られない)。画面のガード自体を確かめたい
  const { error: onboardingError } = await supabaseAdmin
    .from('user_profiles')
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq('id', generalUser.userId);
  if (onboardingError) throw new Error(`Failed to complete onboarding for the general user: ${onboardingError.message}`);

  const ownerId = (owner: Seed['owner']) =>
    owner === 'general' ? generalUser.userId : owner === 'admin' ? adminUser.userId : null;
  const { error } = await supabaseAdmin.from('app_logs').insert(
    SEEDS.map((seed) => ({
      id: seed.id,
      created_at: seed.created_at,
      level: seed.level,
      source: seed.source,
      function_name: MARK,
      user_id: ownerId(seed.owner),
      request_id: seed.request_id,
      message: `message ${seed.label}`,
      error_message: seed.level === 'error' ? `error ${seed.label}` : null,
      error_stack: seed.level === 'error' ? `Error: ${seed.label}\n    at fixtureFrame (route.js:1:1)` : null,
      metadata: { label: seed.label },
    })),
  );
  if (error) throw new Error(`Failed to insert app_logs fixtures: ${error.message}`);
}, 60_000);

afterAll(async () => {
  // このテストが入れた行だけを消す (ほかのログは消さない)
  await supabaseAdmin.from('app_logs').delete().like('function_name', `${MARK_ANY}%`);
  const { data: left } = await supabaseAdmin.from('app_logs').select('id').like('function_name', `${MARK_ANY}%`);
  expect(left ?? []).toEqual([]);

  await Promise.all([superAdminUser, adminUser, generalUser].map((u) => (u ? cleanupTestUser(u.userId) : undefined)));
}, 30_000);

describe('#1157 GET /api/super-admin/logs: 認可', () => {
  it('未認証は 401', async () => {
    const res = await apiCallNoAuth('GET', base);
    expect(res.status).toBe(401);
  });

  it('一般ユーザーは 403', async () => {
    const res = await apiCall('GET', base, generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('admin も 403 (運用ログは super_admin だけ。監査ログと同じ)', async () => {
    const res = await apiCall('GET', base, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('403 の応答には、ログの中身を含めない', async () => {
    const res = await apiCall('GET', base, adminUser.jwt);
    expect(JSON.stringify(res.body)).not.toContain(MARK);
    expect(JSON.stringify(res.body)).not.toContain('message a');
  });

  it('super_admin は 200', async () => {
    const res = await apiCall('GET', base, superAdminUser.jwt);
    expect(res.status).toBe(200);
  });
});

describe('#1157 GET /api/super-admin/logs: 一覧', () => {
  it('RLS を越えて、他人の行も user_id が NULL の行も読める。新しい順で、同時刻の行は id の大きい順', async () => {
    const { labels: all, rows } = await labels();

    expect(all).toEqual(NEWEST_FIRST);
    // 呼び出した super_admin 本人の行は 1 件も無い。それでも全部見える = service role で読んでいる
    expect(rows.some((row) => row.user_id === superAdminUser.userId)).toBe(false);
    const owners = new Set(rows.map((row) => row.user_id));
    expect(owners).toEqual(new Set([generalUser.userId, adminUser.userId, null]));
  });

  it('全列を保存されたまま返す (message / error_message / error_stack / metadata)', async () => {
    const { rows } = await labels('&level=error&limit=1');
    const row = rows[0];

    expect(Object.keys(row).sort()).toEqual(
      [
        'created_at',
        'error_message',
        'error_stack',
        'function_name',
        'id',
        'level',
        'message',
        'metadata',
        'request_id',
        'source',
        'user_id',
      ].sort(),
    );
    expect(row).toMatchObject({
      id: id(31),
      level: 'error',
      source: 'api-route',
      function_name: MARK,
      user_id: adminUser.userId,
      request_id: `${MARK}-g`,
      message: 'message g',
      error_message: 'error g',
      metadata: { label: 'g' },
    });
    expect(row.error_stack).toContain('fixtureFrame');
    // PostgREST が timestamptz を返す形 (マイクロ秒まで)
    expect(row.created_at).toMatch(/^2033-03-01T00:00:03\.999999\+00:00$/);
  });

  it('meta は limit / has_more / next_cursor。続きが無ければ next_cursor は null', async () => {
    const { meta } = await labels();

    expect(meta).toEqual({ limit: 50, has_more: false, next_cursor: null });
  });
});

describe('#1157 GET /api/super-admin/logs: 絞り込み (実 DB)', () => {
  it('level', async () => {
    expect((await labels('&level=error')).labels).toEqual(['g', 'c3', 'c1', 'a']);
    expect((await labels('&level=warn')).labels).toEqual(['b']);
    expect((await labels('&level=info')).labels).toEqual(['c2']);
  });

  it('source', async () => {
    expect((await labels('&source=api-route')).labels).toEqual(['g', 'c3', 'c2', 'a']);
    expect((await labels('&source=client')).labels).toEqual(['c1']);
  });

  it('user_id', async () => {
    expect((await labels(`&user_id=${generalUser.userId}`)).labels).toEqual(['c2', 'a']);
    expect((await labels(`&user_id=${adminUser.userId}`)).labels).toEqual(['g']);
  });

  it('request_id は完全一致 (同じ request_id の行が複数あれば全部)', async () => {
    expect((await labels(`&request_id=${MARK}-shared`)).labels).toEqual(['c3', 'c1']);
    expect((await labels(`&request_id=${MARK}-c2`)).labels).toEqual(['c2']);
    // 部分一致では当たらない
    expect((await labels(`&request_id=${MARK}-c`)).labels).toEqual([]);
  });

  it('function_name は完全一致', async () => {
    const res = await apiCall<LogsBody>('GET', `/api/super-admin/logs?function_name=${encodeURIComponent(MARK.slice(0, -2))}`, superAdminUser.jwt);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('組み合わせは AND', async () => {
    expect((await labels('&level=error&source=api-route')).labels).toEqual(['g', 'c3', 'a']);
    expect((await labels(`&level=error&source=api-route&user_id=${generalUser.userId}`)).labels).toEqual(['a']);
    expect((await labels(`&level=info&source=client`)).labels).toEqual([]);
  });

  it('from / to: どちらの端も含む。時差付きの指定も同じ瞬間として扱う', async () => {
    // 2033-03-01T09:00:01+09:00 = 00:00:01Z。c1 / c2 / c3 (ちょうど 00:00:01) を含む
    const from = encodeURIComponent('2033-03-01T09:00:01+09:00');
    expect((await labels(`&from=${from}`)).labels).toEqual(['g', 'f', 'c3', 'c2', 'c1']);

    const to = encodeURIComponent('2033-03-01T00:00:01Z');
    expect((await labels(`&to=${to}`)).labels).toEqual(['c3', 'c2', 'c1', 'b', 'a']);

    expect((await labels(`&from=${to}&to=${to}`)).labels).toEqual(['c3', 'c2', 'c1']);
  });

  it('日時はマイクロ秒まで比べる (a = .000100 は含まず、b = .000200 は含む)', async () => {
    const from = encodeURIComponent('2033-03-01T00:00:00.000150Z');
    const to = encodeURIComponent('2033-03-01T00:00:00.000250Z');

    expect((await labels(`&from=${from}&to=${to}`)).labels).toEqual(['b']);
    expect((await labels(`&from=${from}`)).labels).toEqual(NEWEST_FIRST.filter((l) => l !== 'a'));
  });

  it('範囲に行が無ければ空の配列 (200)', async () => {
    const from = encodeURIComponent('2040-01-01T00:00:00Z');

    const { labels: none, meta } = await labels(`&from=${from}`);

    expect(none).toEqual([]);
    expect(meta).toEqual({ limit: 50, has_more: false, next_cursor: null });
  });
});

describe('#1157 GET /api/super-admin/logs: カーソルでのページ送り (実 PostgREST)', () => {
  it('limit=2 で最後まで読むと、7 行が重複も欠落もなく新しい順に 1 回ずつ出る', async () => {
    const pages = await readAllPages('&limit=2');

    expect(pages).toEqual([['g', 'f'], ['c3', 'c2'], ['c1', 'b'], ['a']]);
  });

  it('limit=3 でも同じ (同時刻の c1 / c2 / c3 がページをまたぐ)', async () => {
    const pages = await readAllPages('&limit=3');

    expect(pages).toEqual([['g', 'f', 'c3'], ['c2', 'c1', 'b'], ['a']]);
  });

  it('limit=1 で、ミリ秒が同じでマイクロ秒だけ違う a / b も飛ばさず重複もしない', async () => {
    const pages = await readAllPages('&limit=1');

    expect(pages.flat()).toEqual(NEWEST_FIRST);
    expect(pages.every((page) => page.length === 1)).toBe(true);
  });

  it('ちょうど limit 件で終わるときは、続きなし。1 件足りないときは続きあり', async () => {
    const exact = await labels('&limit=7');
    expect(exact.labels).toEqual(NEWEST_FIRST);
    expect(exact.meta).toMatchObject({ limit: 7, has_more: false, next_cursor: null });

    const short = await labels('&limit=6');
    expect(short.labels).toEqual(NEWEST_FIRST.slice(0, 6));
    expect(short.meta.has_more).toBe(true);
    expect(short.meta.next_cursor).toEqual(expect.any(String));
    const rest = await labels(`&limit=6&cursor=${encodeURIComponent(short.meta.next_cursor!)}`);
    expect(rest.labels).toEqual(['a']);
    expect(rest.meta).toMatchObject({ has_more: false, next_cursor: null });
  });

  it('絞り込み・期間と組み合わせても、該当する行が 1 回ずつ出る', async () => {
    // level=error は g, c3, c1, a。1 件ずつ
    expect(await readAllPages('&level=error&limit=1')).toEqual([['g'], ['c3'], ['c1'], ['a']]);

    // from / to (どちらも含む) と組み合わせる。00:00:01 の c1 / c2 / c3 だけ。同時刻の行がページをまたぐ
    const at = encodeURIComponent('2033-03-01T00:00:01Z');
    expect(await readAllPages(`&from=${at}&to=${at}&limit=2`)).toEqual([['c3', 'c2'], ['c1']]);
  });

  it('カーソルを使い回して、あとから新しい行が入っても、続きはずれない', async () => {
    const first = await labels('&limit=3');
    expect(first.labels).toEqual(['g', 'f', 'c3']);

    // 取得の途中で、いちばん新しい行が増えた
    const lateId = '11570000-0000-4000-8000-000000000099';
    const { error } = await supabaseAdmin.from('app_logs').insert({
      id: lateId,
      created_at: '2033-03-01T00:00:09+00:00',
      level: 'info',
      source: 'api-route',
      function_name: MARK,
      request_id: `${MARK}-late`,
      message: 'message late',
    });
    expect(error).toBeNull();

    const second = await labels(`&limit=3&cursor=${encodeURIComponent(first.meta.next_cursor!)}`);
    expect(second.labels).toEqual(['c2', 'c1', 'b']); // late は出ない。c3 の重複もない
  });
});

describe('#1157 /super-admin/logs (画面)', () => {
  // 画面は super_admin のレイアウト (src/app/super-admin/layout.tsx) が権限を確かめる。
  // 実際にコンパイルされてサーバーで描画されること (初回のコンパイルで時間がかかるので、時間切れは長めにする) も確かめる
  const openPage = (jwt?: string) =>
    fetch(`${BASE_URL}/super-admin/logs`, {
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      redirect: 'manual',
    });

  it('super_admin は開ける。左メニューの「運用 > アプリログ」と、画面の見出し・絞り込みが出る', async () => {
    const res = await openPage(superAdminUser.jwt);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('href="/super-admin/logs"');
    expect(html).toContain('アプリログ');
    expect(html).toContain('ログの絞り込み');
  }, 120_000);

  it.each([
    ['admin', () => adminUser.jwt],
    ['一般ユーザー', () => generalUser.jwt],
    ['未認証', () => undefined],
  ])('%s は開けず、ログインへ戻される (画面にログの中身は出ない)', async (_label, jwtOf) => {
    const res = await openPage(jwtOf());

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', BASE_URL).pathname).toBe('/login');
    const body = await res.text();
    expect(body).not.toContain(MARK);
    expect(body).not.toContain('ログの絞り込み');
  }, 120_000);
});

describe('#1157 GET /api/super-admin/logs: 入力検証', () => {
  it.each([
    ['level', '&level=fatal'],
    ['user_id', '&user_id=not-a-uuid'],
    ['from', '&from=yesterday'],
    ['to', '&to=2033-02-30T00:00:00Z'],
    ['cursor', '&cursor=not-a-cursor'],
  ])('%s が不正なら 400', async (field, query) => {
    const res = await apiCall<{ error: { code: string; details: { fieldErrors: Record<string, string[]> } } }>(
      'GET',
      `${base}${query}`,
      superAdminUser.jwt,
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details.fieldErrors)).toContain(field);
  });

  it('limit は範囲内に直す (最大 200)', async () => {
    const res = await apiCall<LogsBody>('GET', `${base}&limit=100000`, superAdminUser.jwt);

    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(200);
  });
});
