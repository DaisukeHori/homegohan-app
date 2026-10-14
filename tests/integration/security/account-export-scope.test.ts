/**
 * #1131 個人データエクスポート (GET /api/account/export) が、実 DB (RLS) でも本人の行だけを出すことの回帰テスト
 *
 * ユニットテスト (tests/account-export*.test.ts) は PostgREST の再現 (fake) の上で検証している。
 * このテストは本物の PostgREST + RLS に対して、次を確かめる:
 *   - 許可リストの全テーブル (約 50 表) の問い合わせが、本物のスキーマで成功する
 *     (列名・外部キーによる !inner 結合・user_badges の badges 埋め込み・count: exact)
 *   - 全テーブルに本人の行が 1 件以上出る (= 本人が読める RLS ポリシーがある。空の出力に気づけるように全表に種を入れる)
 *   - 他人 (B) の行は 1 件も出ない。RLS 上は他人の行が読める表 (公開レシピ・公開コレクション・同じ組織の参加者・
 *     同じ家族のメンバー) でも、運営ロール (support) が RLS で全員の問い合わせを読める表でも
 *   - 秘密 / 内部の列 (Stripe の ID・運営の備考・内部メモ・担当者 ID) は出ない
 *   - API (Bearer 認証。モバイルアプリと同じ呼び方) が 200 / 401 / 429 を返し、ダウンロード用のヘッダーが付く
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/account-export-scope.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { ACCOUNT_EXPORT_TABLES } from '@/lib/account-export-tables';
import { generateAccountExport, type AccountExportSupabase } from '@/lib/account-export';

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
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
/** 本番の createClient() と同じ: 利用者の JWT を Authorization に載せた anon クライアント (RLS が効く) */
const asUser = (jwt: string) => client(anonKey, jwt);

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const RUN = Date.now();
/** ページングの確認用に入れる行数 (PostgREST の 1 回あたり最大 1000 行を超える) */
const PAGER_ROWS = 2300;
const PASSWORD = 'TestPass!2026-export';
const createdUserIds: string[] = [];

async function must<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as T;
}

async function insert<T = Record<string, unknown>>(table: string, row: Record<string, unknown>): Promise<T & { id: string }> {
  return must(`insert ${table}`, srAdmin.from(table).insert(row).select().single()) as Promise<T & { id: string }>;
}

async function createUser(label: string, roles: string[] = ['user']): Promise<TestUser> {
  const email = `export-scope-${label.toLowerCase()}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);

  await insert('user_profiles', {
    id: data.user.id,
    nickname: `NICK-${label}-${RUN}`,
    age_group: '30s',
    gender: 'other',
    goal_text: `GOAL-${label}-${RUN}`,
    roles,
  });
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

let A: TestUser;
let B: TestUser;
let STAFF: TestUser;
let LIMITED: TestUser;
let PAGER: TestUser;

// 後片付け用に作った行の ID
const created = {
  systemRecipeId: '',
  organizationId: '',
  challengeId: '',
  couponId: '',
  announcementId: '',
  familyGroupId: '',
};

let bPublicRecipeId = '';
let aTicketId = '';

/** 本人 (tag) の行を、許可リストの全テーブルに 1 件以上作る。マーカー文字列にユーザー名と RUN を入れる */
async function seedUser(user: TestUser, tag: 'A' | 'B') {
  const mark = (name: string) => `${name}-${tag}-${RUN}`;
  const uid = user.id;
  const today = '2026-10-05';

  await insert('notification_preferences', { user_id: uid });
  await insert('nutrition_targets', { user_id: uid, daily_calories: tag === 'A' ? 2000 : 1500 });

  const meal = await insert('meals', { user_id: uid, eaten_at: new Date().toISOString(), meal_type: 'dinner', memo: mark('MEMO') });
  await insert('meal_ai_feedbacks', { meal_id: meal.id, feedback_text: mark('FEEDBACK') });
  await insert('meal_nutrition_estimates', { meal_id: meal.id, energy_kcal: 500 });

  const request = await insert('weekly_menu_requests', {
    user_id: uid,
    start_date: today,
    prompt: mark('PROMPT'),
    result_json: { marker: mark('RESULT-JSON') },
    worker_id: mark('WORKER'),
  });
  await insert('weekly_menus', { request_id: request.id, user_id: uid, start_date: today, content: { marker: mark('MENU') } });

  const day = await insert('user_daily_meals', { user_id: uid, day_date: today });
  await insert('planned_meals', { daily_meal_id: day.id, meal_type: 'lunch', dish_name: mark('DISH-1') });
  await insert('planned_meals', { daily_meal_id: day.id, meal_type: 'dinner', dish_name: mark('DISH-2') });

  await insert('pantry_items', { user_id: uid, name: mark('PANTRY') });
  const list = await insert('shopping_lists', { user_id: uid, start_date: today, end_date: '2026-10-11' });
  await insert('shopping_list_items', { shopping_list_id: list.id, item_name: mark('ITEM') });

  // B のレシピ / コレクションは公開 (A の RLS でも読める)。A のは非公開
  const recipe = await insert('recipes', { user_id: uid, name: mark('RECIPE'), is_public: tag === 'B' });
  const collection = await insert('recipe_collections', { user_id: uid, name: mark('COLLECTION'), is_public: tag === 'B' });
  await insert('recipe_collection_items', { collection_id: collection.id, recipe_id: recipe.id });
  if (tag === 'B') bPublicRecipeId = recipe.id;
  // A は B の公開レシピに「いいね」・コメント・通報をする (相手のレシピ ID は A の行に残るが、B のデータではない)
  const targetRecipe = tag === 'A' ? bPublicRecipeId : recipe.id;
  await insert('recipe_likes', { user_id: uid, recipe_id: targetRecipe });
  await insert('recipe_comments', { user_id: uid, recipe_id: targetRecipe, content: mark('COMMENT') });
  await insert('recipe_flags', { reporter_id: uid, recipe_id: targetRecipe, reason: mark('FLAG'), reviewed_by: STAFF.id });
  await insert('recipe_requests', { user_id: uid });

  await insert('health_records', { user_id: uid, record_date: today, weight: tag === 'A' ? 60 : 99, daily_note: mark('NOTE') });
  await insert('health_goals', { user_id: uid, goal_type: 'weight', target_value: 55, target_unit: 'kg', note: mark('GOAL') });
  const checkup = await insert('health_checkups', { user_id: uid, checkup_date: today, facility_name: mark('FACILITY') });
  await insert('health_checkup_longitudinal_reviews', { user_id: uid, checkup_ids: [checkup.id] });
  const blood = await insert('blood_test_results', { user_id: uid, test_date: today, test_facility: mark('LAB') });
  await insert('blood_test_longitudinal_reviews', { user_id: uid, blood_test_ids: [blood.id] });
  await insert('health_insights', {
    user_id: uid,
    analysis_date: today,
    period_start: today,
    period_end: today,
    period_type: 'weekly',
    insight_type: 'nutrition',
    title: mark('INSIGHT'),
    summary: 'summary',
  });
  await insert('health_streaks', { user_id: uid, streak_type: 'record' });
  await insert('health_challenges', {
    user_id: uid,
    challenge_type: 'steps',
    title: mark('CHALLENGE'),
    start_date: today,
    end_date: '2026-10-11',
    target_metric: 'steps',
    target_value: 10000,
    target_unit: 'steps',
  });
  await insert('daily_activity_logs', { user_id: uid, date: today, steps: 1234 });
  await insert('user_performance_checkins', { user_id: uid, checkin_date: today, note: mark('CHECKIN') });
  await insert('performance_plans', {
    user_id: uid,
    start_date: today,
    adjustment_type: 'calories',
    adjustment_value: { delta: 100 },
    rationale: mark('RATIONALE'),
  });

  const session = await insert('ai_consultation_sessions', { user_id: uid, title: mark('SESSION') });
  const message = await insert('ai_consultation_messages', { session_id: session.id, role: 'user', content: mark('CHAT') });
  await insert('ai_action_logs', {
    session_id: session.id,
    message_id: message.id,
    action_type: 'update_meal',
    action_params: { marker: mark('ACTION') },
  });

  // user_badges は主キーが (user_id, badge_id) で id 列を持たない
  const badge = await must<{ id: string }>('select badges', srAdmin.from('badges').select('id').limit(1).single());
  await must('insert user_badges', srAdmin.from('user_badges').insert({ user_id: uid, badge_id: badge.id, message: mark('BADGE') }));

  await insert('terms_acceptances', { user_id: uid, document_type: 'terms_of_service', document_version: 'v1', ip_address: '203.0.113.1' });
  await insert('cookie_consents', { user_id: uid, analytics: true });
  await insert('external_data_consents', { user_id: uid, provider: 'xai', consented: true });
  const subscription = await insert('personal_subscriptions', {
    user_id: uid,
    plan_key: 'pro',
    stripe_customer_id: mark('cus'),
    stripe_subscription_id: mark('sub'),
    stripe_price_id: mark('price'),
    notes: mark('STAFF-NOTE'),
  });
  await insert('coupon_redemptions', {
    coupon_id: created.couponId,
    user_id: uid,
    subscription_target: 'personal',
    applied_to_subscription_id: subscription.id,
    discount_amount_jpy: 100,
    approved_by: STAFF.id,
  });
  await insert('gdpr_deletion_requests', { user_id: uid, notes: mark('GDPR-NOTE'), executed_by: STAFF.id });
  await must('announcement_reads', srAdmin.from('announcement_reads').insert({ user_id: uid, announcement_id: created.announcementId }));
  await insert('csat_feedbacks', { user_id: uid, score: 5, comment: mark('CSAT') });
  await insert('inquiries', {
    user_id: uid,
    inquiry_type: 'general',
    email: user.email,
    subject: mark('INQUIRY'),
    message: 'message',
    admin_notes: mark('ADMIN-NOTE'),
  });

  const ticket = await insert('support_tickets', {
    user_id: uid,
    subject: mark('TICKET'),
    category: 'bug',
    assignee_id: STAFF.id,
  });
  if (tag === 'A') aTicketId = ticket.id;
  await insert('support_ticket_messages', { ticket_id: ticket.id, sender_id: uid, body: mark('ASKS') });
  await insert('support_ticket_messages', { ticket_id: ticket.id, sender_id: STAFF.id, body: mark('SUPPORT-REPLY') });
  await insert('support_ticket_messages', { ticket_id: ticket.id, sender_id: STAFF.id, body: mark('INTERNAL-NOTE'), is_internal: true });

  await insert('organization_challenge_participants', { challenge_id: created.challengeId, user_id: uid });
}

/** 利用者の JWT で動く Supabase クライアントを使って、エクスポートを最後まで取得して JSON にする */
async function exportAs(user: TestUser) {
  const generator = generateAccountExport(asUser(user.jwt) as unknown as AccountExportSupabase, user.id);
  const chunks: string[] = [];
  for (;;) {
    const step = await generator.next();
    if (step.done) break;
    chunks.push(step.value);
  }
  const text = chunks.join('');
  return { text, json: JSON.parse(text) as ExportJson };
}

interface ExportJson {
  format: string;
  user_id: string;
  data: Record<string, Array<Record<string, unknown>>>;
  summary: { complete: boolean; row_counts: Record<string, number>; truncated_tables: unknown[]; skipped_tables: unknown[] };
}

beforeAll(async () => {
  [A, B, STAFF, LIMITED, PAGER] = await Promise.all([
    createUser('A'),
    createUser('B'),
    createUser('STAFF', ['support']),
    createUser('LIMITED'),
    createUser('PAGER'),
  ]);

  // 共有の行 (組織 + チャレンジ / 家族 / クーポン / お知らせ)
  const org = await insert('organizations', { name: `ORG-${RUN}` });
  created.organizationId = org.id;
  for (const u of [A, B]) {
    await must(
      'join org',
      srAdmin.from('user_profiles').update({ organization_id: org.id, org_role: 'member' }).eq('id', u.id),
    );
  }
  const challenge = await insert('organization_challenges', {
    organization_id: org.id,
    title: `CHALLENGE-${RUN}`,
    challenge_type: 'custom',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
  });
  created.challengeId = challenge.id;

  const coupon = await insert('coupons', {
    code: `CPN-${RUN}`,
    discount_type: 'fixed',
    discount_value: 100,
    valid_from: new Date().toISOString(),
    valid_until: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    created_by: STAFF.id,
  });
  created.couponId = coupon.id;
  const announcement = await insert('announcements', { title: `ANNOUNCEMENT-${RUN}`, content: 'content', created_by: STAFF.id });
  created.announcementId = announcement.id;

  // B が代表者の家族に A が入っている (RLS では A に B のメンバー行・家族グループが見える)
  const family = await insert('family_groups', { name: `FAMILY-B-${RUN}`, representative_id: B.id });
  created.familyGroupId = family.id;
  await insert('family_members', { family_id: family.id, user_id: B.id, role: 'representative', display_name: `MEMBER-B-${RUN}` });
  await insert('family_members', { family_id: family.id, user_id: A.id, role: 'adult', display_name: `MEMBER-A-${RUN}` });

  // システムのレシピ (user_id IS NULL, 公開)
  const systemRecipe = await insert('recipes', { user_id: null, name: `SYSTEM-RECIPE-${RUN}`, is_public: true });
  created.systemRecipeId = systemRecipe.id;
  // 匿名の Cookie 同意 (user_id IS NULL)
  await insert('cookie_consents', { user_id: null, session_id: `ANON-SESSION-${RUN}` });

  // B を先に (A が B の公開レシピ ID を使うため)
  await seedUser(B, 'B');
  await seedUser(A, 'A');

  // 運営ロールのユーザー自身の行 (問い合わせ・チケット)
  await insert('support_tickets', { user_id: STAFF.id, subject: `STAFF-OWN-TICKET-${RUN}`, category: 'other' });
  await insert('inquiries', { user_id: STAFF.id, inquiry_type: 'general', email: STAFF.email, subject: `STAFF-OWN-INQUIRY-${RUN}`, message: 'm' });

  // ページングの確認用: 1 ページ (1000 行) を超える件数。B にも同数の行を入れ、混ざらないことも見る
  for (const [owner, tag] of [[PAGER, 'PAGER'], [B, 'B']] as const) {
    for (let start = 0; start < PAGER_ROWS; start += 1000) {
      const rows = Array.from({ length: Math.min(1000, PAGER_ROWS - start) }, (_, i) => ({
        user_id: owner.id,
        name: `BULK-${tag}-${String(start + i).padStart(5, '0')}-${RUN}`,
      }));
      await must('insert bulk pantry_items', srAdmin.from('pantry_items').insert(rows));
    }
  }
}, 120_000);

afterAll(async () => {
  const ids = createdUserIds;
  // ルートが書いたアプリログ (ユーザー削除で user_id が NULL になる前に消す)
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (ids.length > 0) await srAdmin.from('app_logs').delete().in('user_id', ids);

  // ON DELETE の無い外部キーを持つ行を先に消す
  if (created.challengeId) {
    await srAdmin.from('organization_challenge_participants').delete().eq('challenge_id', created.challengeId);
    await srAdmin.from('organization_challenges').delete().eq('id', created.challengeId);
  }
  if (created.couponId) {
    await srAdmin.from('coupon_redemptions').delete().eq('coupon_id', created.couponId);
    await srAdmin.from('coupons').delete().eq('id', created.couponId);
  }
  if (ids.length > 0) {
    await srAdmin.from('support_tickets').delete().in('user_id', ids); // メッセージは CASCADE
    await srAdmin.from('csat_feedbacks').delete().in('user_id', ids);
    await srAdmin.from('gdpr_deletion_requests').delete().in('user_id', ids);
    await srAdmin.from('recipe_flags').delete().in('reporter_id', ids);
    await srAdmin.from('inquiries').delete().in('user_id', ids);
    await srAdmin.from('family_members').delete().in('user_id', ids);
  }
  if (created.familyGroupId) await srAdmin.from('family_groups').delete().eq('id', created.familyGroupId);
  if (created.announcementId) await srAdmin.from('announcements').delete().eq('id', created.announcementId);
  if (created.systemRecipeId) await srAdmin.from('recipes').delete().eq('id', created.systemRecipeId);
  await srAdmin.from('cookie_consents').delete().like('session_id', `ANON-SESSION-${RUN}`);

  for (const id of ids) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
  if (created.organizationId) await srAdmin.from('organizations').delete().eq('id', created.organizationId);
  // ユーザー削除のあとに書き込まれたルートのログ (user_id が NULL になったもの) も消す
  await srAdmin
    .from('app_logs')
    .delete()
    .eq('function_name', 'GET /api/account/export')
    .gte('created_at', new Date(RUN).toISOString());
}, 120_000);

// ================================================================
// RLS の前提 (絞り込みが必要な状況であること)
// ================================================================
describe('前提: RLS だけでは他人の行が読めてしまう表がある', () => {
  it('A の JWT で、B の公開レシピ・B の公開コレクション・システムのレシピが読める', async () => {
    const { data } = await asUser(A.jwt).from('recipes').select('id, user_id, name').eq('is_public', true);
    const names = (data ?? []).map((r) => r.name as string);
    expect(names).toContain(`RECIPE-B-${RUN}`);
    expect(names).toContain(`SYSTEM-RECIPE-${RUN}`);

    const collections = await asUser(A.jwt).from('recipe_collections').select('name').eq('is_public', true);
    expect((collections.data ?? []).map((r) => r.name)).toContain(`COLLECTION-B-${RUN}`);
  });

  it('A の JWT で、B のコメント・いいね (誰でも閲覧可) が読める', async () => {
    const comments = await asUser(A.jwt).from('recipe_comments').select('content');
    expect((comments.data ?? []).map((r) => r.content)).toContain(`COMMENT-B-${RUN}`);
  });

  it('A の JWT で、同じ家族の B のメンバー行と、同じ組織の B のチャレンジ参加行が読める', async () => {
    const members = await asUser(A.jwt).from('family_members').select('user_id');
    expect((members.data ?? []).map((r) => r.user_id)).toContain(B.id);

    const participants = await asUser(A.jwt).from('organization_challenge_participants').select('user_id');
    expect((participants.data ?? []).map((r) => r.user_id)).toContain(B.id);
  });

  it('運営 (support) の JWT で、A・B の問い合わせ・チケット・契約が読める', async () => {
    const tickets = await asUser(STAFF.jwt).from('support_tickets').select('user_id');
    const owners = new Set((tickets.data ?? []).map((r) => r.user_id));
    expect(owners.has(A.id) && owners.has(B.id)).toBe(true);

    const inquiries = await asUser(STAFF.jwt).from('inquiries').select('user_id');
    expect(new Set((inquiries.data ?? []).map((r) => r.user_id)).has(A.id)).toBe(true);

    const subscriptions = await asUser(STAFF.jwt).from('personal_subscriptions').select('user_id');
    expect((subscriptions.data ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// ================================================================
// エクスポート本体 (ライブラリを、利用者の JWT のクライアントで直接実行)
// ================================================================
describe('#1131 エクスポート: 本物の RLS の上で本人の行だけが出る', () => {
  it('A: 全テーブルの問い合わせが成功して完走し、すべてのテーブルに A の行が 1 件以上出る', async () => {
    const { json } = await exportAs(A);

    expect(json.format).toBe('homegohan-personal-data-export');
    expect(json.user_id).toBe(A.id);
    expect(json.summary.complete).toBe(true);
    expect(json.summary.truncated_tables).toEqual([]);
    expect(json.summary.skipped_tables).toEqual([]);
    expect(Object.keys(json.data)).toEqual(ACCOUNT_EXPORT_TABLES.map((t) => t.table));

    // A は家族の代表者ではないので family_groups だけは 0 件。それ以外は全表に本人の行がある
    const empty = Object.entries(json.data)
      .filter(([, rows]) => rows.length === 0)
      .map(([table]) => table);
    expect(empty).toEqual(['family_groups']);
  });

  it('A: 件数が種どおり (子表・複数行・内部メッセージの除外)', async () => {
    const { json } = await exportAs(A);
    const counts = json.summary.row_counts;

    expect(counts).toMatchObject({
      user_profiles: 1,
      meals: 1,
      user_daily_meals: 1,
      planned_meals: 2,
      shopping_list_items: 1,
      recipes: 1, // 非公開の自作レシピだけ。B の公開レシピ・システムのレシピは含まない
      recipe_collections: 1,
      recipe_collection_items: 1,
      recipe_likes: 1,
      recipe_comments: 1,
      family_members: 1, // 自分の所属行だけ。B の行は含まない
      family_groups: 0,
      organization_challenge_participants: 1, // 同じ組織の B の参加行は含まない
      cookie_consents: 1, // 匿名 (user_id IS NULL) の行は含まない
      support_tickets: 1,
      support_ticket_messages: 2, // 本人 + サポートの返信。内部メモは含まない
      user_badges: 1,
    });
  });

  it('A: B・運営・システムの行も、秘密 / 内部の列も、文字列として一切含まれない', async () => {
    const { text } = await exportAs(A);

    // 他人 (B) と運営ユーザーの ID・固有の文字列
    expect(text).not.toContain(B.id);
    expect(text).not.toContain(STAFF.id);
    expect(text).not.toContain(`-B-${RUN}`);
    expect(text).not.toContain(`SYSTEM-RECIPE-${RUN}`);
    expect(text).not.toContain(`ANON-SESSION-${RUN}`);
    expect(text).not.toContain(`STAFF-OWN`);
    // 秘密 / 内部の列の値
    for (const hidden of [
      `cus-A-${RUN}`,
      `sub-A-${RUN}`,
      `price-A-${RUN}`,
      `STAFF-NOTE-A-${RUN}`,
      `ADMIN-NOTE-A-${RUN}`,
      `INTERNAL-NOTE-A-${RUN}`,
      `GDPR-NOTE-A-${RUN}`,
      `WORKER-A-${RUN}`,
      `RESULT-JSON-A-${RUN}`,
    ]) {
      expect(text, hidden).not.toContain(hidden);
    }
    // 本人のデータは入っている
    for (const shown of [`NICK-A-${RUN}`, `MEMO-A-${RUN}`, `DISH-1-A-${RUN}`, `COMMENT-A-${RUN}`, `PROMPT-A-${RUN}`, `SUPPORT-REPLY-A-${RUN}`, `CHAT-A-${RUN}`]) {
      expect(text, shown).toContain(shown);
    }
  });

  it('A: 列の整形 (結合キー・担当者 ID・権限の列は無い。バッジ名は添えられる。返信者は user / support)', async () => {
    const { json } = await exportAs(A);
    const { data } = json;

    expect(data.user_profiles[0]).toMatchObject({ id: A.id, nickname: `NICK-A-${RUN}` });
    for (const column of ['roles', 'is_banned', 'frozen_by', 'plan_key_cached']) {
      expect(data.user_profiles[0]).not.toHaveProperty(column);
    }
    expect(data.personal_subscriptions[0]).toMatchObject({ user_id: A.id, plan_key: 'pro' });
    for (const column of ['stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id', 'notes']) {
      expect(data.personal_subscriptions[0]).not.toHaveProperty(column);
    }
    expect(data.support_tickets[0]).not.toHaveProperty('assignee_id');
    expect(data.inquiries[0]).not.toHaveProperty('admin_notes');
    expect(data.coupon_redemptions[0]).not.toHaveProperty('approved_by');
    expect(data.recipe_flags[0]).not.toHaveProperty('reviewed_by');
    // #1101: 運営が隠したときの記録。隠した日時と理由は本人に関わる記録として出し、操作した運営ユーザーの ID (hidden_by) は出さない
    for (const rows of [data.meals, data.recipes]) {
      expect(rows[0]).toHaveProperty('hidden_at');
      expect(rows[0]).toHaveProperty('hidden_reason');
      expect(rows[0]).not.toHaveProperty('hidden_by');
    }
    expect(data.gdpr_deletion_requests[0]).not.toHaveProperty('executed_by');
    expect(data.weekly_menu_requests[0]).not.toHaveProperty('result_json');
    expect(data.weekly_menu_requests[0]).not.toHaveProperty('worker_id');

    for (const row of data.planned_meals) expect(row).not.toHaveProperty('user_daily_meals');
    for (const row of data.support_ticket_messages) {
      expect(row).not.toHaveProperty('support_tickets');
      expect(row).not.toHaveProperty('sender_id');
    }
    // 会話は時系列 (本人の問い合わせ → サポートの返信)
    expect(data.support_ticket_messages.map((m) => m.sender)).toEqual(['user', 'support']);

    expect(data.user_badges[0]).toHaveProperty('badge');
    expect((data.user_badges[0].badge as Record<string, unknown>).name).toEqual(expect.any(String));
    expect(data.user_badges[0].badge).not.toHaveProperty('condition_json');
  });

  it('1000 行を超えるテーブルも、本物の PostgREST のページングで取りこぼし・重複なく全件出る', async () => {
    const { json } = await exportAs(PAGER);
    const names = json.data.pantry_items.map((row) => row.name as string);

    expect(json.summary.complete).toBe(true);
    expect(json.summary.row_counts.pantry_items).toBe(PAGER_ROWS);
    expect(names).toHaveLength(PAGER_ROWS);
    expect(new Set(names).size).toBe(PAGER_ROWS);
    // id 順で返るので順序は一定だが、種の連番がすべて揃っていることを確認する
    const sequence = names.map((name) => Number(name.split('-')[2])).sort((a, b) => a - b);
    expect(sequence[0]).toBe(0);
    expect(sequence[PAGER_ROWS - 1]).toBe(PAGER_ROWS - 1);
    expect(names.every((name) => name.startsWith('BULK-PAGER-'))).toBe(true);
  });

  it('B: B の行だけが出る (A の行は含まれず、代表者の家族グループは出る)', async () => {
    const { json, text } = await exportAs(B);

    expect(json.summary.complete).toBe(true);
    expect(json.data.family_groups.map((g) => g.name)).toEqual([`FAMILY-B-${RUN}`]);
    expect(json.data.family_members.map((m) => m.user_id)).toEqual([B.id]);
    expect(json.data.recipes.map((r) => r.name)).toEqual([`RECIPE-B-${RUN}`]);
    expect(json.data.support_tickets).toHaveLength(1);

    expect(text).not.toContain(A.id);
    expect(text).not.toContain(STAFF.id);
    expect(text).not.toContain(`-A-${RUN}`);
    expect(text).not.toContain(`SYSTEM-RECIPE-${RUN}`);
  });

  it('運営ロール (support) のユーザー: RLS では全員分が読める表でも、自分の行だけが出る', async () => {
    const { json, text } = await exportAs(STAFF);

    expect(json.data.support_tickets.map((t) => t.subject)).toEqual([`STAFF-OWN-TICKET-${RUN}`]);
    expect(json.data.inquiries.map((i) => i.subject)).toEqual([`STAFF-OWN-INQUIRY-${RUN}`]);
    expect(json.data.personal_subscriptions).toEqual([]);
    expect(json.data.coupon_redemptions).toEqual([]);
    expect(json.data.support_ticket_messages).toEqual([]);
    expect(text).not.toContain(A.id);
    expect(text).not.toContain(B.id);
    expect(text).not.toContain(`-A-${RUN}`);
    expect(text).not.toContain(`-B-${RUN}`);
  });

});

// ================================================================
// API (Bearer 認証。モバイルアプリと同じ呼び方)
// ================================================================
describe('#1131 GET /api/account/export (要 dev サーバー)', () => {
  it('未認証は 401', async () => {
    const res = await apiCall('GET', '/api/account/export', null);
    expect(res.status).toBe(401);
  });

  it('Bearer だけで 200。ダウンロード用のヘッダーが付き、A の行だけが入る', async () => {
    const res = await apiCall<ExportJson>('GET', '/api/account/export', A.jwt);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="homegohan-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    expect(res.body.user_id).toBe(A.id);
    expect(res.body.summary.complete).toBe(true);
    expect(res.body.data.meals).toHaveLength(1);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(B.id);
    expect(text).not.toContain(`-B-${RUN}`);
    expect(text).not.toContain(`STAFF-NOTE-A-${RUN}`);
  });

  it('B の JWT では B のデータが返る (A のデータは返らない)', async () => {
    const res = await apiCall<ExportJson>('GET', '/api/account/export', B.jwt);
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(B.id);
    expect(JSON.stringify(res.body)).not.toContain(`-A-${RUN}`);
  });

  it('10 分に 5 回まで。6 回目は 429 + Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await apiCall('GET', '/api/account/export', LIMITED.jwt);
      expect(ok.status).toBe(200);
    }
    const limited = await apiCall<{ code?: string }>('GET', '/api/account/export', LIMITED.jwt);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
  });
});
