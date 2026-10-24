// @vitest-environment node
/**
 * cross/21 (#1917 の続き): 公開レシピの作者の表示名が、本人以外 (ログインした利用者・未ログイン) にも出ることの結合テスト
 *
 * 確かめること (関数 recipe_author_display_names を直接と、レシピの API 経由の両方):
 *   I-1  未ログイン (anon) が関数を呼ぶと、公開の作者 (18 歳以上・名前あり・設定は既定) の表示名が返る
 *   I-2  返らない人: 18 歳未満・生年月日なし・凍結中 (無期限 / 一時で未来)・名前を出さない設定・名前なし ('Guest')・公開レシピもコメントも無い人
 *   I-3  一時凍結の期限が過ぎた人は返る (isAccountFrozen と同じ境)
 *   I-4  公開レシピへのコメントだけの人も返る (コメントの作者)
 *   I-5  本人には自分の名前が返る (非公開のレシピだけの人・名前を出さない設定の人・18 歳未満の本人)。他の人には返らない
 *   I-6  重複と NULL と知らない id は無視され、空の配列は 0 行
 *   I-7  GET /api/recipes (未ログイン・ログイン中): 公開レシピの authorName が作者の表示名。18 歳未満の作者は '匿名'
 *   I-8  GET /api/recipes/[id] (未ログイン): authorName が作者の表示名。ログイン中: コメントの authorName (コメントの作者は表示名・設定オフの人は '匿名')
 *   I-9  PUT /api/profile で showRecipeAuthorName を false にすると他の人には '匿名'、true に戻すと表示名。本人の一覧には自分の名前のまま
 *   I-10 公開レシピを非公開に戻す・運営が隠す (hidden_at) と、ほかに公開の内容が無い作者と、そのレシピにだけコメントした人 (toggleCommenter) の
 *        名前は返らなくなる。公開に戻す・隠すのを戻すと両方返る (S-12・S-13。コメントの行は消えない)
 *   I-11 権限: anon と authenticated は EXECUTE でき、PUBLIC と service_role には EXECUTE が無い。user_profiles の SELECT のポリシーは本人の行だけの 1 本のまま
 *   I-12 公開レシピとコメントを持つ作者 (leaver) を退会 (auth.admin.deleteUser) させると、その公開レシピは user_id が NULL・is_public が true のまま残り、
 *        一覧・詳細 (未ログイン・ログイン中) の authorName は '匿名' になり (退会の前は表示名)、コメントは消える (S-6・R-3)
 *   I-13 凍結を解除 (frozen_at を NULL) すると、凍結中に返らなかった作者の名前が返る (S-7)
 *   I-14 18 歳の誕生日 (JST) の境: 今日が 18 歳の誕生日の人は返り、明日が 18 歳の誕生日の人は返らない (S-9。DB の時計の JST の今日で生年月日を決める)
 *   I-15 user_id が NULL のシステムの公開レシピは、一覧・詳細 (未ログイン・ログイン中) で authorName が '匿名' (S-15)
 *   I-16 本人 (deleter) が最後の公開レシピを DELETE /api/recipes/[id] で消すと、そのレシピへのコメントも CASCADE で消え、
 *        deleter と、そのレシピにだけコメントした人 (deleteCommenter) の名前は他の人に返らなくなる。deleter 本人には返る (S-17)
 *   I-17 名前を出さない設定の本人 (optOut) が POST /api/recipes/[id]/comments で投稿すると、返り値の authorName は本人の表示名。
 *        他の人の詳細では同じコメントの authorName は '匿名' (S-14)
 *   I-18 作者名の表示を書く前の版にだけ同意した作者 (oldConsent)・同意の記録が無い作者 (noConsent) の名前は、公開レシピがあっても
 *        他の人 (未ログイン・ログイン中) に関数から返らない (本人には返る)。oldConsent が作者名の表示を書いた版に同意すると返る
 *        (S-18・R-19。関数を直接呼ぶだけなので段 A。API が関数の結果をそのまま authorName にすることは I-7 が確かめる)
 *
 * 段 A の PR (DB の関数・戻し口) は、関数を直接呼ぶ I-1〜I-6・I-11・I-13・I-14・I-18 だけを置く。レシピの API 経由の
 * I-7〜I-10・I-12・I-15〜I-17 と、それに要る人 (leaver・deleter・deleteCommenter・toggleCommenter)・行 (システムのレシピほか)・
 * apiCall は、段 B の PR (viewer-lookups.ts を関数に差し替える PR) が足す (docs/design/cross/21-recipe-author-display-name.md §15。
 * 段 A の時点の API はまだ関数を呼ばないため)。
 *
 * 同意の版: makePerson は privacy_version_accepted に CONSENTED_PRIVACY_VERSION を入れる (I-18 の 2 人だけ上書きする)。
 *   関数は「作者名の表示を書く前の版の一覧に無い版」を同意済みとみなすので、実在の版 (LEGAL_DOCUMENTS) ではなくテスト専用の値を使う
 *   (文面 (段 C) が効く前は、いまの版が一覧にあり、実在の版を使うと全員が返らなくなるため)。
 *   ローカルの開発サーバーは同意ゲートを強制しない (LEGAL_CONSENT_ENFORCE は既定で off) ので、段 B の API の呼び出しはこの値で止まらない。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。段 A の it は Next の開発サーバーを使わない (PostgREST の RPC を直接呼ぶ。
 *   段 B で API 経由の it を足すと開発サーバーが要る)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/recipe-author-display-names.test.ts
 * 作った行とユーザーは afterAll で消す。本番には接続しない。
 * 生年月日・凍結の列は特権列なので service_role (supabaseAdmin) で入れる (本番で入れるのは accept_legal_documents と運営の凍結)。
 * anon / ログインした利用者のクライアントと pgQuery は、tests/integration/security/anon-definer-execute.test.ts の冒頭と同じ作りで
 * このファイルの中に置く (tests/integration/helpers/supabase.ts の supabaseAnon は呼び出せない Proxy の定数で、JWT を渡す口も pgQuery も無い)。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { ADULT_AGE_YEARS, PROFILE_NAME_PLACEHOLDER } from '@homegohan/shared';
import { supabaseAdmin } from '../helpers/supabase';
import { cleanupTestUser, createTestUserWithRoles, type TestUser } from '../helpers/users';

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

/** 未ログイン (anon キーだけ) のクライアント */
const anon = () => client(anonKey);
/** ログインした利用者 (anon キー + その人の JWT) のクライアント */
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta で SQL を実行する (カタログの確認と、DB の時計の読み取りだけに使う。読み取り専用) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

const TS = Date.now();
const RPC = 'recipe_author_display_names';
/** 既定の呼称 (src/lib/recipes/author-name.ts の RECIPE_AUTHOR_FALLBACK_NAME と同じ値) */
const FALLBACK = '匿名';
/** 18 歳以上と確かめられる生年月日 (ADULT_AGE_YEARS + 12 年前の 1 月 1 日。誕生日の境に掛からない) */
const ADULT_BIRTH_DATE = `${new Date().getFullYear() - ADULT_AGE_YEARS - 12}-01-01`;
/** 18 歳未満の生年月日 (ADULT_AGE_YEARS - 2 年前の 1 月 1 日) */
const MINOR_BIRTH_DATE = `${new Date().getFullYear() - ADULT_AGE_YEARS + 2}-01-01`;
/** 一時凍結の解除予定 (未来・過去) に使う幅 (ミリ秒)。境の 1 日 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** beforeAll / afterAll で、テスト用のユーザー (16 人) と行を作る・消すのを待つ時間 (ミリ秒) */
const SETUP_TIMEOUT_MS = 180_000;
/** 作者名の表示を書いた版に同意済みとして入れる版 (テスト専用の値。§7.1 の一覧 c_privacy_versions_without_author_name に無く、版の形 (英数字・. _ - の 20 文字以内) に合う) */
const CONSENTED_PRIVACY_VERSION = 'test-cross21-consent';
/** 作者名の表示を書く前の版 (§7.1 の一覧にある。選択肢 (a)(b) のどちらでも一覧に入る) */
const OLD_PRIVACY_VERSION = 'v2026.3';

type Person = { user: TestUser; nickname: string };
type AuthorNameRow = { author_id: string; display_name: string };

const people: Record<
  | 'author' | 'minor' | 'noBirth' | 'frozen' | 'tempFrozen' | 'tempFrozenExpired' | 'optOut' | 'noName' | 'privateOnly' | 'commenter' | 'viewer'
  | 'unfreeze' | 'turns18Today' | 'turns18Tomorrow'
  | 'oldConsent' | 'noConsent',
  Person
> = {} as never;
let publicRecipeId: string;

async function makePerson(key: keyof typeof people, profile: Record<string, unknown>): Promise<void> {
  const nickname = `作者${key}${TS}`;
  const user = await createTestUserWithRoles({ email: `sec-author-${key}-${TS}@homegohan.test`, roles: ['user'] });
  // privacy_version_accepted は特権列 (本人は書けない)。service_role は特権列ガードの対象外。profile で上書きできる (I-18)
  const { error } = await supabaseAdmin
    .from('user_profiles')
    .update({ nickname, privacy_version_accepted: CONSENTED_PRIVACY_VERSION, ...profile })
    .eq('id', user.userId);
  if (error) throw new Error(`user_profiles (${key}): ${error.message}`);
  people[key] = { user, nickname };
}

async function namesAs(db: SupabaseClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const { data, error } = await db.rpc(RPC, { p_user_ids: ids });
  if (error) throw new Error(`${RPC}: ${error.message}`);
  return new Map((data as AuthorNameRow[]).map((r) => [r.author_id, r.display_name]));
}

beforeAll(async () => {
  const now = Date.now();
  await makePerson('author', { birth_date: ADULT_BIRTH_DATE });
  await makePerson('minor', { birth_date: MINOR_BIRTH_DATE });
  await makePerson('noBirth', {});
  await makePerson('frozen', { birth_date: ADULT_BIRTH_DATE, frozen_at: new Date(now).toISOString(), unban_at: null });
  await makePerson('tempFrozen', { birth_date: ADULT_BIRTH_DATE, frozen_at: new Date(now).toISOString(), unban_at: new Date(now + ONE_DAY_MS).toISOString() });
  await makePerson('tempFrozenExpired', { birth_date: ADULT_BIRTH_DATE, frozen_at: new Date(now - 2 * ONE_DAY_MS).toISOString(), unban_at: new Date(now - ONE_DAY_MS).toISOString() });
  await makePerson('optOut', { birth_date: ADULT_BIRTH_DATE, show_recipe_author_name: false });
  await makePerson('noName', { birth_date: ADULT_BIRTH_DATE, nickname: PROFILE_NAME_PLACEHOLDER });
  await makePerson('privateOnly', { birth_date: ADULT_BIRTH_DATE });
  await makePerson('commenter', { birth_date: ADULT_BIRTH_DATE });
  await makePerson('viewer', { birth_date: ADULT_BIRTH_DATE });
  await makePerson('unfreeze', { birth_date: ADULT_BIRTH_DATE, frozen_at: new Date(now).toISOString(), unban_at: null });
  // I-14 の 2 人の生年月日は、JST の 0 時をまたがないよう it の中で入れ直す (ここでは 18 歳未満の値で作る)
  await makePerson('turns18Today', { birth_date: MINOR_BIRTH_DATE });
  await makePerson('turns18Tomorrow', { birth_date: MINOR_BIRTH_DATE });
  // I-18 の 2 人 (18 歳以上・名前あり・設定は既定。作者名の表示を書く前の版にだけ同意 / 同意の記録なし)
  await makePerson('oldConsent', { birth_date: ADULT_BIRTH_DATE, privacy_version_accepted: OLD_PRIVACY_VERSION });
  await makePerson('noConsent', { birth_date: ADULT_BIRTH_DATE, privacy_version_accepted: null });

  // 公開レシピ: author のもの 1 件 + 返らない人たちのもの 1 件ずつ (公開レシピがあっても返らないことを確かめる)
  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from('recipes')
    .insert({ user_id: people.author.user.userId, name: `t-cross21-public-${TS}`, is_public: true })
    .select('id')
    .single();
  if (recipeError || !recipe) throw new Error(`recipes: ${recipeError?.message}`);
  publicRecipeId = recipe.id as string;
  for (const key of ['minor', 'noBirth', 'frozen', 'tempFrozen', 'tempFrozenExpired', 'optOut', 'noName', 'unfreeze', 'turns18Today', 'turns18Tomorrow', 'oldConsent', 'noConsent'] as const) {
    const { error } = await supabaseAdmin
      .from('recipes')
      .insert({ user_id: people[key].user.userId, name: `t-cross21-${key}-${TS}`, is_public: true });
    if (error) throw new Error(`recipes (${key}): ${error.message}`);
  }
  // privateOnly の非公開レシピ (I-2 で公開の内容が無い人として返らないこと・I-5 で本人には返ることを確かめる)
  const { error: privError } = await supabaseAdmin
    .from('recipes')
    .insert({ user_id: people.privateOnly.user.userId, name: `t-cross21-private-${TS}`, is_public: false });
  if (privError) throw new Error(`recipes (private): ${privError.message}`);

  // コメント: commenter・optOut・minor (どれも author の公開レシピへ)
  for (const key of ['commenter', 'optOut', 'minor'] as const) {
    const { error } = await supabaseAdmin
      .from('recipe_comments')
      .insert({ recipe_id: publicRecipeId, user_id: people[key].user.userId, content: `t-cross21-comment-${key}-${TS}`, rating: 4 });
    if (error) throw new Error(`recipe_comments (${key}): ${error.message}`);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await supabaseAdmin.from('recipes').delete().like('name', `t-cross21-%-${TS}`);
  for (const p of Object.values(people)) if (p) await cleanupTestUser(p.user.userId);
}, SETUP_TIMEOUT_MS);

describe('I-1〜I-6: 関数 recipe_author_display_names', () => {
  it('I-1: anon が呼ぶと、公開の作者の表示名が返る', async () => {
    const names = await namesAs(anon(), [people.author.user.userId]);
    expect(names.get(people.author.user.userId)).toBe(people.author.nickname);
  });

  it('I-2: 18 歳未満・生年月日なし・凍結中・設定オフ・名前なし・公開の内容が無い人は返らない', async () => {
    const keys = ['minor', 'noBirth', 'frozen', 'tempFrozen', 'optOut', 'noName', 'privateOnly', 'viewer'] as const;
    const names = await namesAs(anon(), keys.map((k) => people[k].user.userId));
    expect([...names.keys()]).toEqual([]);
  });

  it('I-3: 一時凍結の期限が過ぎた人は返る', async () => {
    const names = await namesAs(anon(), [people.tempFrozenExpired.user.userId]);
    expect(names.get(people.tempFrozenExpired.user.userId)).toBe(people.tempFrozenExpired.nickname);
  });

  it('I-4: 公開レシピへのコメントだけの人も返る', async () => {
    const names = await namesAs(anon(), [people.commenter.user.userId]);
    expect(names.get(people.commenter.user.userId)).toBe(people.commenter.nickname);
  });

  it('I-5: 本人には自分の名前が返る (非公開だけ・設定オフ・18 歳未満)。他の人には返らない', async () => {
    for (const key of ['privateOnly', 'optOut', 'minor'] as const) {
      const self = await namesAs(asUser(people[key].user.jwt), [people[key].user.userId]);
      expect(self.get(people[key].user.userId), `${key} 本人`).toBe(people[key].nickname);
      const other = await namesAs(asUser(people.viewer.user.jwt), [people[key].user.userId]);
      expect(other.has(people[key].user.userId), `${key} を viewer から`).toBe(false);
    }
  });

  it('I-6: 重複・NULL・知らない id は無視。空の配列は 0 行', async () => {
    const id = people.author.user.userId;
    const names = await namesAs(anon(), [id, id, null, '00000000-0000-0000-0000-000000000000']);
    expect([...names.entries()]).toEqual([[id, people.author.nickname]]);
    expect([...(await namesAs(anon(), [])).keys()]).toEqual([]);
  });
});

describe('I-11: 権限・RLS', () => {
  it('I-11: EXECUTE は anon と authenticated だけ。user_profiles の SELECT のポリシーは本人の行だけの 1 本', async () => {
    const acl = await pgQuery<{ role: string; can: boolean }>(`
      SELECT r.role, has_function_privilege(r.role, 'public.recipe_author_display_names(uuid[])', 'EXECUTE') AS can
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
    `);
    expect(Object.fromEntries(acl.map((a) => [a.role, a.can]))).toEqual({ anon: true, authenticated: true, service_role: false });
    const pub = await pgQuery<{ public_exec: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
             aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE n.nspname = 'public' AND p.proname = 'recipe_author_display_names' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
      ) AS public_exec
    `);
    expect(pub[0]?.public_exec).toBe(false);
    const policies = await pgQuery<{ policyname: string; qual: string }>(`
      SELECT policyname, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles' AND cmd = 'SELECT'
    `);
    expect(policies).toEqual([{ policyname: 'Users can view own profile', qual: '(auth.uid() = id)' }]);
  });
});

describe('I-13〜I-14: 凍結の解除・18 歳の誕生日の境', () => {
  it('I-13: 凍結を解除 (frozen_at を NULL) すると名前が返る', async () => {
    const id = people.unfreeze.user.userId;
    expect((await namesAs(anon(), [id])).has(id), '凍結中').toBe(false);
    const { error } = await supabaseAdmin.from('user_profiles').update({ frozen_at: null, unban_at: null }).eq('id', id);
    expect(error).toBeNull();
    expect((await namesAs(anon(), [id])).get(id), '解除のあと').toBe(people.unfreeze.nickname);
  });

  it('I-14: 今日が 18 歳の誕生日 (JST) の人は返り、明日が 18 歳の誕生日の人は返らない', async () => {
    // 関数 (age_years_jst) と同じ DB の時計で、JST の今日から ADULT_AGE_YEARS 年前 (と、その翌日) を作る。
    // 2 月 29 日は、PG の date - interval が平年の 2 月 28 日にし、age_years_jst も同じ日に 18 とするので、境の意味は変わらない
    const [d] = await pgQuery<{ birthday_today: string; birthday_tomorrow: string }>(`
      SELECT to_char(((now() AT TIME ZONE 'Asia/Tokyo')::date - make_interval(years => ${ADULT_AGE_YEARS}))::date, 'YYYY-MM-DD') AS birthday_today,
             to_char(((now() AT TIME ZONE 'Asia/Tokyo')::date - make_interval(years => ${ADULT_AGE_YEARS}))::date + 1, 'YYYY-MM-DD') AS birthday_tomorrow
    `);
    const today = people.turns18Today.user.userId;
    const tomorrow = people.turns18Tomorrow.user.userId;
    // birth_date は特権列 (本人は書けない)。service_role は特権列ガードの対象外
    for (const [id, birthDate] of [[today, d.birthday_today], [tomorrow, d.birthday_tomorrow]] as const) {
      const { error } = await supabaseAdmin.from('user_profiles').update({ birth_date: birthDate }).eq('id', id);
      expect(error).toBeNull();
    }
    const names = await namesAs(anon(), [today, tomorrow]);
    expect(names.get(today), '今日が 18 歳の誕生日').toBe(people.turns18Today.nickname);
    expect(names.has(tomorrow), '明日が 18 歳の誕生日 (今日は 17 歳)').toBe(false);
  });
});

describe('I-18: 作者名の表示を書いた版への同意 (K-同意)', () => {
  it('I-18: 書く前の版にだけ同意した作者と同意の記録が無い作者の名前は他の人に返らず、書いた版に同意すると返る', async () => {
    const oldConsent = people.oldConsent.user.userId;
    const noConsent = people.noConsent.user.userId;
    // どちらも公開レシピを持つ (beforeAll) が、同意の条件で返らない
    for (const db of [anon(), asUser(people.viewer.user.jwt)]) {
      const names = await namesAs(db, [oldConsent, noConsent]);
      expect([...names.keys()], '同意の前').toEqual([]);
    }
    // 本人には自分の名前 ((a))
    for (const key of ['oldConsent', 'noConsent'] as const) {
      const self = await namesAs(asUser(people[key].user.jwt), [people[key].user.userId]);
      expect(self.get(people[key].user.userId), `${key} 本人`).toBe(people[key].nickname);
    }

    // oldConsent が作者名の表示を書いた版に同意する (本番は accept_legal_documents が書く。特権列なので service_role で入れる)
    const { error } = await supabaseAdmin
      .from('user_profiles')
      .update({ privacy_version_accepted: CONSENTED_PRIVACY_VERSION })
      .eq('id', oldConsent);
    expect(error).toBeNull();
    const after = await namesAs(anon(), [oldConsent, noConsent]);
    expect(after.get(oldConsent), '同意のあとの oldConsent').toBe(people.oldConsent.nickname);
    expect(after.has(noConsent), '同意の記録が無いままの noConsent').toBe(false);
  });
});
