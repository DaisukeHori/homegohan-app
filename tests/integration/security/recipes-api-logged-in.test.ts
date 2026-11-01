/**
 * #1917 ログイン中のレシピの API (一覧・詳細・コメント) が、本物の PostgREST (ローカル Supabase) で 200 を返すことの結合テスト
 *
 * 以前: 作者の名前とログイン中の人のいいねを、select の埋め込み (`user_profiles(nickname)`・`recipe_likes(user_id)`) で読んでいた。
 *   recipes / recipe_comments から user_profiles への外部キーは無く (user_id の外部キーは auth.users 宛。PGRST200)、
 *   recipe_likes から recipes への外部キーは 2 本ある (recipe_id・recipe_uuid。PGRST201) ので、PostgREST はどちらも解決できない。
 *   GET /api/recipes はログイン中だけこの埋め込みを使い、失敗を 200 の空の一覧で隠していた (DB の失敗を 500 にした #1917 の途中で、
 *   ログイン中はいつも 500 になった)。詳細 (GET /api/recipes/[id]) とコメント (GET / POST /api/recipes/[id]/comments) はいつも 500 だった。
 *   単体テスト (tests/recipes-route.test.ts ほか) は DB をモックするので、これが見えない。
 * 修正後: 埋め込まずに、user_profiles と recipe_likes を別のクエリで引く (src/lib/recipes/viewer-lookups.ts)。
 *   解決できない埋め込みは tests/postgrest-embed-relationship-scan.test.ts が src の全域で見張る。
 *
 * 確かめること (本人の非公開のレシピ 1 件・本人のいいね・本人のコメント。user_profiles の RLS で、本人は自分の名前を読める):
 *   - GET /api/recipes?q=<名前>: 200。そのレシピを返し、authorName は本人の nickname、isLiked は true
 *   - GET /api/recipes/[id]: 200。authorName・isLiked・コメントの authorName
 *   - GET /api/recipes/[id]/comments: 200。authorName。書いた人の user_id は返さない
 *   - POST /api/recipes/[id]/comments: 200。authorName
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next の開発サーバー。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/recipes-api-logged-in.test.ts
 *   (開発サーバーが 3000 番以外なら INTEGRATION_BASE_URL=http://localhost:<port> を付ける)
 * 作った行とユーザーは afterAll で消す。本番には接続しない。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCall } from '../helpers/api';
import { supabaseAdmin } from '../helpers/supabase';
import { cleanupTestUser, createTestUserWithRoles, type TestUser } from '../helpers/users';

const TS = Date.now();
/** 検索で 1 件に絞れる、このテストだけのレシピ名 */
const RECIPE_NAME = `t1917recipe${TS}`;
/** 本人の nickname (authorName に出る) */
const NICKNAME = `レシピの作者${TS}`;
/** 本人のコメント */
const COMMENT_TEXT = `t1917comment${TS}`;
/** コメントの評価 (recipe_comments の検査は 1〜5) */
const COMMENT_RATING = 4;
/** 開発サーバーが最初の要求でルートをコンパイルするのを待つ時間 (ミリ秒)。結合テストの既定の時間切れより長い */
const FIRST_COMPILE_TIMEOUT_MS = 180_000;

let owner: TestUser;
let other: TestUser;
let recipeId: string;

type RecipeListBody = { recipes: Array<{ id: string; name: string; authorName: string; isLiked: boolean }> };
type RecipeDetailBody = {
  recipe: {
    id: string;
    authorName: string;
    isLiked: boolean;
    isOwner: boolean;
    comments: Array<{ content: string; authorName: string }>;
  };
};
type CommentsBody = { comments: Array<Record<string, unknown>> };
type PostedCommentBody = { success: boolean; comment: { content: string; authorName: string } };

beforeAll(async () => {
  owner = await createTestUserWithRoles({ email: `sec-recipes-api-${TS}@homegohan.test`, roles: ['user'] });
  other = await createTestUserWithRoles({ email: `sec-recipes-api-other-${TS}@homegohan.test`, roles: ['user'] });
  const { error: profileError } = await supabaseAdmin.from('user_profiles').update({ nickname: NICKNAME }).eq('id', owner.userId);
  if (profileError) throw new Error(`user_profiles.nickname: ${profileError.message}`);

  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from('recipes')
    .insert({ user_id: owner.userId, name: RECIPE_NAME, is_public: false })
    .select('id')
    .single();
  if (recipeError || !recipe) throw new Error(`recipes: ${recipeError?.message}`);
  recipeId = recipe.id as string;

  const { error: likeError } = await supabaseAdmin.from('recipe_likes').insert({ user_id: owner.userId, recipe_id: recipeId });
  if (likeError) throw new Error(`recipe_likes: ${likeError.message}`);
  const { error: commentError } = await supabaseAdmin
    .from('recipe_comments')
    .insert({ recipe_id: recipeId, user_id: owner.userId, content: COMMENT_TEXT, rating: COMMENT_RATING });
  if (commentError) throw new Error(`recipe_comments: ${commentError.message}`);

  // 開発サーバーは最初の要求でルートをコンパイルするため遅い。テスト本体の時間切れに入らないよう、先に 1 回ずつ呼んでおく
  await apiCall('GET', `/api/recipes?q=${encodeURIComponent(RECIPE_NAME)}`, null);
  await apiCall('GET', `/api/recipes/${recipeId}`, null);
  await apiCall('GET', `/api/recipes/${recipeId}/comments`, null);
}, FIRST_COMPILE_TIMEOUT_MS);

afterAll(async () => {
  if (recipeId) {
    // コメントといいねはレシピの削除 (ON DELETE CASCADE) でも消えるが、先に明示的に消す
    await supabaseAdmin.from('recipe_comments').delete().eq('recipe_id', recipeId);
    await supabaseAdmin.from('recipe_likes').delete().eq('recipe_id', recipeId);
    await supabaseAdmin.from('recipes').delete().eq('id', recipeId);
  }
  if (owner) await cleanupTestUser(owner.userId);
  if (other) await cleanupTestUser(other.userId);
}, FIRST_COMPILE_TIMEOUT_MS);

describe('ログイン中のレシピの API は、埋め込みを使わずに作者の名前といいねを返す (#1917)', () => {
  it('GET /api/recipes: 200。自分のレシピを返し、作者の名前は自分の nickname、いいねは true (以前は空の 200 → 500)', async () => {
    const res = await apiCall<RecipeListBody>('GET', `/api/recipes?q=${encodeURIComponent(RECIPE_NAME)}`, owner.jwt);

    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.recipes).toHaveLength(1);
    expect(res.body.recipes[0]).toMatchObject({ id: recipeId, name: RECIPE_NAME, authorName: NICKNAME, isLiked: true });
  });

  it('GET /api/recipes/[id]: 200。作者の名前・いいね・コメントの作者の名前 (以前はいつも 500)', async () => {
    const res = await apiCall<RecipeDetailBody>('GET', `/api/recipes/${recipeId}`, owner.jwt);

    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.recipe).toMatchObject({ id: recipeId, authorName: NICKNAME, isLiked: true, isOwner: true });
    expect(res.body.recipe.comments).toEqual([expect.objectContaining({ content: COMMENT_TEXT, authorName: NICKNAME })]);
  });

  it('GET /api/recipes/[id]/comments: 200。書いた人の名前を返し、user_id は返さない (以前はいつも 500)', async () => {
    const res = await apiCall<CommentsBody>('GET', `/api/recipes/${recipeId}/comments`, owner.jwt);

    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.comments).toEqual([expect.objectContaining({ content: COMMENT_TEXT, authorName: NICKNAME })]);
    expect(JSON.stringify(res.body)).not.toContain(owner.userId);
  });

  it('POST /api/recipes/[id]/comments: 200。自分の名前を返す (以前はいつも 500)', async () => {
    const content = `${COMMENT_TEXT}-posted`;
    const res = await apiCall<PostedCommentBody>('POST', `/api/recipes/${recipeId}/comments`, owner.jwt, { content });

    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body).toMatchObject({ success: true, comment: { content, authorName: NICKNAME } });
  });
});

describe('他人から見た非公開のレシピのコメント (cross/25。#2166 X1)', () => {
  it('A-1: GET /api/recipes/[id]/comments: 他人には非公開のレシピのコメントが 0 件 (200。以前は作者のコメントが返った)', async () => {
    const res = await apiCall<CommentsBody>('GET', `/api/recipes/${recipeId}/comments`, other.jwt);

    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.comments).toEqual([]);
  });

  it('A-2: GET /api/recipes/[id]: 他人には非公開のレシピが 404 (今までどおり)', async () => {
    const res = await apiCall('GET', `/api/recipes/${recipeId}`, other.jwt);

    expect(res.status).toBe(404);
  });
});
