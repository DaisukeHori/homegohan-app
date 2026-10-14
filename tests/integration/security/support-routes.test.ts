/**
 * #1161 サポート画面の API (統計・ユーザー詳細・管理ノート) とお知らせ API を、
 * 実 DB・実 RLS・実際の API ルートで確かめる
 *
 * 単体テスト (tests/support-routes.test.ts、tests/announcements-route.test.ts) は DB をモックするので、
 * 次の点はここで実物を確認する:
 *   - サポート担当 (RLS では自分の user_profiles しか見えない) が、他のユーザーの詳細を開ける。
 *     以前は user_profiles が 0 行になって 500 になっていた (画面は !res.ok を無視して無反応)
 *   - mealCount は「開いた対象ユーザー」が完了した食事の数。閲覧者本人や他のユーザーの分は混ざらない
 *     (planned_meals に user_id 列は無く、user_daily_meals!inner で絞る)
 *   - 管理ノートの GET が動く (admin_user_notes.admin_id の外部キーは auth.users 宛で、
 *     user_profiles の埋め込みは PostgREST が解決できず、常に失敗していた)。書いた人のニックネームが付く
 *   - 統計の「自分が今週対応した件数」は、admin_audit_logs の actor_id で数える (存在しない列 admin_id ではなく)。
 *     support は admin_audit_logs を SELECT できないため、service_role で数える
 *   - 問い合わせ者のニックネームが付く (inquiries.user_id の外部キーも auth.users 宛で、埋め込めなかった)
 *   - お知らせ: 公開用は認証不要、管理用と作成は admin / super_admin だけ (support は 403)
 *   - 401 / 403 の判定は、実際のロールで行われる
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/support-routes.test.ts
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);

interface TestUser {
  id: string;
  jwt: string;
  nickname: string;
}

const TS = Date.now();
const createdUserIds: string[] = [];
const NICKNAME_PREFIX = '#1161-support';

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-support-${label}-${TS}@homegohan.test`;
  // テスト用ユーザーのパスワードは固定値を置かず、実行ごとに作る
  const password = `Aa1!${randomUUID()}`;
  const nickname = `${NICKNAME_PREFIX}-${label}-${TS}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);

  // roles は特権列ガードにより本人では変更できないため service_role で設定する
  if (roles) {
    const { error: roleError } = await srAdmin.from('user_profiles').update({ roles }).eq('id', data.user.id);
    if (roleError) throw new Error(`roles ${label}: ${roleError.message}`);
  }

  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token, nickname };
}

let support: TestUser;
let admin: TestUser;
let superAdmin: TestUser;
let sales: TestUser;
let orgAdminOnly: TestUser;
let general: TestUser;
let target: TestUser;
let other: TestUser;

const createdAnnouncementIds: string[] = [];
let publicAnnouncementId = '';
let privateAnnouncementId = '';
const PUBLIC_TITLE = `#1161 公開のお知らせ ${TS}`;
const PRIVATE_TITLE = `#1161 非公開のお知らせ ${TS}`;
const INQUIRY_SUBJECT = `#1161 問い合わせ ${TS}`;
const OTHER_INQUIRY_SUBJECT = `#1161 別のユーザーの問い合わせ ${TS}`;
const SEEDED_NOTE = `#1161 管理者が先に書いたノート ${TS}`;

/** day_date が (user_id, day_date) で一意なので、ユーザーごとに別の日付にする */
async function seedMeals(userId: string, completed: number, notCompleted: number, firstDayOffset: number) {
  const total = completed + notCompleted;
  for (let i = 0; i < total; i += 1) {
    const day = new Date(Date.UTC(2026, 0, 1 + firstDayOffset + i)).toISOString().slice(0, 10);
    const { data: daily, error } = await srAdmin
      .from('user_daily_meals')
      .insert({ user_id: userId, day_date: day })
      .select('id')
      .single();
    if (error || !daily) throw new Error(`user_daily_meals: ${error?.message}`);
    const { error: mealError } = await srAdmin.from('planned_meals').insert({
      daily_meal_id: daily.id,
      meal_type: 'dinner',
      dish_name: `#1161 テスト料理 ${i}`,
      is_completed: i < completed,
    });
    if (mealError) throw new Error(`planned_meals: ${mealError.message}`);
  }
}

beforeAll(async () => {
  [support, admin, superAdmin, sales, orgAdminOnly, general, target, other] = await Promise.all([
    createUser('support', ['support']),
    createUser('admin', ['admin']),
    createUser('superadmin', ['super_admin']),
    createUser('sales', ['sales']),
    createUser('orgadmin', ['org_admin']),
    createUser('general'),
    createUser('target'),
    createUser('other'),
  ]);

  // 完了した食事: 対象 2 件 (+ 未完了 1 件)、別ユーザー 3 件、閲覧者 (support) 本人 1 件。数がすべて違うので、誰の分を数えたかが分かる
  await seedMeals(target.id, 2, 1, 0);
  await seedMeals(other.id, 3, 0, 10);
  await seedMeals(support.id, 1, 0, 20);

  // AI 相談: 対象 2 件、別ユーザー 4 件
  const sessions = [
    ...[1, 2].map(() => ({ user_id: target.id })),
    ...[1, 2, 3, 4].map(() => ({ user_id: other.id })),
  ];
  const { error: sessionError } = await srAdmin.from('ai_consultation_sessions').insert(sessions);
  if (sessionError) throw new Error(`ai_consultation_sessions: ${sessionError.message}`);

  // 問い合わせ: 対象の人のものと、別のユーザーのもの (一覧は新しい順なので、最後に作る)
  const { error: inquiryError } = await srAdmin.from('inquiries').insert([
    { user_id: other.id, inquiry_type: 'general', email: 'other@homegohan.test', subject: OTHER_INQUIRY_SUBJECT, message: '本文' },
    { user_id: target.id, inquiry_type: 'support', email: 'target@homegohan.test', subject: INQUIRY_SUBJECT, message: '本文' },
  ]);
  if (inquiryError) throw new Error(`inquiries: ${inquiryError.message}`);

  // 対象ユーザーについて、admin が先に書いたノート (書いた人のニックネームが GET で付くことの確認用)
  const { error: noteError } = await srAdmin
    .from('admin_user_notes')
    .insert({ user_id: target.id, admin_id: admin.id, note: SEEDED_NOTE });
  if (noteError) throw new Error(`admin_user_notes: ${noteError.message}`);

  // 「今週対応した件数」: support 2 件、admin 1 件 (resolve_inquiry)
  const { error: auditError } = await srAdmin.from('admin_audit_logs').insert([
    { actor_id: support.id, action_type: 'resolve_inquiry', target_type: 'inquiry', severity: 'info' },
    { actor_id: support.id, action_type: 'resolve_inquiry', target_type: 'inquiry', severity: 'info' },
    { actor_id: admin.id, action_type: 'resolve_inquiry', target_type: 'inquiry', severity: 'info' },
  ]);
  if (auditError) throw new Error(`admin_audit_logs: ${auditError.message}`);

  // お知らせ: 公開 1 件、非公開 1 件
  const { data: announcements, error: announcementError } = await srAdmin
    .from('announcements')
    .insert([
      { title: PUBLIC_TITLE, content: '本文', is_public: true, published_at: new Date().toISOString() },
      { title: PRIVATE_TITLE, content: '本文', is_public: false },
    ])
    .select('id, title');
  if (announcementError || !announcements) throw new Error(`announcements: ${announcementError?.message}`);
  for (const a of announcements) {
    createdAnnouncementIds.push(a.id);
    if (a.title === PUBLIC_TITLE) publicAnnouncementId = a.id;
    if (a.title === PRIVATE_TITLE) privateAnnouncementId = a.id;
  }
}, 120_000);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // actor_id の外部キーがあるため、ユーザー削除より先に監査ログを消す (service_role のみ可能)
    await srAdmin.from('admin_audit_logs').delete().in('actor_id', createdUserIds);
    await srAdmin.from('admin_user_notes').delete().in('user_id', createdUserIds);
    await srAdmin.from('inquiries').delete().in('user_id', createdUserIds);
    await srAdmin.from('ai_consultation_sessions').delete().in('user_id', createdUserIds);
    // 食事 (planned_meals) は user_daily_meals の削除で連鎖して消える
    await srAdmin.from('user_daily_meals').delete().in('user_id', createdUserIds);
  }
  if (createdAnnouncementIds.length > 0) {
    await srAdmin.from('announcements').delete().in('id', createdAnnouncementIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 120_000);

// ================================================================
// 認可 (実際のロール)
// ================================================================
describe('#1161 サポート画面の API は support / admin / super_admin だけが使える', () => {
  const paths = {
    stats: () => ({ method: 'GET' as const, path: '/api/support/stats' }),
    detail: () => ({ method: 'GET' as const, path: `/api/support/users/${target.id}` }),
    notesGet: () => ({ method: 'GET' as const, path: `/api/support/users/${target.id}/notes` }),
    notesPost: () => ({ method: 'POST' as const, path: `/api/support/users/${target.id}/notes`, body: { note: `#1161 認可の確認 ${TS}` } }),
  };

  for (const [name, request] of Object.entries(paths)) {
    it(`${name}: トークン無しは 401`, async () => {
      const { method, path, body } = request() as { method: 'GET' | 'POST'; path: string; body?: unknown };
      const res = await apiCall(method, path, null, body);
      expect(res.status).toBe(401);
    });

    it(`${name}: 一般ユーザー・sales・org_admin だけのユーザーは 403 (運営ロールではない)`, async () => {
      const { method, path, body } = request() as { method: 'GET' | 'POST'; path: string; body?: unknown };
      for (const user of [general, sales, orgAdminOnly]) {
        const res = await apiCall(method, path, user.jwt, body);
        expect(res.status, `${name} as ${user.nickname}`).toBe(403);
      }
    });

    it(`${name}: support / admin / super_admin は 200`, async () => {
      const { method, path, body } = request() as { method: 'GET' | 'POST'; path: string; body?: unknown };
      for (const user of [support, admin, superAdmin]) {
        const res = await apiCall(method, path, user.jwt, body);
        expect(res.status, `${name} as ${user.nickname}`).toBe(200);
      }
    });
  }

  it('403 のユーザーがノートを書こうとしても、何も保存されない', async () => {
    const note = `#1161 書けてはいけないノート ${TS}`;
    await apiCall('POST', `/api/support/users/${target.id}/notes`, general.jwt, { note });
    await apiCall('POST', `/api/support/users/${target.id}/notes`, orgAdminOnly.jwt, { note });

    const { data } = await srAdmin.from('admin_user_notes').select('id').eq('note', note);
    expect(data ?? []).toHaveLength(0);
  });
});

// ================================================================
// GET /api/support/users/[id]
// ================================================================
describe('#1161 GET /api/support/users/[id]: 他のユーザーの詳細', () => {
  it('support が他のユーザーの詳細を開ける (以前は 0 行で 500)', async () => {
    const res = await apiCall<any>('GET', `/api/support/users/${target.id}`, support.jwt);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: target.id, nickname: target.nickname });
  });

  it('mealCount は対象ユーザーが完了した食事だけ (閲覧者本人・別ユーザー・未完了は混ざらない)', async () => {
    const res = await apiCall<any>('GET', `/api/support/users/${target.id}`, support.jwt);

    // 対象 2 件。support 本人の分 (1 件)、別ユーザーの分 (3 件)、全員分 (6 件)、未完了を含めた 3 件のどれでもない
    expect(res.body.stats.mealCount).toBe(2);
    expect(res.body.stats.aiSessionCount).toBe(2);
  });

  it('別のユーザーを開けば、そのユーザーの数になる。support 自身を開けば support 自身の数', async () => {
    const otherRes = await apiCall<any>('GET', `/api/support/users/${other.id}`, support.jwt);
    const selfRes = await apiCall<any>('GET', `/api/support/users/${support.id}`, support.jwt);

    expect(otherRes.body.stats).toEqual({ mealCount: 3, aiSessionCount: 4 });
    expect(selfRes.body.stats).toEqual({ mealCount: 1, aiSessionCount: 0 });
  });

  it('問い合わせ履歴とノートは対象ユーザーのものだけ', async () => {
    const res = await apiCall<any>('GET', `/api/support/users/${target.id}`, admin.jwt);

    expect(res.status).toBe(200);
    expect(res.body.inquiries.map((i: { subject: string }) => i.subject)).toEqual([INQUIRY_SUBJECT]);
    expect(res.body.notes.map((n: { note: string }) => n.note)).toContain(SEEDED_NOTE);
    expect(JSON.stringify(res.body)).not.toContain(OTHER_INQUIRY_SUBJECT);
  });

  it('存在しないユーザーは 404、UUID でない id も 404 (500 にしない)', async () => {
    const missing = await apiCall('GET', '/api/support/users/00000000-0000-4000-8000-000000001161', support.jwt);
    const malformed = await apiCall('GET', '/api/support/users/not-a-uuid', support.jwt);

    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
  });
});

// ================================================================
// 管理ノート
// ================================================================
describe('#1161 管理ノート: GET は書いた人のニックネームを返し、POST は actor_id で監査される', () => {
  it('GET: ノートに書いた人のニックネームが付く (以前は user_profiles の埋め込みが解決できず常に失敗していた)', async () => {
    const res = await apiCall<any>('GET', `/api/support/users/${target.id}/notes`, support.jwt);

    expect(res.status).toBe(200);
    const seeded = res.body.notes.find((n: { note: string }) => n.note === SEEDED_NOTE);
    expect(seeded).toMatchObject({ adminId: admin.id, adminName: admin.nickname });
  });

  it('POST: ノートが保存され (admin_id は書いた人)、admin.user.note_add が actor_id で記録される', async () => {
    const note = `#1161 サポートが書いたノート ${TS}`;

    const res = await apiCall<any>('POST', `/api/support/users/${target.id}/notes`, support.jwt, { note: `  ${note}  ` });

    expect(res.status).toBe(200);
    const { data: rows } = await srAdmin.from('admin_user_notes').select('user_id, admin_id, note').eq('id', res.body.note.id);
    expect(rows).toEqual([{ user_id: target.id, admin_id: support.id, note }]);

    // 認可のテストでも同じ対象にノートを書いているので、このノートの note_id で絞る
    const { data: audit } = await srAdmin
      .from('admin_audit_logs')
      .select('actor_id, action_type, target_id, target_type, details')
      .eq('actor_id', support.id)
      .eq('action_type', 'admin.user.note_add')
      .eq('target_id', target.id)
      .eq('details->>note_id', res.body.note.id);
    expect(audit).toHaveLength(1);
    expect(audit![0]).toMatchObject({ target_type: 'user', details: { note_id: res.body.note.id } });
  });

  it('POST: 存在しないユーザーには書けない (404)。空のノートは 400', async () => {
    const missing = await apiCall('POST', '/api/support/users/00000000-0000-4000-8000-000000001161/notes', support.jwt, {
      note: 'x',
    });
    const empty = await apiCall('POST', `/api/support/users/${target.id}/notes`, support.jwt, { note: '   ' });

    expect(missing.status).toBe(404);
    expect(empty.status).toBe(400);
  });
});

// ================================================================
// GET /api/support/stats
// ================================================================
describe('#1161 GET /api/support/stats', () => {
  it('自分が今週対応した件数は、操作した人 (actor_id) ごとに数える。support は admin_audit_logs を読めなくても数えられる', async () => {
    const supportRes = await apiCall<any>('GET', '/api/support/stats', support.jwt);
    const adminRes = await apiCall<any>('GET', '/api/support/stats', admin.jwt);

    expect(supportRes.status).toBe(200);
    expect(supportRes.body.overview.myResolvedThisWeek).toBe(2);
    expect(adminRes.body.overview.myResolvedThisWeek).toBe(1);
  });

  it('最近の問い合わせに、問い合わせた人のニックネームが付く (以前は埋め込みが解決できず一覧が空だった)', async () => {
    const res = await apiCall<any>('GET', '/api/support/stats', support.jwt);

    const mine = res.body.recentInquiries.find((i: { subject: string }) => i.subject === INQUIRY_SUBJECT);
    const others = res.body.recentInquiries.find((i: { subject: string }) => i.subject === OTHER_INQUIRY_SUBJECT);
    expect(mine).toMatchObject({ userName: target.nickname, inquiryType: 'support', status: 'pending' });
    expect(others).toMatchObject({ userName: other.nickname });
    expect(res.body.overview.pendingInquiries).toBeGreaterThanOrEqual(2);
  });
});

// ================================================================
// お知らせ
// ================================================================
describe('#1161 お知らせ API', () => {
  it('GET ?mode=public は認証不要で、公開済みのお知らせだけを返す', async () => {
    const res = await apiCall<any>('GET', '/api/announcements?mode=public', null);

    expect(res.status).toBe(200);
    const titles = res.body.announcements.map((a: { title: string }) => a.title);
    expect(titles).toContain(PUBLIC_TITLE);
    expect(titles).not.toContain(PRIVATE_TITLE);
  });

  it('GET (管理用): トークン無しは 401、support を含む運営以外は 403、admin / super_admin は非公開も読める', async () => {
    expect((await apiCall('GET', '/api/announcements', null)).status).toBe(401);
    for (const user of [general, sales, orgAdminOnly, support]) {
      expect((await apiCall('GET', '/api/announcements', user.jwt)).status, user.nickname).toBe(403);
    }
    for (const user of [admin, superAdmin]) {
      const res = await apiCall<any>('GET', '/api/announcements', user.jwt);
      expect(res.status, user.nickname).toBe(200);
      const ids = res.body.announcements.map((a: { id: string }) => a.id);
      expect(ids).toEqual(expect.arrayContaining([publicAnnouncementId, privateAnnouncementId]));
    }
  });

  it('POST: トークン無しは 401、support を含む運営以外は 403。何も作られない', async () => {
    const title = `#1161 作れてはいけないお知らせ ${TS}`;
    expect((await apiCall('POST', '/api/announcements', null, { title, content: 'x' })).status).toBe(401);
    for (const user of [general, orgAdminOnly, support]) {
      expect((await apiCall('POST', '/api/announcements', user.jwt, { title, content: 'x' })).status, user.nickname).toBe(403);
    }

    const { data } = await srAdmin.from('announcements').select('id').eq('title', title);
    expect(data ?? []).toHaveLength(0);
  });

  it('POST: admin は作成でき、created_by は作成者。公開すると published_at が入る。必須項目が無ければ 400', async () => {
    const title = `#1161 admin が作ったお知らせ ${TS}`;

    const res = await apiCall<any>('POST', '/api/announcements', admin.jwt, { title, content: '本文', isPublic: true });

    expect(res.status).toBe(200);
    createdAnnouncementIds.push(res.body.announcement.id);
    expect(res.body.announcement).toMatchObject({ title, is_public: true, created_by: admin.id });
    expect(res.body.announcement.published_at).toEqual(expect.any(String));

    const invalid = await apiCall('POST', '/api/announcements', admin.jwt, { title: '' });
    expect(invalid.status).toBe(400);
  });
});
