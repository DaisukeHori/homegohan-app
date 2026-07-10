/**
 * #1041 (F4-04) 回帰防止テスト
 * src/lib/admin/moderation-backend.ts — 実テーブル (moderation_flags / recipe_flags)
 * アクセス層のユニットテスト。
 *
 * 重要な回帰防止観点:
 *  - 実在しない `moderation_items` テーブルを参照していないこと
 *  - BAN 対象ユーザーはコンテンツ所有者 (meals.user_id / recipes.user_id) であり、
 *    フラグ行自身の user_id/reporter_id (通報者) ではないこと
 *  - DB エラー時は空配列/null に丸めず例外を throw する (呼び出し側で fail-closed にするため)
 *  - ai_content はバックエンドテーブル未実装のため isModerationBacked が false を返すこと
 */
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';
import {
  countModeration,
  fetchModerationList,
  fetchModerationSingle,
  isModerationBacked,
  resolveModerationItem,
} from '@/lib/admin/moderation-backend';

describe('moderation-backend', () => {
  describe('isModerationBacked', () => {
    it('food / recipe はバックエンドあり', () => {
      expect(isModerationBacked('food')).toBe(true);
      expect(isModerationBacked('recipe')).toBe(true);
    });

    it('ai_content はバックエンドテーブル未実装のため false', () => {
      expect(isModerationBacked('ai_content')).toBe(false);
    });
  });

  describe('fetchModerationList', () => {
    it('food: moderation_flags を参照し、user_id は meals.user_id (コンテンツ所有者) を使う', async () => {
      const supabase = createFakeSupabase({
        moderation_flags: [
          {
            data: [
              {
                id: 'flag-1',
                status: 'pending',
                reason: 'inappropriate',
                resolution_note: null,
                resolved_by: null,
                resolved_at: null,
                created_at: '2026-01-01T00:00:00Z',
                // moderation_flags.user_id (通報者) はあえて別人にしておき、
                // BAN 対象が meals.user_id を優先することを検証する
                user_id: 'reporter-user-id',
                meal_id: 'meal-1',
                meals: { user_id: 'owner-user-id', photo_url: 'https://example.com/meal.jpg' },
              },
            ],
            error: null,
          },
        ],
      });

      const items = await fetchModerationList(supabase as never, 'food', 'pending', 50);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: 'flag-1',
        type: 'food',
        content_url: 'https://example.com/meal.jpg',
        reporter_count: 1,
        user_id: 'owner-user-id', // reporter-user-id ではないこと
        status: 'pending',
      });
    });

    it('recipe: recipe_flags を参照し、resolution_note は常に null (列が存在しないため)。content_url は recipes.image_url を使う (#1041 round-2 G)', async () => {
      const supabase = createFakeSupabase({
        recipe_flags: [
          {
            data: [
              {
                id: 'rflag-1',
                status: 'pending',
                reason: 'spam',
                reviewed_by: null,
                reviewed_at: null,
                created_at: '2026-01-02T00:00:00Z',
                reporter_id: 'reporter-2',
                recipe_id: 'recipe-1',
                recipes: { user_id: 'recipe-owner-1', image_url: 'https://example.com/recipe.jpg' },
              },
            ],
            error: null,
          },
        ],
      });

      const items = await fetchModerationList(supabase as never, 'recipe', 'pending', 50);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: 'rflag-1',
        type: 'recipe',
        content_url: 'https://example.com/recipe.jpg',
        user_id: 'recipe-owner-1',
        resolution_note: null,
      });
    });

    it('recipe: recipes.image_url が無い場合は content_url を null にする (捏造しない)', async () => {
      const supabase = createFakeSupabase({
        recipe_flags: [
          {
            data: [
              {
                id: 'rflag-2',
                status: 'pending',
                reason: 'spam',
                reviewed_by: null,
                reviewed_at: null,
                created_at: '2026-01-02T00:00:00Z',
                reporter_id: 'reporter-3',
                recipe_id: 'recipe-2',
                recipes: { user_id: 'recipe-owner-2', image_url: null },
              },
            ],
            error: null,
          },
        ],
      });

      const items = await fetchModerationList(supabase as never, 'recipe', 'pending', 50);
      expect(items[0].content_url).toBeNull();
    });

    it('DB エラー時は空配列にフォールバックせず例外を throw する (fail-closed)', async () => {
      const supabase = createFakeSupabase({
        moderation_flags: [{ data: null, error: { message: 'connection reset' } }],
      });

      await expect(fetchModerationList(supabase as never, 'food', 'pending', 50)).rejects.toBeTruthy();
    });
  });

  describe('fetchModerationSingle', () => {
    it('見つからない場合は null を返す (エラーではない)', async () => {
      const supabase = createFakeSupabase({
        moderation_flags: [{ data: null, error: null }],
      });
      const item = await fetchModerationSingle(supabase as never, 'food', 'nonexistent');
      expect(item).toBeNull();
    });

    it('DB エラー時は null を返さず例外を throw する (404 に丸めない)', async () => {
      const supabase = createFakeSupabase({
        moderation_flags: [{ data: null, error: { message: 'timeout' } }],
      });
      await expect(fetchModerationSingle(supabase as never, 'food', 'x')).rejects.toBeTruthy();
    });
  });

  describe('resolveModerationItem', () => {
    it('food: moderation_flags を resolved_by/resolved_at/resolution_note で更新する', async () => {
      const supabase = createFakeSupabase({
        moderation_flags: [{ data: null, error: null }],
      });

      await resolveModerationItem(supabase as never, 'food', 'flag-1', {
        status: 'approved',
        resolvedBy: 'admin-1',
        resolutionNote: 'OK',
      });

      expect(supabase.from).toHaveBeenCalledWith('moderation_flags');
    });

    it('recipe: recipe_flags を reviewed_by/reviewed_at で更新する (resolution_note 列は使わない)', async () => {
      const supabase = createFakeSupabase({
        recipe_flags: [{ data: null, error: null }],
      });

      await resolveModerationItem(supabase as never, 'recipe', 'rflag-1', {
        status: 'rejected',
        resolvedBy: 'admin-2',
        resolutionNote: 'NG',
      });

      expect(supabase.from).toHaveBeenCalledWith('recipe_flags');
    });

    it('更新エラー時は例外を throw する', async () => {
      const supabase = createFakeSupabase({
        moderation_flags: [{ data: null, error: { message: 'update failed' } }],
      });

      await expect(
        resolveModerationItem(supabase as never, 'food', 'flag-1', {
          status: 'approved',
          resolvedBy: 'admin-1',
          resolutionNote: null,
        }),
      ).rejects.toBeTruthy();
    });
  });

  describe('countModeration', () => {
    it('count を返す', async () => {
      const supabase = createFakeSupabase({
        moderation_flags: [{ data: null, error: null, count: 3 }],
      });
      const count = await countModeration(supabase as never, 'food', 'pending');
      expect(count).toBe(3);
    });

    it('DB エラー時は例外を throw する', async () => {
      const supabase = createFakeSupabase({
        recipe_flags: [{ data: null, error: { message: 'boom' } }],
      });
      await expect(countModeration(supabase as never, 'recipe', 'pending')).rejects.toBeTruthy();
    });
  });
});
