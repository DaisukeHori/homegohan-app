/**
 * #1145 管理画面のユーザー一覧・詳細 API がメールアドレスを返す (結合テスト: Next の API ルート + 実 Supabase)
 *
 * 修正前:
 *   - GET /api/admin/users と GET /api/admin/users/[id] は email を常に null で返していた。
 *   - q (検索語) は nickname と user_id だけが対象で、メールでは探せなかった (UI の placeholder は「名前・メール・ID」)。
 *   - q は文字列連結のまま PostgREST の or=(...) に埋め込まれていた。"," ")" などを含む検索語は構文エラーになり、
 *     "%" "_" は LIKE のワイルドカードとして働いた。
 * 修正後:
 *   - admin / super_admin: 一覧・詳細の email に auth.users のメールが入り、q はメールの部分一致 (大文字小文字を区別しない) も対象。
 *   - support: 一覧・詳細は従来どおり 200 だが email は null。q にメールが一致しても探せない
 *     (メールの存在を検索で推測できない)。
 *   - 一般ユーザーは 403、未認証は 401 (認可は変えない)。
 *   - q の "," ")" 引用符 バックスラッシュ は構文を壊さず、"%" "_" は文字どおりに一致する。
 *
 * 実行 (ローカル Supabase + ローカルの Next dev サーバが必要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   INTEGRATION_BASE_URL=http://localhost:3000 \
 *     npx vitest run --config vitest.integration.config.ts tests/integration/security/admin-users-email.test.ts
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
const email = (label: string) => `sec-1145-${label}-${TS}@homegohan.test`;

// nickname は検索語の検証用。メール側の検索語 ("sec-1145-...") とは重ならないようにする。
const NICK_TARGET = `Target-${TS}`;
const NICK_UNDERSCORE = `Mi_ki-${TS}`; // "_" を文字どおりに一致させる検証用
const NICK_LOOKALIKE = `MiXki-${TS}`; // "_" がワイルドカードなら NICK_UNDERSCORE の検索に引っかかってしまう名前
// , ( ) " \ % を全部含む (PostgREST の or=(...) と LIKE の両方で特別扱いされる文字)
const NICK_SPECIAL = `Ta,ro (kari) "q" \\ 100% ${TS}`;

let adminUser: TestUser;
let superAdminUser: TestUser;
let supportUser: TestUser;
let generalUser: TestUser;
let targetUser: TestUser;
let underscoreUser: TestUser;
let lookalikeUser: TestUser;
let specialUser: TestUser;

interface ListItem {
  id: string;
  email: string | null;
  nickname: string | null;
}

interface ListBody {
  data: ListItem[];
  meta: { total: number; page: number; per_page: number };
}

interface DetailBody {
  data: { id: string; email: string | null; nickname: string | null };
}

const search = (jwt: string | null, q: string, extra = '') =>
  jwt
    ? apiCall<ListBody>('GET', `/api/admin/users?per_page=200&q=${encodeURIComponent(q)}${extra}`, jwt)
    : apiCallNoAuth<ListBody>('GET', `/api/admin/users?per_page=200&q=${encodeURIComponent(q)}${extra}`);

const idsOf = (res: { body: ListBody }) => (res.body.data ?? []).map((u) => u.id);

async function setNickname(userId: string, nickname: string) {
  const { error } = await supabaseAdmin.from('user_profiles').update({ nickname }).eq('id', userId);
  if (error) throw new Error(`nickname 更新に失敗: ${error.message}`);
}

beforeAll(async () => {
  [adminUser, superAdminUser, supportUser, generalUser, targetUser, underscoreUser, lookalikeUser, specialUser] =
    await Promise.all([
      createTestUserWithRoles({ email: email('admin'), roles: ['admin'] }),
      createTestUserWithRoles({ email: email('superadmin'), roles: ['super_admin'] }),
      createTestUserWithRoles({ email: email('support'), roles: ['support'] }),
      createTestUserWithRoles({ email: email('general'), roles: ['user'] }),
      createTestUserWithRoles({ email: email('target'), roles: ['user'] }),
      createTestUserWithRoles({ email: email('underscore'), roles: ['user'] }),
      createTestUserWithRoles({ email: email('lookalike'), roles: ['user'] }),
      createTestUserWithRoles({ email: email('special'), roles: ['user'] }),
    ]);
  await Promise.all([
    setNickname(targetUser.userId, NICK_TARGET),
    setNickname(underscoreUser.userId, NICK_UNDERSCORE),
    setNickname(lookalikeUser.userId, NICK_LOOKALIKE),
    setNickname(specialUser.userId, NICK_SPECIAL),
  ]);
}, 90_000);

afterAll(async () => {
  await Promise.all(
    [adminUser, superAdminUser, supportUser, generalUser, targetUser, underscoreUser, lookalikeUser, specialUser]
      .filter(Boolean)
      .map((u) => cleanupTestUser(u.userId)),
  );
}, 60_000);

// ================================================================
// 一覧: メールアドレスが返る
// ================================================================
describe('#1145 GET /api/admin/users: admin / super_admin にはメールアドレスが返る', () => {
  it('L-1: admin は検索結果の email に実際のメールアドレスを得る', async () => {
    const res = await search(adminUser.jwt, NICK_TARGET);
    expect(res.status).toBe(200);
    const item = res.body.data.find((u) => u.id === targetUser.userId);
    expect(item).toBeDefined();
    expect(item!.email).toBe(targetUser.email);
  });

  it('L-2: super_admin も同様', async () => {
    const res = await search(superAdminUser.jwt, NICK_TARGET);
    expect(res.status).toBe(200);
    const item = res.body.data.find((u) => u.id === targetUser.userId);
    expect(item?.email).toBe(targetUser.email);
  });

  it('L-3: 1 ページ内の全員に、その人自身のメールアドレスが付く (他人のメールが混ざらない)', async () => {
    const all = [adminUser, superAdminUser, supportUser, generalUser, targetUser, underscoreUser, lookalikeUser, specialUser];
    // 8 人のメールに共通する部分文字列で探す
    const res = await search(adminUser.jwt, `-${TS}@homegohan.test`);
    expect(res.status).toBe(200);
    for (const u of all) {
      const item = res.body.data.find((x) => x.id === u.userId);
      expect(item, `${u.userId} が一覧にある`).toBeDefined();
      expect(item!.email).toBe(u.email);
    }
  });

  it('L-4: ニックネームやユーザー ID での検索は従来どおり (メールも付く)', async () => {
    const byNickname = await search(adminUser.jwt, NICK_TARGET);
    expect(idsOf(byNickname)).toContain(targetUser.userId);
    const byId = await search(adminUser.jwt, targetUser.userId);
    expect(idsOf(byId)).toContain(targetUser.userId);
    expect(byId.body.data.find((u) => u.id === targetUser.userId)?.email).toBe(targetUser.email);
    // 大文字の UUID でも見つかる
    const byUpperId = await search(adminUser.jwt, targetUser.userId.toUpperCase());
    expect(idsOf(byUpperId)).toContain(targetUser.userId);
  });

  it('L-5: 一覧の応答はキャッシュさせない (メールアドレスを含むため)', async () => {
    const res = await search(adminUser.jwt, NICK_TARGET);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

// ================================================================
// 一覧: メールアドレスで検索できる
// ================================================================
describe('#1145 GET /api/admin/users: admin / super_admin はメールアドレスで検索できる', () => {
  it('S-1: メールの一部で見つかる (ニックネームには含まれない語)', async () => {
    const res = await search(adminUser.jwt, `sec-1145-target-${TS}`);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([targetUser.userId]);
  });

  it('S-2: メール全体でも、大文字でも見つかる', async () => {
    const full = await search(adminUser.jwt, targetUser.email);
    expect(idsOf(full)).toEqual([targetUser.userId]);
    const upper = await search(superAdminUser.jwt, targetUser.email.toUpperCase());
    expect(idsOf(upper)).toEqual([targetUser.userId]);
  });

  it('S-3: 前後の空白は無視する', async () => {
    const res = await search(adminUser.jwt, `  ${targetUser.email}  `);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([targetUser.userId]);
  });

  it('S-4: ステータスなど他の絞り込みと組み合わせても、メール検索の結果が AND で絞られる', async () => {
    // target は凍結されていないので status=banned では出ない。active では出る
    const banned = await search(adminUser.jwt, targetUser.email, '&status=banned');
    expect(banned.status).toBe(200);
    expect(idsOf(banned)).not.toContain(targetUser.userId);
    const active = await search(adminUser.jwt, targetUser.email, '&status=active');
    expect(idsOf(active)).toEqual([targetUser.userId]);
  });
});

// ================================================================
// 一覧: support にはメールを見せない
// ================================================================
describe('#1145 GET /api/admin/users: support にはメールアドレスを見せない', () => {
  it('P-1: support は 200 だが、見つかった全員の email が null', async () => {
    const res = await search(supportUser.jwt, NICK_TARGET);
    expect(res.status).toBe(200);
    const item = res.body.data.find((u) => u.id === targetUser.userId);
    expect(item).toBeDefined();
    expect(item!.email).toBeNull();
    expect(res.body.data.every((u) => u.email === null)).toBe(true);
  });

  it('P-2: support がメールの語で検索しても一致しない (検索でメールの存在を推測できない)', async () => {
    const partial = await search(supportUser.jwt, `sec-1145-target-${TS}`);
    expect(partial.status).toBe(200);
    expect(idsOf(partial)).toEqual([]);
    const full = await search(supportUser.jwt, targetUser.email);
    expect(full.status).toBe(200);
    expect(idsOf(full)).toEqual([]);
  });

  it('P-3: support でもニックネームとユーザー ID の検索は従来どおり', async () => {
    const byId = await search(supportUser.jwt, targetUser.userId);
    expect(idsOf(byId)).toContain(targetUser.userId);
  });

  it('P-4: 一般ユーザーは 403、未認証は 401。どちらもメールアドレスを含まない', async () => {
    const forbidden = await search(generalUser.jwt, targetUser.email);
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(forbidden.body)).not.toContain(targetUser.email);
    const anonymous = await search(null, targetUser.email);
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(anonymous.body)).not.toContain(targetUser.email);
  });
});

// ================================================================
// 一覧: 検索語の特殊文字
// ================================================================
describe('#1145 GET /api/admin/users: 検索語の特殊文字で壊れない・ワイルドカードにならない', () => {
  it('Q-1: , ( ) " \\ % を含むニックネームも、そのままの検索語で見つかる', async () => {
    const res = await search(adminUser.jwt, NICK_SPECIAL);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([specialUser.userId]);
  });

  it('Q-2: "_" は文字どおりに一致する (MiXki は Mi_ki の検索に引っかからない)', async () => {
    const res = await search(adminUser.jwt, NICK_UNDERSCORE);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([underscoreUser.userId]);
  });

  it('Q-3: "%" は文字どおりに一致する (Mi%ki は何にも一致しない)', async () => {
    const res = await search(adminUser.jwt, `Mi%ki-${TS}`);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([]);
  });

  it('Q-4: 構文を壊しうる検索語でも 200 (500 / 400 にならない)', async () => {
    for (const q of ['a,b)', '")', '\\', '(', ')', '%', '_', "' OR '1'='1", 'x,id.eq.1', '"', '*', '.']) {
      const res = await search(adminUser.jwt, q);
      expect(res.status, `q=${q}`).toBe(200);
      expect(Array.isArray(res.body.data), `q=${q}`).toBe(true);
    }
  });
});

// ================================================================
// 詳細
// ================================================================
describe('#1145 GET /api/admin/users/[id]: メールアドレス', () => {
  it('D-1: admin は詳細の email に実際のメールアドレスを得る', async () => {
    const res = await apiCall<DetailBody>('GET', `/api/admin/users/${targetUser.userId}`, adminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(targetUser.userId);
    expect(res.body.data.email).toBe(targetUser.email);
  });

  it('D-2: super_admin も同様', async () => {
    const res = await apiCall<DetailBody>('GET', `/api/admin/users/${targetUser.userId}`, superAdminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(targetUser.email);
  });

  it('D-3: support は 200 だが email は null', async () => {
    const res = await apiCall<DetailBody>('GET', `/api/admin/users/${targetUser.userId}`, supportUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(targetUser.userId);
    expect(res.body.data.email).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(targetUser.email);
  });

  it('D-4: 一般ユーザーは 403、未認証は 401。どちらもメールアドレスを含まない', async () => {
    const forbidden = await apiCall('GET', `/api/admin/users/${targetUser.userId}`, generalUser.jwt);
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(forbidden.body)).not.toContain(targetUser.email);
    const anonymous = await apiCallNoAuth('GET', `/api/admin/users/${targetUser.userId}`);
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(anonymous.body)).not.toContain(targetUser.email);
  });

  it('D-5: 存在しない id は従来どおり 404', async () => {
    const res = await apiCall('GET', '/api/admin/users/00000000-0000-4000-8000-000000001145', adminUser.jwt);
    expect(res.status).toBe(404);
  });

  it('D-6: 詳細の応答もキャッシュさせない', async () => {
    const res = await apiCall<DetailBody>('GET', `/api/admin/users/${targetUser.userId}`, adminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});
