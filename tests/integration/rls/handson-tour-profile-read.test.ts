/**
 * #1040 / #1306 ハンズオンツアー (Step1 写真 / Step2 献立) が、ログイン本人として読むプロフィール系の問い合わせの回帰テスト
 *
 * ツアーのページはブラウザの supabase クライアント (anon キー + ログイン本人の JWT = RLS が掛かる) で
 * 次の問い合わせをする。以前は存在しない列 (user_profiles.allergies / dislikes / target_kcal_per_day) を
 * select しており、PostgREST が 42703 で失敗しても error を見ていなかったため、
 * ニックネームを含むパーソナライズが全員分「空」のままだった。
 * 単体テストは Supabase をモックするので列や RLS の有無を見ない。ここでは、ページが使う取得関数
 * (src/lib/handson-tour/tour-profile.ts) を、実際の PostgREST (本番スキーマ + RLS) に対してそのまま実行して確認する。
 *   - Step2: user_profiles の nickname / diet_flags (アレルギー・苦手な食材) / cooking_experience を本人が読める
 *   - Step1: user_profiles.nickname と nutrition_targets.daily_calories (目標カロリー) を本人が読める
 *   - 行が無い (diet_flags が NULL / nutrition_targets の行が無い) のは失敗ではなく、既定値になる
 *   - 他人・未ログインの行は RLS で見えない (エラーにはならず、行が無いのと同じ既定値になる)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/handson-tour-profile-read.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import {
  EMPTY_MENU_TOUR_PROFILE,
  EMPTY_PHOTO_TOUR_PROFILE,
  fetchMenuTourProfile,
  fetchPhotoTourProfile,
} from '../../../src/lib/handson-tour/tour-profile';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ---------------------------------------------------------------
// クライアントファクトリ (user-badges-insert.test.ts と同型)
// ---------------------------------------------------------------
function anonClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function serviceRoleClient(): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

/** ブラウザの createClient() 相当: anon キー + ログイン本人の JWT (RLS が掛かる) */
function authedClient(accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const srAdmin = serviceRoleClient();

// ---------------------------------------------------------------
// テストユーザー (使い捨て。ローカル専用のパスワード)
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  email: string;
  client: SupabaseClient;
}

const TS = Date.now();
const created: string[] = [];

async function createTestUser(
  label: string,
  profile: Record<string, unknown>,
  nutritionTarget?: Record<string, unknown>,
): Promise<TestUser> {
  const email = `rls-1040-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-rls';

  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user ${email}: ${authError?.message}`);
  }
  const userId = authData.user.id;
  created.push(userId);

  // user_profiles の必須列は nickname / age_group / gender (行が既にあっても上書きできるよう upsert)
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: `Tour ${label}`, age_group: '30s', gender: 'other', ...profile }, { onConflict: 'id' });
  if (profileError) throw new Error(`Failed to upsert profile for ${email}: ${profileError.message}`);

  if (nutritionTarget) {
    const { error: targetError } = await srAdmin.from('nutrition_targets').insert({ user_id: userId, ...nutritionTarget });
    if (targetError) throw new Error(`Failed to insert nutrition_targets for ${email}: ${targetError.message}`);
  }

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signIn = await anonClient().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`Failed to sign in ${email}: ${signIn.error?.message}`);
  }
  return { userId, email, client: authedClient(signIn.data.session.access_token) };
}

// ---------------------------------------------------------------
// フィクスチャ
//   owner: アレルギー等を答え、目標カロリーも計算済みの人
//   bare : diet_flags が NULL で、nutrition_targets の行も無い人 (オンボーディングの栄養目標計算に失敗した人など)
//   other: 別のログインユーザー (他人の行が見えないことの確認用)
// ---------------------------------------------------------------
let owner: TestUser;
let bare: TestUser;
let other: TestUser;

beforeAll(async () => {
  owner = await createTestUser(
    'owner',
    {
      nickname: 'はなこ',
      diet_flags: { allergies: ['えび', '卵'], dislikes: ['セロリ'] },
      cooking_experience: 'advanced',
    },
    { daily_calories: 2000 },
  );
  bare = await createTestUser('bare', { nickname: 'たろう', diet_flags: null });
  other = await createTestUser('other', { nickname: 'べつの人' });
}, 60_000);

afterAll(async () => {
  for (const userId of created) {
    await srAdmin.from('nutrition_targets').delete().eq('user_id', userId);
    await srAdmin.from('user_profiles').delete().eq('id', userId);
    await srAdmin.auth.admin.deleteUser(userId);
  }
}, 60_000);

// ---------------------------------------------------------------
// テスト
// ---------------------------------------------------------------
describe('Step2 献立ツアー: 本人として user_profiles を読む', () => {
  it('nickname / diet_flags のアレルギー・苦手な食材 / cooking_experience を取得できる (失敗なし)', async () => {
    const result = await fetchMenuTourProfile(owner.client, owner.userId);

    expect(result.failures).toEqual([]);
    expect(result.profile).toEqual({
      nickname: 'はなこ',
      allergies: ['えび', '卵'],
      dislikes: ['セロリ'],
      cooking_experience: 'advanced',
    });
  });

  it('diet_flags が NULL の人は除外食材が空になるだけで、失敗にはならない (料理経験は既定値 beginner)', async () => {
    const result = await fetchMenuTourProfile(bare.client, bare.userId);

    expect(result.failures).toEqual([]);
    expect(result.profile).toEqual({
      nickname: 'たろう',
      allergies: [],
      dislikes: [],
      cooking_experience: 'beginner',
    });
  });
});

describe('Step1 写真ツアー: 本人として user_profiles と nutrition_targets を読む', () => {
  it('nickname と nutrition_targets.daily_calories (目標カロリー) を取得できる (失敗なし)', async () => {
    const result = await fetchPhotoTourProfile(owner.client, owner.userId);

    expect(result.failures).toEqual([]);
    expect(result.profile).toEqual({ nickname: 'はなこ', target_kcal: 2000 });
  });

  it('nutrition_targets の行が無い人は target_kcal が null になるだけで、失敗にはならない', async () => {
    const result = await fetchPhotoTourProfile(bare.client, bare.userId);

    expect(result.failures).toEqual([]);
    expect(result.profile).toEqual({ nickname: 'たろう', target_kcal: null });
  });
});

describe('他人・未ログインの行は RLS で見えない (エラーではなく、行が無いのと同じ既定値)', () => {
  it('別のログインユーザーは、owner の diet_flags / 目標カロリーを読めない', async () => {
    const menu = await fetchMenuTourProfile(other.client, owner.userId);
    expect(menu).toEqual({ profile: EMPTY_MENU_TOUR_PROFILE, failures: [] });

    const photo = await fetchPhotoTourProfile(other.client, owner.userId);
    expect(photo).toEqual({ profile: EMPTY_PHOTO_TOUR_PROFILE, failures: [] });
  });

  it('未ログイン (anon) は、owner の diet_flags / 目標カロリーを読めない', async () => {
    const menu = await fetchMenuTourProfile(anonClient(), owner.userId);
    expect(menu).toEqual({ profile: EMPTY_MENU_TOUR_PROFILE, failures: [] });

    const photo = await fetchPhotoTourProfile(anonClient(), owner.userId);
    expect(photo).toEqual({ profile: EMPTY_PHOTO_TOUR_PROFILE, failures: [] });
  });
});
