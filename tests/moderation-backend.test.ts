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
 *  - (#1101) 通報されたコンテンツ本体の ID (meals.id / recipes.id) を content_id として返し、
 *    hideModeratedContent がその行 (通報の行ではない) の hidden_* だけを更新すること。食事は、家族へのペーストの複製
 *    (同じ paste_group_id) もまとめて隠すこと
 */
import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';
import {
  countModeration,
  fetchModerationList,
  fetchModerationSingle,
  hideModeratedContent,
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
        content_id: 'meal-1', // 通報の ID (flag-1) ではなく、通報されたコンテンツ本体の ID
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
        content_id: 'recipe-1',
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

    it('#1101 food: 通報にコンテンツが紐づかない (meal_id が null) ときは content_id も user_id も null', async () => {
      const supabase = createFakeSupabase({
        moderation_flags: [
          {
            data: { id: 'flag-orphan', status: 'pending', user_id: 'reporter-1', meal_id: null, meals: null },
            error: null,
          },
        ],
      });
      const item = await fetchModerationSingle(supabase as never, 'food', 'flag-orphan');
      expect(item).toMatchObject({ id: 'flag-orphan', content_id: null, user_id: null, content_url: null });
    });

    it('#1101 recipe: content_id は recipe_flags.recipe_id (レシピ本体の ID)。通報の ID ではない', async () => {
      const supabase = createFakeSupabase({
        recipe_flags: [
          {
            data: {
              id: 'rflag-9',
              status: 'pending',
              reporter_id: 'reporter-1',
              recipe_id: 'recipe-9',
              recipes: { user_id: 'owner-9', image_url: null },
            },
            error: null,
          },
        ],
      });
      const item = await fetchModerationSingle(supabase as never, 'recipe', 'rflag-9');
      expect(item).toMatchObject({ id: 'rflag-9', content_id: 'recipe-9', user_id: 'owner-9' });
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

  describe('hideModeratedContent (#1101)', () => {
    const params = { hiddenBy: 'admin-1', reason: 'moderation:delete_only' };

    type Builder = {
      select: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      is: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      maybeSingle: ReturnType<typeof vi.fn>;
    };
    /** n 回目の `.from()` が返したクエリビルダー (select / update / eq / is の呼び出しを調べる) */
    function builderAt(supabase: ReturnType<typeof createFakeSupabase>, index: number) {
      return supabase.from.mock.results[index]!.value as Builder;
    }

    it('food: まず通報された食事の paste_group_id を読み、ペーストの複製が無ければその行だけに hidden_at / hidden_by / hidden_reason を書く。行は消さず、通報 (moderation_flags) には触れない', async () => {
      const supabase = createFakeSupabase({
        meals: [
          { data: { paste_group_id: null }, error: null },
          { data: [{ id: 'meal-1' }], error: null },
        ],
      });
      const before = Date.now();

      const hiddenIds = await hideModeratedContent(supabase as never, 'food', 'meal-1', params);

      expect(hiddenIds).toEqual(['meal-1']);
      expect(supabase.from).toHaveBeenCalledTimes(2);
      expect(supabase.from.mock.calls.map((c) => c[0])).toEqual(['meals', 'meals']);
      const lookup = builderAt(supabase, 0);
      expect(lookup.select).toHaveBeenCalledWith('paste_group_id');
      expect(lookup.eq).toHaveBeenCalledWith('id', 'meal-1');
      expect(lookup.update).not.toHaveBeenCalled();

      const builder = builderAt(supabase, 1);
      const payload = builder.update.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['hidden_at', 'hidden_by', 'hidden_reason']);
      expect(Date.parse(payload.hidden_at as string)).toBeGreaterThanOrEqual(before);
      expect(payload.hidden_by).toBe('admin-1');
      expect(payload.hidden_reason).toBe('moderation:delete_only');
      expect(builder.eq).toHaveBeenCalledWith('id', 'meal-1');
      expect(builder.eq).not.toHaveBeenCalledWith('paste_group_id', expect.anything());
      expect(builder.select).toHaveBeenCalledWith('id');
      expect(builder.delete).not.toHaveBeenCalled();
    });

    it('food: 家族へのペーストの複製がある (paste_group_id がある) ときは、同じ paste_group_id の行 (元の行と複製) をまとめて隠し、隠した行の ID をすべて返す', async () => {
      const supabase = createFakeSupabase({
        meals: [
          { data: { paste_group_id: 'group-1' }, error: null },
          { data: [{ id: 'meal-1' }, { id: 'meal-copy-a' }, { id: 'meal-copy-b' }], error: null },
        ],
      });

      const hiddenIds = await hideModeratedContent(supabase as never, 'food', 'meal-1', params);

      expect(hiddenIds).toEqual(['meal-1', 'meal-copy-a', 'meal-copy-b']);
      const builder = builderAt(supabase, 1);
      expect(builder.eq).toHaveBeenCalledWith('paste_group_id', 'group-1');
      expect(builder.eq).not.toHaveBeenCalledWith('id', 'meal-1');
      expect(builder.is).toHaveBeenCalledWith('hidden_at', null);
      expect(builder.delete).not.toHaveBeenCalled();
    });

    it('food: 通報された食事がもう無い (持ち主が先に消した等) ときは、何も更新せずに空の一覧を返す (失敗ではない)', async () => {
      const supabase = createFakeSupabase({ meals: [{ data: null, error: null }] });

      await expect(hideModeratedContent(supabase as never, 'food', 'meal-gone', params)).resolves.toEqual([]);
      expect(supabase.from).toHaveBeenCalledTimes(1);
      expect(builderAt(supabase, 0).update).not.toHaveBeenCalled();
    });

    it('food: paste_group_id の読み取りでエラーになったら例外を throw する (隠さずに成功を装わない)', async () => {
      const supabase = createFakeSupabase({ meals: [{ data: null, error: { message: 'connection reset' } }] });

      await expect(hideModeratedContent(supabase as never, 'food', 'meal-1', params)).rejects.toMatchObject({
        message: 'connection reset',
      });
      expect(supabase.from).toHaveBeenCalledTimes(1);
    });

    it('recipe: recipes の該当行だけを隠す (レシピには複製の仕組みが無いので、読み取りはしない)', async () => {
      const supabase = createFakeSupabase({ recipes: [{ data: [{ id: 'recipe-1' }], error: null }] });

      const hiddenIds = await hideModeratedContent(supabase as never, 'recipe', 'recipe-1', params);

      expect(hiddenIds).toEqual(['recipe-1']);
      expect(supabase.from).toHaveBeenCalledTimes(1);
      expect(supabase.from).toHaveBeenCalledWith('recipes');
      expect(builderAt(supabase, 0).eq).toHaveBeenCalledWith('id', 'recipe-1');
      expect(builderAt(supabase, 0).update).toHaveBeenCalledTimes(1);
    });

    it('すでに隠れている行は上書きしない (hidden_at IS NULL の行だけ更新する)。保管期間の起点を延ばさない。隠した行が無ければ空の一覧', async () => {
      const supabase = createFakeSupabase({
        meals: [
          { data: { paste_group_id: null }, error: null },
          { data: [], error: null },
        ],
      });

      await expect(hideModeratedContent(supabase as never, 'food', 'meal-1', params)).resolves.toEqual([]);

      expect(builderAt(supabase, 1).is).toHaveBeenCalledWith('hidden_at', null);
    });

    it('更新エラー時は例外を throw する (呼び出し側が「隠せなかった」と明示できるように)', async () => {
      const supabase = createFakeSupabase({
        meals: [
          { data: { paste_group_id: null }, error: null },
          { data: null, error: { message: 'permission denied' } },
        ],
      });

      await expect(hideModeratedContent(supabase as never, 'food', 'meal-1', params)).rejects.toMatchObject({
        message: 'permission denied',
      });
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
