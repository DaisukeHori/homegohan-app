/**
 * #1432 健康インサイトの保存 (POST /api/health/insights) の実 DB 確認
 *
 * 修正前のルートは、health_insights に無い `content` 列と数値の `priority` を入れ、NOT NULL で既定値の無い
 * analysis_date / period_start / period_end / period_type / summary を入れずに、利用者のセッションのクライアントで
 * insert していた。列が合わないうえ、health_insights には利用者向けの INSERT ポリシーが無いので、insert は必ず失敗していた。
 * 単体テスト (tests/health-insights-route.test.ts / tests/health-insight-rows.test.ts) は Supabase をモックするので、
 * PostgREST が実際に行を受け付けるか (列・型・CHECK・NOT NULL・RLS) は見えない。
 *
 * 確認すること:
 *   - ルートと同じ buildHealthInsightRows の行を、ルートと同じ service_role のクライアントで insert すると成功する
 *   - 保存した行を、本人の JWT (GET /api/health/insights と同じ立場) で読める。他人には見えない
 *   - 修正前の行の形 (content 列・数値の priority・日付なし) は PostgREST に拒否される (このテストが列の食い違いを捕まえる証拠)
 *   - 利用者のセッションのクライアントでは、正しい形の行でも RLS で拒否される (ルートが service_role で保存する理由)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/health-insights-write.test.ts
 * (dev サーバは不要。POST /api/health/insights 自体は LLM を呼ぶので、ここでは保存する行と保存の経路だけを確認する)
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { buildHealthInsightRows, calculateHealthInsightPeriod } from '../../../src/lib/health-insight-rows';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

/** ルートの getSupabaseAdmin() と同じ立場 (service_role) */
const srAdmin = client(serviceKey);

interface TestUser {
  id: string;
  /** その利用者の JWT で RLS を通る client (ルートの createClient() と同じ立場) */
  db: SupabaseClient;
}

const TS = Date.now();
const PASSWORD = `Pw-${randomUUID()}`;
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-insights-write-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `insights-w-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, db: client(anonKey, signIn.data.session.access_token) };
}

/** LLM の応答の形 (ルートの insightSchema)。priority は文字列、本文は summary */
const GENERATED = [
  {
    title: '睡眠時間が短めです',
    summary: '直近の平均睡眠時間は 5.8 時間でした。',
    insight_type: 'sleep',
    is_alert: true,
    priority: 'high',
    recommendations: ['23 時までに寝る', '寝る前の画面を控える'],
  },
  {
    title: '歩数は順調',
    summary: '平均 8,200 歩/日でした。',
    insight_type: 'activity',
    is_alert: false,
    priority: 'low',
    recommendations: [],
  },
];

let owner: TestUser;
let other: TestUser;

beforeAll(async () => {
  owner = await createUser('owner');
  other = await createUser('other');
});

afterAll(async () => {
  // health_insights は auth.users の ON DELETE CASCADE で消える
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
});

describe('#1432 health_insights への保存', () => {
  it('ルートと同じ行を service_role で insert すると成功し、本人の JWT で読める', async () => {
    // 期待値の期間と保存する行の期間を同じ時刻から作る (JST の 0 時をまたいでも食い違わないように)
    const now = new Date();
    const rows = buildHealthInsightRows(owner.id, GENERATED, now);
    expect(rows).toHaveLength(GENERATED.length);

    const { data: inserted, error } = await srAdmin.from('health_insights').insert(rows).select();
    expect(error).toBeNull();
    expect(inserted).toHaveLength(GENERATED.length);

    // GET /api/health/insights と同じ絞り込みで、本人の JWT で読む
    const { data: listed, error: listError } = await owner.db
      .from('health_insights')
      .select('*')
      .eq('user_id', owner.id)
      .eq('is_dismissed', false)
      .order('created_at', { ascending: false });
    expect(listError).toBeNull();
    expect(listed).toHaveLength(GENERATED.length);

    const { analysisDate, periodStart, periodEnd, periodType } = calculateHealthInsightPeriod(now);
    const sleep = listed!.find((row) => row.insight_type === 'sleep');
    expect(sleep).toMatchObject({
      user_id: owner.id,
      analysis_date: analysisDate,
      period_start: periodStart,
      period_end: periodEnd,
      period_type: periodType,
      title: '睡眠時間が短めです',
      summary: '直近の平均睡眠時間は 5.8 時間でした。',
      recommendations: ['23 時までに寝る', '寝る前の画面を控える'],
      priority: 'high',
      is_alert: true,
      is_read: false,
      is_dismissed: false,
    });

    // 未読数・アラート数 (GET の補助情報) も数えられる
    const { count: alertCount, error: alertError } = await owner.db
      .from('health_insights')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', owner.id)
      .eq('is_alert', true)
      .eq('is_dismissed', false);
    expect(alertError).toBeNull();
    expect(alertCount).toBe(1);
  });

  it('他人の JWT では、本人のインサイトは (user_id を指定しても) 見えない', async () => {
    const { data, error } = await other.db.from('health_insights').select('id').eq('user_id', owner.id);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('修正前の行の形 (content 列・数値の priority・日付と summary なし) は PostgREST に拒否される', async () => {
    const legacyRow = {
      user_id: owner.id,
      title: '旧形式',
      content: '本文',
      insight_type: 'trend',
      is_alert: false,
      priority: 1,
      is_read: false,
      is_dismissed: false,
    };
    const { error } = await srAdmin.from('health_insights').insert([legacyRow]).select();
    expect(error).not.toBeNull();
  });

  it('利用者のセッションのクライアントでは、正しい形の行でも RLS で拒否される (INSERT ポリシーが無い)', async () => {
    const rows = buildHealthInsightRows(owner.id, GENERATED.slice(0, 1));
    const { error } = await owner.db.from('health_insights').insert(rows).select();
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });
});
