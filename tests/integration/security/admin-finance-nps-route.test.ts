/**
 * #1217 GET /api/admin/finance/nps — NPS / CSAT 集計 (結合テスト: Next の API ルート + 実 Supabase)
 *
 * 修正前: nps_surveys と csat_feedbacks の該当行を全部読み込み (件数の上限なし)、JavaScript で数えていた。
 * 修正後: 件数・合計・分布は DB の関数 (get_nps_summary / get_csat_summary) が数え、直近の一覧 (recent_comments /
 *   recent_feedbacks) は新しい順に 10 件だけ取る。レスポンスの形と数字は変わらない。
 *
 * #1311: 認可は admin / super_admin だけ。財務ロール (finance) は外した (これまでは通したが、RLS が finance を許しておらず、
 *   NPS 0 件・CSAT は本人の分だけの、誤った集計が返っていた)。一般ユーザーは 403、未認証は 401 のまま。
 *
 * 確認すること (実 DB に種をまいて route を呼ぶ):
 *   - 集計の数字が、修正前の式 (tests/helpers/legacy-nps-summary.ts) で数えた結果と一致する (期間・プランで絞った場合を含む)
 *   - 一覧は新しい順の 10 件だけ (12 件まいても 10 件)。プランで絞ると NPS の一覧と集計だけが絞られ、CSAT は変わらない
 *   - レスポンスの形 (キー) が画面 (src/app/admin/finance/nps/page.tsx) の期待どおり
 *   - 行の無い期間は全部 0 / 空の一覧
 *   - 1000 行 (API の 1 回の応答の最大行数) を超える 1,100 件でも、切り詰めずに正確に数える (修正前は 1000 件で止まった)
 *   - finance だけの人は 403 でデータが返らない / admin と finance の両方を持つ人は 200 / 未認証 401 / 一般ユーザー 403
 *   - #1433: 期間 (from / to) は画面の日付 (YYYY-MM-DD。どちらの日も含む) を JST の暦日として読む。一覧 (.gte / .lt) と
 *     集計の関数 (両端を含む `<= p_to` に、翌日の JST 0 時の 1 マイクロ秒前) が、実 DB (timestamptz の精度 = 1 マイクロ秒) で
 *     同じ行 (JST のその日の 0:00 〜 23:59:59.999999) を選ぶ。存在しない日付・時刻つきの値は 400
 *
 * 関数そのものの SQL・権限・RLS は tests/integration/rls/csat-nps-summary-rpc.test.ts、
 * route の組み立て (モック) は tests/admin-finance-nps-route.test.ts で検証する。
 *
 * 実行 (ローカル Supabase + ローカルの Next dev サーバが必要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   INTEGRATION_BASE_URL=http://localhost:3000 \
 *     npx vitest run --config vitest.integration.config.ts tests/integration/security/admin-finance-nps-route.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { legacyCsatSummary, legacyNpsSummary } from '../../helpers/legacy-nps-summary';

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
const email = (label: string) => `sec-1217-${label}-${TS}@homegohan.test`;
const MARK = `sec-1217-nps-route-${TS}`; // comment の接頭辞。後片付けで「このテストが入れた行だけ」を特定する印
const MARK_ANY = 'sec-1217-nps-route-'; // 前回の実行が途中で落ちて残した行の掃除用

let adminUser: TestUser;
let superAdminUser: TestUser;
let financeUser: TestUser;
let adminFinanceUser: TestUser; // admin と finance の両方を持つ
let generalUser: TestUser; // 一般ユーザー。回答者としても使う
const createdNpsIds: string[] = [];
const createdCsatIds: string[] = [];

// 本物のデータや他のテストと重ならないよう、2032 年の日付を使う。
// 期間は画面と同じ日付 (YYYY-MM-DD。JST の暦日。どちらの日も含む) で渡す (#1433)。
// 3/1〜3/31 は JST 3/1 0:00 (= 2/29 15:00 UTC) 〜 JST 3/31 23:59:59.999999 (= 3/31 14:59:59.999999 UTC)
const PERIOD = { from: '2032-03-01', to: '2032-03-31' };
const EMPTY_PERIOD = { from: '2041-01-01', to: '2041-12-31' };

const day = (n: number) => String(n).padStart(2, '0');

interface NpsSeed {
  index: number;
  score: number;
  planKey: 'pro' | 'free';
  sentAt: string;
  respondedAt: string | null;
  id?: string;
}

interface CsatSeed {
  index: number;
  score: number;
  createdAt: string;
  id?: string;
}

// 回答済みの NPS 12 件 (3/1〜3/12 に送り、同じ日の 12:00 に回答)。新しい回答ほど index が大きい
const NPS_SCORES = [10, 9, 9, 8, 7, 7, 6, 5, 10, 3, 9, 8];
const respondedSeeds: NpsSeed[] = NPS_SCORES.map((score, index) => ({
  index,
  score,
  planKey: index % 3 === 0 ? 'free' : 'pro', // free 4 件・pro 8 件
  sentAt: `2032-03-${day(index + 1)}T00:00:00.000Z`,
  respondedAt: `2032-03-${day(index + 1)}T12:00:00.000Z`,
}));
// 未回答の NPS 3 件 (送信だけ。score 列は NOT NULL なので何かの値が入る)
const unansweredSeeds: NpsSeed[] = [0, 1, 2].map((k) => ({
  index: 100 + k,
  score: 5,
  planKey: 'pro',
  sentAt: `2032-03-${day(13 + k)}T00:00:00.000Z`,
  respondedAt: null,
}));
// CSAT 12 件 (3/1〜3/12)。新しい回答ほど index が大きい
const CSAT_SCORES = [5, 4, 3, 5, 2, 1, 4, 4, 5, 3, 2, 5];
const csatSeeds: CsatSeed[] = CSAT_SCORES.map((score, index) => ({
  index,
  score,
  createdAt: `2032-03-${day(index + 1)}T08:00:00.000Z`,
}));

const periodQuery = (p: { from: string; to: string }, extra = '') =>
  `/api/admin/finance/nps?from=${encodeURIComponent(p.from)}&to=${encodeURIComponent(p.to)}${extra}`;

interface NpsRecent {
  id: string;
  score: number;
  comment: string | null;
  plan_key: string | null;
  responded_at: string | null;
}

interface CsatRecent {
  id: string;
  score: number;
  comment: string | null;
  ticket_id: string | null;
  created_at: string;
}

interface Body {
  data: {
    nps: Record<string, unknown> & { recent_comments: NpsRecent[] };
    csat: Record<string, unknown> & { recent_feedbacks: CsatRecent[]; score_distribution: Record<string, number> };
  };
}

/** 一覧を除いた、集計の数字だけ */
function summaries(body: Body) {
  const { recent_comments: _nps, ...nps } = body.data.nps;
  const { recent_feedbacks: _csat, ...csat } = body.data.csat;
  void _nps;
  void _csat;
  return { nps, csat };
}

beforeAll(async () => {
  // 前回の実行が途中で落ちて残した行を掃除する
  await supabaseAdmin.from('nps_surveys').delete().like('comment', `${MARK_ANY}%`);
  await supabaseAdmin.from('csat_feedbacks').delete().like('comment', `${MARK_ANY}%`);

  [adminUser, superAdminUser, financeUser, adminFinanceUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: email('admin'), roles: ['admin'] }),
    createTestUserWithRoles({ email: email('superadmin'), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: email('finance'), roles: ['finance'] }),
    createTestUserWithRoles({ email: email('adminfinance'), roles: ['admin', 'finance'] }),
    createTestUserWithRoles({ email: email('general'), roles: ['user'] }),
  ]);

  for (const seed of [...respondedSeeds, ...unansweredSeeds]) {
    const { data, error } = await supabaseAdmin
      .from('nps_surveys')
      .insert({
        user_id: generalUser.userId,
        score: seed.score,
        comment: `${MARK} nps ${seed.index}`,
        plan_key: seed.planKey,
        sent_at: seed.sentAt,
        responded_at: seed.respondedAt,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`nps_surveys insert: ${error?.message}`);
    seed.id = data.id as string;
    createdNpsIds.push(seed.id);
  }
  for (const seed of csatSeeds) {
    const { data, error } = await supabaseAdmin
      .from('csat_feedbacks')
      .insert({
        user_id: generalUser.userId,
        score: seed.score,
        comment: `${MARK} csat ${seed.index}`,
        created_at: seed.createdAt,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`csat_feedbacks insert: ${error?.message}`);
    seed.id = data.id as string;
    createdCsatIds.push(seed.id);
  }

  // dev サーバの初回コンパイルを済ませておく (各テストの時間切れを避ける)
  await apiCall('GET', periodQuery(EMPTY_PERIOD), adminUser.jwt);
}, 240_000);

afterAll(async () => {
  // 外部キー (user_id → auth.users、ON DELETE なし) があるため、行を先に消してからユーザーを消す
  if (createdNpsIds.length > 0) await supabaseAdmin.from('nps_surveys').delete().in('id', createdNpsIds);
  if (createdCsatIds.length > 0) await supabaseAdmin.from('csat_feedbacks').delete().in('id', createdCsatIds);
  await supabaseAdmin.from('nps_surveys').delete().like('comment', `${MARK}%`);
  await supabaseAdmin.from('csat_feedbacks').delete().like('comment', `${MARK}%`);
  await Promise.all(
    [adminUser, superAdminUser, financeUser, adminFinanceUser, generalUser]
      .filter(Boolean)
      .map((u) => cleanupTestUser(u.userId)),
  );
}, 90_000);

// ================================================================
// 集計の数字
// ================================================================
describe('#1217 GET /api/admin/finance/nps: 集計の数字は修正前の式と一致する', () => {
  it('N-1: admin — 期間を指定した NPS / CSAT の数字が、修正前の式で数えた値と一致する', async () => {
    const res = await apiCall<Body>('GET', periodQuery(PERIOD), adminUser.jwt);
    expect(res.status).toBe(200);
    const { nps, csat } = summaries(res.body);

    expect(nps).toEqual(
      legacyNpsSummary(
        respondedSeeds,
        respondedSeeds.length + unansweredSeeds.length, // 送信数は未回答を含む (15)
      ),
    );
    expect(csat).toEqual(legacyCsatSummary(csatSeeds));

    // 手で数えた値も確かめる (修正前の式と関数が揃って間違っていないこと)
    expect(nps).toMatchObject({ total_responses: 12, promoters: 5, passives: 4, detractors: 3, response_rate: 80 });
    expect(csat).toMatchObject({
      total_responses: 12,
      score_distribution: { '1': 1, '2': 2, '3': 2, '4': 3, '5': 4 },
    });
  });

  it('N-2: super_admin も同じ数字を得る', async () => {
    const admin = await apiCall<Body>('GET', periodQuery(PERIOD), adminUser.jwt);
    const superAdmin = await apiCall<Body>('GET', periodQuery(PERIOD), superAdminUser.jwt);
    expect(superAdmin.status).toBe(200);
    expect(summaries(superAdmin.body)).toEqual(summaries(admin.body));
  });

  it('N-3: plan_key で絞ると、NPS の集計・一覧だけが絞られ、CSAT は変わらない', async () => {
    const all = await apiCall<Body>('GET', periodQuery(PERIOD), adminUser.jwt);
    const pro = await apiCall<Body>('GET', periodQuery(PERIOD, '&plan_key=pro'), adminUser.jwt);
    expect(pro.status).toBe(200);

    const proResponded = respondedSeeds.filter((s) => s.planKey === 'pro');
    const proSent = proResponded.length + unansweredSeeds.filter((s) => s.planKey === 'pro').length; // 8 + 3
    expect(summaries(pro.body).nps).toEqual(legacyNpsSummary(proResponded, proSent));
    expect(pro.body.data.nps.recent_comments.every((r) => r.plan_key === 'pro')).toBe(true);
    expect(pro.body.data.nps.recent_comments).toHaveLength(proResponded.length);

    expect(summaries(pro.body).csat).toEqual(summaries(all.body).csat);
    expect(pro.body.data.csat.recent_feedbacks).toEqual(all.body.data.csat.recent_feedbacks);
  });

  it('N-4: 期間は NPS が送信日 (sent_at)、CSAT が作成日 (created_at)。3/1〜3/6 に絞ると、その分だけ数える', async () => {
    // JST 3/1 0:00 〜 3/6 23:59:59.999999 (= 3/6 14:59:59.999999 UTC)。3/7 00:00 (UTC) に送った分は入らない
    const res = await apiCall<Body>('GET', periodQuery({ from: '2032-03-01', to: '2032-03-06' }), adminUser.jwt);
    expect(res.status).toBe(200);
    const early = respondedSeeds.filter((s) => s.index < 6); // 3/1〜3/6 に送ったもの。未回答の 3 件 (3/13〜) は期間の外
    expect(summaries(res.body).nps).toEqual(legacyNpsSummary(early, early.length));
    expect(summaries(res.body).csat).toEqual(legacyCsatSummary(csatSeeds.filter((s) => s.index < 6)));
  });

  it('N-5: 行の無い期間は、全部 0 と空の一覧', async () => {
    const res = await apiCall<Body>('GET', periodQuery(EMPTY_PERIOD), adminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      nps: {
        total_responses: 0,
        promoters: 0,
        passives: 0,
        detractors: 0,
        nps_score: 0,
        avg_score: 0,
        response_rate: 0,
        recent_comments: [],
      },
      csat: {
        total_responses: 0,
        avg_score: 0,
        score_distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
        recent_feedbacks: [],
      },
    });
  });
});

// ================================================================
// 直近の一覧
// ================================================================
describe('#1217 GET /api/admin/finance/nps: 直近の一覧は新しい順の 10 件だけ', () => {
  it('L-1: NPS は 12 件まいても 10 件で、回答日の新しい順', async () => {
    const res = await apiCall<Body>('GET', periodQuery(PERIOD), adminUser.jwt);
    const recent = res.body.data.nps.recent_comments;
    expect(recent).toHaveLength(10);
    // 新しいほうから 10 件 = index 11, 10, ..., 2
    const expected = [...respondedSeeds].sort((a, b) => b.index - a.index).slice(0, 10);
    expect(recent.map((r) => r.id)).toEqual(expected.map((s) => s.id));
    expect(recent[0]).toEqual({
      id: respondedSeeds[11].id,
      score: 8,
      comment: `${MARK} nps 11`,
      plan_key: 'pro',
      responded_at: expect.stringMatching(/^2032-03-12T12:00:00/),
    });
  });

  it('L-2: CSAT は 12 件まいても 10 件で、作成日の新しい順', async () => {
    const res = await apiCall<Body>('GET', periodQuery(PERIOD), adminUser.jwt);
    const recent = res.body.data.csat.recent_feedbacks;
    expect(recent).toHaveLength(10);
    const expected = [...csatSeeds].sort((a, b) => b.index - a.index).slice(0, 10);
    expect(recent.map((r) => r.id)).toEqual(expected.map((s) => s.id));
    expect(recent[0]).toEqual({
      id: csatSeeds[11].id,
      score: 5,
      comment: `${MARK} csat 11`,
      ticket_id: null,
      created_at: expect.stringMatching(/^2032-03-12T08:00:00/),
    });
  });

  it('L-3: 未回答の送信は NPS の一覧に出ない (回答済みだけ)', async () => {
    const res = await apiCall<Body>('GET', periodQuery(PERIOD), adminUser.jwt);
    const unansweredIds = new Set(unansweredSeeds.map((s) => s.id));
    expect(res.body.data.nps.recent_comments.some((r) => unansweredIds.has(r.id))).toBe(false);
    expect(res.body.data.nps.recent_comments.every((r) => r.responded_at !== null)).toBe(true);
  });
});

// ================================================================
// レスポンスの形
// ================================================================
describe('#1217 GET /api/admin/finance/nps: レスポンスの形 (画面が使うキー)', () => {
  it('S-1: data.nps / data.csat のキーが以前と同じ', async () => {
    const res = await apiCall<Body>('GET', periodQuery(PERIOD), adminUser.jwt);
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(res.body.data).sort()).toEqual(['csat', 'nps']);
    expect(Object.keys(res.body.data.nps).sort()).toEqual([
      'avg_score',
      'detractors',
      'nps_score',
      'passives',
      'promoters',
      'recent_comments',
      'response_rate',
      'total_responses',
    ]);
    expect(Object.keys(res.body.data.csat).sort()).toEqual([
      'avg_score',
      'recent_feedbacks',
      'score_distribution',
      'total_responses',
    ]);
    expect(Object.keys(res.body.data.csat.score_distribution).sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(Object.keys(res.body.data.nps.recent_comments[0]).sort()).toEqual([
      'comment',
      'id',
      'plan_key',
      'responded_at',
      'score',
    ]);
    expect(Object.keys(res.body.data.csat.recent_feedbacks[0]).sort()).toEqual([
      'comment',
      'created_at',
      'id',
      'score',
      'ticket_id',
    ]);
  });
});

// ================================================================
// 認可
// ================================================================
describe('#1217 / #1311 GET /api/admin/finance/nps: 認可は admin / super_admin だけ', () => {
  it('A-1: 一般ユーザーは 403', async () => {
    const res = await apiCall('GET', periodQuery(PERIOD), generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('A-2: 未認証は 401', async () => {
    const res = await apiCallNoAuth('GET', periodQuery(PERIOD));
    expect(res.status).toBe(401);
  });

  it('A-3: 財務ロール (finance) だけの人は 403。NPS / CSAT のデータは返らない (#1311)', async () => {
    const res = await apiCall('GET', periodQuery(PERIOD), financeUser.jwt);
    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('OP_PERMISSION_DENIED');
    expect(JSON.stringify(res.body)).not.toContain('recent_comments');
    expect(JSON.stringify(res.body)).not.toContain(MARK);
  });

  it('A-4: admin と finance の両方を持つ人は 200 (finance を外しても admin の権限は残る)', async () => {
    const admin = await apiCall<Body>('GET', periodQuery(PERIOD), adminUser.jwt);
    const both = await apiCall<Body>('GET', periodQuery(PERIOD), adminFinanceUser.jwt);
    expect(both.status).toBe(200);
    expect(summaries(both.body)).toEqual(summaries(admin.body));
  });
});

// ================================================================
// 件数が多いとき (API の 1 回の応答で返す最大行数 = 既定 1000 行 を超える)
// ================================================================
// 修正前は該当行を全部取って JavaScript で数えていたので、1000 行を超えると 1000 行ぶんしか数えなかった
// (エラーも出ず、回答数だけ 1000 で止まり、回答率が 100% にならない)。修正後は DB の関数が数えるので切り詰められない。
// 他の検証の数字が狂わないよう、このブロックの中でだけ行を入れ、終わったら消す (日付は 2036 年 6 月)。
const BULK_ROWS = 1100; // CSAT の 5 点 (5 × 220)・NPS の 0〜10 点 (11 × 100) に割り切れる
const BULK_PERIOD = { from: '2036-06-01', to: '2036-06-30' };
const MARK_BULK = `${MARK} bulk`;

describe('#1217 GET /api/admin/finance/nps: 1000 行を超えても切り詰めずに数える', () => {
  beforeAll(async () => {
    const start = Date.UTC(2036, 5, 1);
    const csat = Array.from({ length: BULK_ROWS }, (_, i) => ({
      user_id: generalUser.userId,
      score: 1 + (i % 5),
      comment: MARK_BULK,
      created_at: new Date(start + i * 60_000).toISOString(),
    }));
    const nps = Array.from({ length: BULK_ROWS }, (_, i) => ({
      user_id: generalUser.userId,
      score: i % 11,
      comment: MARK_BULK,
      plan_key: 'pro',
      sent_at: new Date(start + i * 60_000).toISOString(),
      responded_at: new Date(start + i * 60_000 + 30_000).toISOString(),
    }));
    const csatInsert = await supabaseAdmin.from('csat_feedbacks').insert(csat);
    if (csatInsert.error) throw new Error(`csat_feedbacks bulk insert: ${csatInsert.error.message}`);
    const npsInsert = await supabaseAdmin.from('nps_surveys').insert(nps);
    if (npsInsert.error) throw new Error(`nps_surveys bulk insert: ${npsInsert.error.message}`);
  }, 120_000);

  afterAll(async () => {
    await supabaseAdmin.from('csat_feedbacks').delete().eq('comment', MARK_BULK);
    await supabaseAdmin.from('nps_surveys').delete().eq('comment', MARK_BULK);
  }, 120_000);

  it('B-1: 1,100 件の CSAT / NPS を、件数・平均・分布・回答率まで正確に返す (一覧は 10 件)', async () => {
    const res = await apiCall<Body>('GET', periodQuery(BULK_PERIOD), adminUser.jwt);
    expect(res.status).toBe(200);
    const { nps, csat } = summaries(res.body);

    expect(nps).toEqual({
      total_responses: 1100,
      promoters: 200, // 9, 10 が 100 回ずつ
      passives: 200, // 7, 8 が 100 回ずつ
      detractors: 700, // 0〜6 が 100 回ずつ
      nps_score: -45.5, // (200 - 700) / 1100 × 100
      avg_score: 5,
      response_rate: 100, // 回答 1100 / 送信 1100
    });
    expect(csat).toEqual({
      total_responses: 1100,
      avg_score: 3,
      score_distribution: { '1': 220, '2': 220, '3': 220, '4': 220, '5': 220 },
    });
    expect(res.body.data.nps.recent_comments).toHaveLength(10);
    expect(res.body.data.csat.recent_feedbacks).toHaveLength(10);
  });

  it('B-2: 一覧は最新の 10 件 (回答日・作成日の新しい順)', async () => {
    const res = await apiCall<Body>('GET', periodQuery(BULK_PERIOD), adminUser.jwt);
    const npsTimes = res.body.data.nps.recent_comments.map((r) => r.responded_at as string);
    const csatTimes = res.body.data.csat.recent_feedbacks.map((r) => r.created_at);
    // 最新は 1099 分目。回答日 (送信の 30 秒後) 2036-06-01 18:19:30、作成日 18:19:00 (UTC)
    expect(npsTimes[0]).toMatch(/^2036-06-01T18:19:30/);
    expect(csatTimes[0]).toMatch(/^2036-06-01T18:19:00/);
    expect([...npsTimes].sort().reverse()).toEqual(npsTimes);
    expect([...csatTimes].sort().reverse()).toEqual(csatTimes);
  });
});

// ================================================================
// 期間は JST の暦日 (#1433)
// ================================================================
// 以前は日付の文字列をそのまま .gte / .lte と関数の p_from / p_to に渡していたので、DB は UTC の 0 時 (= JST 9 時) と読み、
// from = to = 5/1 では JST 5/1 9:00 ちょうどの行しか数えなかった (JST 0:00〜8:59 と 9:00 より後の行が落ちた)。
// 今は一覧が JST 5/1 0 時以上・5/2 0 時未満、集計の関数が JST 5/1 0 時以上・5/1 23:59:59.999999 以下。
// timestamptz の精度は 1 マイクロ秒なので、どちらも同じ行を選ぶ (境界の行を実 DB に入れて確かめる)。
// 他の検証の数字が狂わないよう、このブロックの中でだけ行を入れ、終わったら消す (日付は 2033 年 5 月)。
const MARK_JST = `${MARK} jst`;
const JST_DAY = '2033-05-01';
const JST_BOUNDARY_ROWS = [
  { label: 'JST 4/30 23:59:59.999999', at: '2033-04-30T14:59:59.999999Z', inside: false },
  { label: 'JST 5/1 0:00', at: '2033-04-30T15:00:00.000000Z', inside: true },
  { label: 'JST 5/1 8:59:59', at: '2033-04-30T23:59:59.000000Z', inside: true },
  { label: 'JST 5/1 9:00', at: '2033-05-01T00:00:00.000000Z', inside: true },
  { label: 'JST 5/1 23:59:59.999999', at: '2033-05-01T14:59:59.999999Z', inside: true },
  { label: 'JST 5/2 0:00', at: '2033-05-01T15:00:00.000000Z', inside: false },
  { label: 'JST 5/2 8:59:59', at: '2033-05-01T23:59:59.000000Z', inside: false },
] as const;
// 中の行は NPS 10 点 (推奨者)・CSAT 5 点、外の行は NPS 0 点 (批判者)・CSAT 1 点。外の行が 1 つでも混ざると数字が変わる
const INSIDE_COUNT = JST_BOUNDARY_ROWS.filter((r) => r.inside).length;

describe('#1433 GET /api/admin/finance/nps: 期間は JST の暦日 (一覧と集計が同じ行を数える)', () => {
  const npsIdsByLabel = new Map<string, string>();
  const csatIdsByLabel = new Map<string, string>();

  beforeAll(async () => {
    for (const row of JST_BOUNDARY_ROWS) {
      const nps = await supabaseAdmin
        .from('nps_surveys')
        .insert({
          user_id: generalUser.userId,
          score: row.inside ? 10 : 0,
          comment: `${MARK_JST} ${row.label}`,
          plan_key: 'pro',
          sent_at: row.at,
          responded_at: row.at,
        })
        .select('id')
        .single();
      if (nps.error || !nps.data) throw new Error(`nps_surveys insert: ${nps.error?.message}`);
      npsIdsByLabel.set(row.label, nps.data.id as string);
      const csat = await supabaseAdmin
        .from('csat_feedbacks')
        .insert({ user_id: generalUser.userId, score: row.inside ? 5 : 1, comment: `${MARK_JST} ${row.label}`, created_at: row.at })
        .select('id')
        .single();
      if (csat.error || !csat.data) throw new Error(`csat_feedbacks insert: ${csat.error?.message}`);
      csatIdsByLabel.set(row.label, csat.data.id as string);
    }
  }, 120_000);

  afterAll(async () => {
    await supabaseAdmin.from('nps_surveys').delete().like('comment', `${MARK_JST}%`);
    await supabaseAdmin.from('csat_feedbacks').delete().like('comment', `${MARK_JST}%`);
  }, 120_000);

  it('J-1: from = to = 5/1 は、JST 5/1 0:00 〜 23:59:59.999999 の行だけを数える (JST 0:00 ちょうど・8:59:59・23:59:59.999999 は入り、前日の 23:59:59.999999・翌日の 0:00 は入らない)', async () => {
    const res = await apiCall<Body>('GET', periodQuery({ from: JST_DAY, to: JST_DAY }), adminUser.jwt);
    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    const { nps, csat } = summaries(res.body);

    // 集計 (DB の関数。両端を含む `<= p_to`)
    expect(nps).toMatchObject({ total_responses: INSIDE_COUNT, promoters: INSIDE_COUNT, detractors: 0, response_rate: 100 });
    expect(csat).toMatchObject({
      total_responses: INSIDE_COUNT,
      score_distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': INSIDE_COUNT },
    });

    // 一覧 (.gte / .lt)。集計と同じ行
    const insideNpsIds = JST_BOUNDARY_ROWS.filter((r) => r.inside).map((r) => npsIdsByLabel.get(r.label));
    const insideCsatIds = JST_BOUNDARY_ROWS.filter((r) => r.inside).map((r) => csatIdsByLabel.get(r.label));
    expect(res.body.data.nps.recent_comments.map((r) => r.id).sort()).toEqual([...insideNpsIds].sort());
    expect(res.body.data.csat.recent_feedbacks.map((r) => r.id).sort()).toEqual([...insideCsatIds].sort());
  });

  it('J-2: 4/30 〜 5/1 は、JST 4/30 23:59:59.999999 も入り、JST 5/2 0:00・8:59:59 は入らない (関数の `<= p_to` と一覧の .lt が一致する)', async () => {
    // 開始日を 4/30 にすると、前日の 23:59:59.999999 の行 (批判者) も入る。外の行のうち翌日の 2 行だけが落ちる
    const res = await apiCall<Body>('GET', periodQuery({ from: '2033-04-30', to: JST_DAY }), adminUser.jwt);
    expect(res.status).toBe(200);
    const { nps } = summaries(res.body);
    expect(nps).toMatchObject({ total_responses: INSIDE_COUNT + 1, promoters: INSIDE_COUNT, detractors: 1 });
    expect(res.body.data.nps.recent_comments).toHaveLength(INSIDE_COUNT + 1);
    expect(res.body.data.nps.recent_comments.map((r) => r.id)).not.toContain(npsIdsByLabel.get('JST 5/2 0:00'));
  });

  it.each(['2033-02-30', '2033/05/01', '2033-05-01T00:00:00Z', 'not-a-date'])(
    'J-3: 存在しない日付・形の違う日付・時刻つきの値 (from=%s) は 400 (VALIDATION_ERROR)',
    async (from) => {
      const res = await apiCall('GET', `/api/admin/finance/nps?from=${encodeURIComponent(from)}`, adminUser.jwt);
      expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(400);
      expect((res.body as { error?: { code?: string } }).error?.code).toBe('VALIDATION_ERROR');
    },
  );
});
