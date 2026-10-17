// @vitest-environment node
/**
 * #1538 運営が隠したコンテンツを戻す部品 (src/lib/admin/hidden-content-restore.ts) の単体テスト
 * 設計: docs/design/operator/13-hidden-content-restore.md §13.2 (U-1〜U-14)
 *
 * DB は tests/helpers/fake-supabase.ts の偽物に差し替える (同じ表への .from() は、積んだ結果を呼んだ順に返す)。
 * 本物の DB での確かめは tests/integration/rls/hidden-content-restore.test.ts。
 */
import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase, type FakeSupabase } from './helpers/fake-supabase';
import {
  HIDDEN_CONTENT_RESTORE_WINDOW_DAYS,
  HiddenContentRestoreStepError,
  NO_RESTORE_PROGRESS,
  approveRejectedFlagsOfContent,
  groupTargetsByHiddenAt,
  hasSameMealContent,
  hiddenContentRestoreCutoff,
  isWithinHiddenContentRestoreWindow,
  judgeHiddenContentRestorability,
  listRowsHiddenTogether,
  readHiddenContentRow,
  restoreHiddenContentRows,
  restoreModeratedContent,
  type HiddenContentRestoreAdmin,
  type HiddenContentRow,
  type HiddenContentRowHidden,
} from '@/lib/admin/hidden-content-restore';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-18T03:00:00.000Z');
const T1 = '2026-10-10T01:02:03.456+00:00';
const T1_Z = '2026-10-10T01:02:03.456Z'; // T1 と同じ時刻の別の書き方
const T2 = '2026-10-12T05:06:07.890+00:00';
const T9 = '2026-10-11T00:00:00.000+00:00';
const DB_ERROR = { message: 'db down' };

const asAdmin = (fake: FakeSupabase): HiddenContentRestoreAdmin => fake as unknown as HiddenContentRestoreAdmin;

type Builder = Record<'select' | 'eq' | 'gte' | 'in' | 'update' | 'maybeSingle', ReturnType<typeof vi.fn>>;

/** n 回目 (0 始まり) の .from() が返したビルダー */
function builderOf(fake: FakeSupabase, index: number): Builder {
  return fake.from.mock.results[index]!.value as Builder;
}

/** .from() の呼び出し順の表の名前 */
function tablesCalled(fake: FakeSupabase): string[] {
  return fake.from.mock.calls.map((call) => String(call[0]));
}

function mealRow(overrides: Partial<HiddenContentRow> = {}): HiddenContentRow {
  return {
    id: 'meal-1',
    user_id: 'owner-1',
    hidden_at: T1,
    hidden_by: 'moderator-1',
    hidden_reason: 'moderation:delete_only',
    paste_group_id: 'group-1',
    photo_url: 'https://example.com/a.jpg',
    memo: 'メモ',
    ...overrides,
  };
}

const hiddenMeal = (overrides: Partial<HiddenContentRow> = {}): HiddenContentRowHidden => ({
  ...mealRow(overrides),
  hidden_at: overrides.hidden_at ?? T1,
});

describe('#1538 戻せる期間 (U-1〜U-4)', () => {
  it('U-1: hiddenContentRestoreCutoff は now のちょうど 89 日前', () => {
    expect(HIDDEN_CONTENT_RESTORE_WINDOW_DAYS).toBe(89);
    expect(hiddenContentRestoreCutoff(NOW).getTime()).toBe(NOW.getTime() - 89 * MS_PER_DAY);
  });

  it('U-2: isWithinHiddenContentRestoreWindow: 89 日ちょうどは true、89 日 + 1 ms は false、1 分前は true', () => {
    const exactly = new Date(NOW.getTime() - 89 * MS_PER_DAY).toISOString();
    const justOver = new Date(NOW.getTime() - 89 * MS_PER_DAY - 1).toISOString();
    const oneMinute = new Date(NOW.getTime() - 60_000).toISOString();
    expect(isWithinHiddenContentRestoreWindow(exactly, NOW)).toBe(true);
    expect(isWithinHiddenContentRestoreWindow(justOver, NOW)).toBe(false);
    expect(isWithinHiddenContentRestoreWindow(oneMinute, NOW)).toBe(true);
  });

  it('U-3: isWithinHiddenContentRestoreWindow: 日時として読めない hidden_at は例外', () => {
    expect(() => isWithinHiddenContentRestoreWindow('not-a-date', NOW)).toThrow(/not a valid timestamp/);
  });

  it('U-4: judgeHiddenContentRestorability: null → gone / hidden_at null → not_hidden (row を返す) / 89 日以内 → restorable (row.hidden_at が string) / 89 日超 → window_expired', () => {
    expect(judgeHiddenContentRestorability(null, NOW)).toEqual({ kind: 'gone' });

    const shown = mealRow({ hidden_at: null, hidden_by: null, hidden_reason: null });
    expect(judgeHiddenContentRestorability(shown, NOW)).toEqual({ kind: 'not_hidden', row: shown });

    const recent = mealRow({ hidden_at: new Date(NOW.getTime() - 3 * MS_PER_DAY).toISOString() });
    const restorable = judgeHiddenContentRestorability(recent, NOW);
    expect(restorable.kind).toBe('restorable');
    if (restorable.kind === 'restorable') expect(typeof restorable.row.hidden_at).toBe('string');

    const old = mealRow({ hidden_at: new Date(NOW.getTime() - 92 * MS_PER_DAY).toISOString() });
    const expired = judgeHiddenContentRestorability(old, NOW);
    expect(expired.kind).toBe('window_expired');
    if (expired.kind === 'window_expired') expect(expired.row.id).toBe('meal-1');
  });
});

describe('#1538 hasSameMealContent', () => {
  it('写真とメモが両方同じときだけ true (NULL どうしは同じ)', () => {
    expect(hasSameMealContent({ photo_url: 'a', memo: 'm' }, { photo_url: 'a', memo: 'm' })).toBe(true);
    expect(hasSameMealContent({ photo_url: null, memo: null }, { photo_url: null, memo: null })).toBe(true);
    expect(hasSameMealContent({ photo_url: 'a', memo: 'm' }, { photo_url: 'b', memo: 'm' })).toBe(false);
    expect(hasSameMealContent({ photo_url: 'a', memo: 'm' }, { photo_url: 'a', memo: null })).toBe(false);
  });
});

describe('#1538 readHiddenContentRow (U-5)', () => {
  it('U-5: food は paste_group_id・photo_url・memo を含む列で、recipe は含まない列で読む (recipe の 3 つは null)。無ければ null。足りない列・文字列でない値は null に。id が文字列でない行は例外。user_id が null の行は null のまま。DB エラーは例外', async () => {
    const food = createFakeSupabase({
      meals: [{ data: { id: 'meal-1', user_id: 'owner-1', hidden_at: T1, hidden_by: 'm-1', hidden_reason: 'r', paste_group_id: 'g', photo_url: 'p', memo: 'x' }, error: null }],
    });
    const foodRow = await readHiddenContentRow(asAdmin(food), 'food', 'meal-1');
    expect(foodRow).toEqual({ id: 'meal-1', user_id: 'owner-1', hidden_at: T1, hidden_by: 'm-1', hidden_reason: 'r', paste_group_id: 'g', photo_url: 'p', memo: 'x' });
    expect(tablesCalled(food)).toEqual(['meals']);
    expect(builderOf(food, 0).select).toHaveBeenCalledWith('id, user_id, hidden_at, hidden_by, hidden_reason, paste_group_id, photo_url, memo');
    expect(builderOf(food, 0).eq).toHaveBeenCalledWith('id', 'meal-1');

    // 公開レシピで持ち主が退会して user_id が null (S-23)。recipes に無い 3 列は null
    const recipe = createFakeSupabase({
      recipes: [{ data: { id: 'recipe-1', user_id: null, hidden_at: T1, hidden_by: null, hidden_reason: 'moderation:delete_only' }, error: null }],
    });
    const recipeRow = await readHiddenContentRow(asAdmin(recipe), 'recipe', 'recipe-1');
    expect(recipeRow).toEqual({ id: 'recipe-1', user_id: null, hidden_at: T1, hidden_by: null, hidden_reason: 'moderation:delete_only', paste_group_id: null, photo_url: null, memo: null });
    expect(builderOf(recipe, 0).select).toHaveBeenCalledWith('id, user_id, hidden_at, hidden_by, hidden_reason');

    // 行が無ければ null
    const none = createFakeSupabase({ meals: [{ data: null, error: null }] });
    expect(await readHiddenContentRow(asAdmin(none), 'food', 'x')).toBeNull();

    // 足りない列・文字列でない値は null
    const partial = createFakeSupabase({ meals: [{ data: { id: 'meal-2', hidden_at: 123, memo: { a: 1 } }, error: null }] });
    expect(await readHiddenContentRow(asAdmin(partial), 'food', 'meal-2')).toEqual({
      id: 'meal-2', user_id: null, hidden_at: null, hidden_by: null, hidden_reason: null, paste_group_id: null, photo_url: null, memo: null,
    });

    // id が文字列でない行・配列・文字列は例外
    for (const bad of [{ id: 1 }, [], 'oops']) {
      const broken = createFakeSupabase({ meals: [{ data: bad, error: null }] });
      await expect(readHiddenContentRow(asAdmin(broken), 'food', 'x')).rejects.toThrow('unexpected row shape');
    }

    // DB エラーは例外 (元のエラーをそのまま投げる)
    const failing = createFakeSupabase({ meals: [{ data: null, error: DB_ERROR }] });
    await expect(readHiddenContentRow(asAdmin(failing), 'food', 'x')).rejects.toBe(DB_ERROR);
  });
});

describe('#1538 listRowsHiddenTogether (U-6)', () => {
  it('U-6: recipe は [{ id, hidden_at }] だけ (読まない)。paste_group_id が null の food も同じ', async () => {
    const fake = createFakeSupabase({});
    expect(await listRowsHiddenTogether(asAdmin(fake), 'recipe', hiddenMeal({ id: 'recipe-1' }))).toEqual([{ id: 'recipe-1', hidden_at: T1 }]);
    expect(await listRowsHiddenTogether(asAdmin(fake), 'food', hiddenMeal({ paste_group_id: null }))).toEqual([{ id: 'meal-1', hidden_at: T1 }]);
    expect(fake.from).not.toHaveBeenCalled();
  });

  it('U-6: food で paste_group_id があれば meals を select(id, hidden_at, photo_url, memo)・eq(paste_group_id)・gte(hidden_at, 通報された行の hidden_at) で読み、hidden_at が同じ時刻の行 (中身が違っても: S-03) と、写真とメモが通報された行と同じ行 (S-24) を返す。中身が違い時刻も違う行 (S-04)・hidden_at が null の行は返さない。通報された行を先頭に必ず含め、その hidden_at は読んだ値のまま', async () => {
    const fake = createFakeSupabase({
      meals: [
        {
          data: [
            // 通報された行自身 (重複して返さない)
            { id: 'meal-1', hidden_at: T1, photo_url: 'https://example.com/a.jpg', memo: 'メモ' },
            // (a) 同じ時刻 (書き方が違う) で、隠したあとに持ち主が中身を書き換えた複製 (S-03)
            { id: 'meal-2', hidden_at: T1_Z, photo_url: 'https://example.com/edited.jpg', memo: '書き換え' },
            // (b) あとの時刻 t2 で隠れ、写真とメモが今も同じ (S-24)
            { id: 'meal-3', hidden_at: T2, photo_url: 'https://example.com/a.jpg', memo: 'メモ' },
            // 別の通報の判定で隠れた、中身も時刻も違う行 (S-04)
            { id: 'meal-4', hidden_at: T9, photo_url: 'https://example.com/other.jpg', memo: '別' },
            // 隠れていない行 (hidden_at が null)
            { id: 'meal-5', hidden_at: null, photo_url: 'https://example.com/a.jpg', memo: 'メモ' },
            // id が文字列でない行
            { id: 6, hidden_at: T1, photo_url: null, memo: null },
          ],
          error: null,
        },
      ],
    });

    const targets = await listRowsHiddenTogether(asAdmin(fake), 'food', hiddenMeal());

    expect(targets).toEqual([
      { id: 'meal-1', hidden_at: T1 },
      { id: 'meal-2', hidden_at: T1_Z },
      { id: 'meal-3', hidden_at: T2 },
    ]);
    const builder = builderOf(fake, 0);
    expect(builder.select).toHaveBeenCalledWith('id, hidden_at, photo_url, memo');
    expect(builder.eq).toHaveBeenCalledWith('paste_group_id', 'group-1');
    expect(builder.gte).toHaveBeenCalledWith('hidden_at', T1);
  });

  it('U-6: データが null・配列でないときは通報された行だけ。DB エラーは例外', async () => {
    const empty = createFakeSupabase({ meals: [{ data: null, error: null }] });
    expect(await listRowsHiddenTogether(asAdmin(empty), 'food', hiddenMeal())).toEqual([{ id: 'meal-1', hidden_at: T1 }]);
    const notArray = createFakeSupabase({ meals: [{ data: { id: 'x' }, error: null }] });
    expect(await listRowsHiddenTogether(asAdmin(notArray), 'food', hiddenMeal())).toEqual([{ id: 'meal-1', hidden_at: T1 }]);
    const failing = createFakeSupabase({ meals: [{ data: null, error: DB_ERROR }] });
    await expect(listRowsHiddenTogether(asAdmin(failing), 'food', hiddenMeal())).rejects.toBe(DB_ERROR);
  });
});

describe('#1538 groupTargetsByHiddenAt (U-13)', () => {
  it('U-13: hidden_at の時刻ごとに組にし、通報された行の組 (同じ時刻の行を含む) を最後に置く。書き方の違う同じ時刻 (Z と +00:00) は同じ組。通報された行だけなら 1 組', () => {
    const content = { id: 'meal-1', hidden_at: T1 };
    expect(groupTargetsByHiddenAt([content], content)).toEqual([{ hiddenAt: T1, ids: ['meal-1'] }]);

    const batches = groupTargetsByHiddenAt(
      [
        content,
        { id: 'meal-2', hidden_at: T1_Z },
        { id: 'meal-3', hidden_at: T2 },
        { id: 'meal-4', hidden_at: T9 },
        { id: 'meal-5', hidden_at: T2 },
      ],
      content,
    );

    expect(batches).toEqual([
      { hiddenAt: T2, ids: ['meal-3', 'meal-5'] },
      { hiddenAt: T9, ids: ['meal-4'] },
      { hiddenAt: T1, ids: ['meal-1', 'meal-2'] },
    ]);
    expect(batches[batches.length - 1].ids[0]).toBe('meal-1');
  });
});

describe('#1538 approveRejectedFlagsOfContent (U-7)', () => {
  const params = { resolvedBy: 'admin-1', resolutionNote: '申し立てを確認', now: NOW };

  it('U-7: food は moderation_flags を status approved / resolved_by / resolved_at / resolution_note で、in(meal_id, 対象)・eq(status, rejected) で更新し、id を返す', async () => {
    const fake = createFakeSupabase({ moderation_flags: [{ data: [{ id: 'flag-1' }, { id: 'flag-3' }], error: null }] });

    const ids = await approveRejectedFlagsOfContent(asAdmin(fake), 'food', ['meal-1', 'meal-2'], params);

    expect(ids).toEqual(['flag-1', 'flag-3']);
    expect(tablesCalled(fake)).toEqual(['moderation_flags']);
    const builder = builderOf(fake, 0);
    expect(builder.update).toHaveBeenCalledWith({
      status: 'approved',
      resolved_by: 'admin-1',
      resolved_at: NOW.toISOString(),
      resolution_note: '申し立てを確認',
    });
    expect(builder.in).toHaveBeenCalledWith('meal_id', ['meal-1', 'meal-2']);
    expect(builder.eq).toHaveBeenCalledWith('status', 'rejected');
    expect(builder.select).toHaveBeenCalledWith('id');
  });

  it('U-7: recipe は recipe_flags を reviewed_by / reviewed_at で (resolution_note を書かない)', async () => {
    const fake = createFakeSupabase({ recipe_flags: [{ data: [{ id: 'rflag-1' }], error: null }] });

    const ids = await approveRejectedFlagsOfContent(asAdmin(fake), 'recipe', ['recipe-1'], params);

    expect(ids).toEqual(['rflag-1']);
    expect(tablesCalled(fake)).toEqual(['recipe_flags']);
    const builder = builderOf(fake, 0);
    expect(builder.update).toHaveBeenCalledWith({ status: 'approved', reviewed_by: 'admin-1', reviewed_at: NOW.toISOString() });
    expect(builder.in).toHaveBeenCalledWith('recipe_id', ['recipe-1']);
    expect(builder.eq).toHaveBeenCalledWith('status', 'rejected');
  });

  it('U-7: 0 行は空配列 (data が null でも)。DB エラーは例外', async () => {
    const none = createFakeSupabase({ moderation_flags: [{ data: [], error: null }] });
    expect(await approveRejectedFlagsOfContent(asAdmin(none), 'food', ['meal-1'], params)).toEqual([]);
    const nullData = createFakeSupabase({ moderation_flags: [{ data: null, error: null }] });
    expect(await approveRejectedFlagsOfContent(asAdmin(nullData), 'food', ['meal-1'], params)).toEqual([]);
    const failing = createFakeSupabase({ moderation_flags: [{ data: null, error: DB_ERROR }] });
    await expect(approveRejectedFlagsOfContent(asAdmin(failing), 'food', ['meal-1'], params)).rejects.toBe(DB_ERROR);
  });
});

describe('#1538 restoreHiddenContentRows (U-8)', () => {
  it('U-8: update は { hidden_at: null, hidden_by: null, hidden_reason: null } で、in(id, 対象)・eq(hidden_at, 読んだ値)・gte(hidden_at, now − 89 日)・select(id)。戻した id を返す。DB エラーは例外', async () => {
    const fake = createFakeSupabase({ meals: [{ data: [{ id: 'meal-1' }, { id: 'meal-2' }], error: null }] });

    const ids = await restoreHiddenContentRows(asAdmin(fake), 'food', ['meal-1', 'meal-2'], T1, NOW);

    expect(ids).toEqual(['meal-1', 'meal-2']);
    const builder = builderOf(fake, 0);
    expect(builder.update).toHaveBeenCalledWith({ hidden_at: null, hidden_by: null, hidden_reason: null });
    expect(builder.in).toHaveBeenCalledWith('id', ['meal-1', 'meal-2']);
    expect(builder.eq).toHaveBeenCalledWith('hidden_at', T1);
    expect(builder.gte).toHaveBeenCalledWith('hidden_at', new Date(NOW.getTime() - 89 * MS_PER_DAY).toISOString());
    expect(builder.select).toHaveBeenCalledWith('id');

    const recipe = createFakeSupabase({ recipes: [{ data: [{ id: 'recipe-1' }], error: null }] });
    expect(await restoreHiddenContentRows(asAdmin(recipe), 'recipe', ['recipe-1'], T1, NOW)).toEqual(['recipe-1']);
    expect(tablesCalled(recipe)).toEqual(['recipes']);

    const zero = createFakeSupabase({ meals: [{ data: null, error: null }] });
    expect(await restoreHiddenContentRows(asAdmin(zero), 'food', ['meal-1'], T1, NOW)).toEqual([]);

    const failing = createFakeSupabase({ meals: [{ data: null, error: DB_ERROR }] });
    await expect(restoreHiddenContentRows(asAdmin(failing), 'food', ['meal-1'], T1, NOW)).rejects.toBe(DB_ERROR);
  });
});

describe('#1538 restoreModeratedContent (U-9〜U-12, U-14)', () => {
  const params = { restoredBy: 'admin-1', restoreNote: '誤判定でした', now: NOW };
  const recentHiddenAt = new Date(NOW.getTime() - 3 * MS_PER_DAY).toISOString();
  const row = {
    id: 'meal-1', user_id: 'owner-1', hidden_at: recentHiddenAt, hidden_by: 'moderator-1', hidden_reason: 'moderation:delete_only',
    paste_group_id: 'group-1', photo_url: 'p', memo: 'm',
  };
  const group = (rows: Array<Record<string, unknown>>) => ({ data: rows, error: null });

  /** 複製なしの food (paste_group_id が null) の通常の流れ */
  function plainFood(overrides: { flags?: unknown; rows?: unknown; reread?: unknown } = {}) {
    return createFakeSupabase({
      meals: [
        { data: { ...row, paste_group_id: null }, error: null },
        overrides.rows ?? { data: [{ id: 'meal-1' }], error: null },
        overrides.reread ?? { data: null, error: null },
      ],
      moderation_flags: [(overrides.flags as { data: unknown; error: unknown }) ?? { data: [{ id: 'flag-1' }], error: null }],
    });
  }

  it('U-9: 行の読み取りの失敗は HiddenContentRestoreStepError(read, before null, progress = NO_RESTORE_PROGRESS)', async () => {
    const fake = createFakeSupabase({ meals: [{ data: null, error: DB_ERROR }] });
    const error = await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HiddenContentRestoreStepError);
    const stepError = error as HiddenContentRestoreStepError;
    expect(stepError.step).toBe('read');
    expect(stepError.reason).toBe(DB_ERROR);
    expect(stepError.before).toBeNull();
    expect(stepError.progress).toEqual(NO_RESTORE_PROGRESS);
  });

  it('U-9: まとまりの読み取りの失敗は (read, before あり, 空)', async () => {
    const fake = createFakeSupabase({ meals: [{ data: row, error: null }, { data: null, error: DB_ERROR }] });
    const stepError = (await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params).catch((e: unknown) => e)) as HiddenContentRestoreStepError;
    expect(stepError.step).toBe('read');
    expect(stepError.before?.id).toBe('meal-1');
    expect(stepError.progress).toEqual(NO_RESTORE_PROGRESS);
  });

  it('U-9: 通報の更新の失敗は (flags, progress.targetIds あり・approvedFlagIds 空)。行は更新しない', async () => {
    const fake = createFakeSupabase({
      meals: [{ data: row, error: null }, group([{ id: 'meal-2', hidden_at: recentHiddenAt, photo_url: 'z', memo: 'z' }])],
      moderation_flags: [{ data: null, error: DB_ERROR }],
    });
    const stepError = (await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params).catch((e: unknown) => e)) as HiddenContentRestoreStepError;
    expect(stepError.step).toBe('flags');
    expect(stepError.reason).toBe(DB_ERROR);
    expect(stepError.progress).toEqual({ targetIds: ['meal-1', 'meal-2'], approvedFlagIds: [], restoredIds: [] });
    expect(tablesCalled(fake)).toEqual(['meals', 'meals', 'moderation_flags']);
  });

  it('U-9: 行の更新の失敗は (rows, approvedFlagIds あり)', async () => {
    const fake = plainFood({ rows: { data: null, error: DB_ERROR } });
    const stepError = (await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params).catch((e: unknown) => e)) as HiddenContentRestoreStepError;
    expect(stepError.step).toBe('rows');
    expect(stepError.progress).toEqual({ targetIds: ['meal-1'], approvedFlagIds: ['flag-1'], restoredIds: [] });
  });

  it('U-9: 読み直しの失敗は (reread)。それまでに済んだことを持つ', async () => {
    const fake = plainFood({ rows: { data: [], error: null }, reread: { data: null, error: DB_ERROR } });
    const stepError = (await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params).catch((e: unknown) => e)) as HiddenContentRestoreStepError;
    expect(stepError.step).toBe('reread');
    expect(stepError.progress).toEqual({ targetIds: ['meal-1'], approvedFlagIds: ['flag-1'], restoredIds: [] });
  });

  it('U-10: 判定で戻せない (gone / not_hidden / window_expired) ときは通報も行も触らずにその結果を返す', async () => {
    const gone = createFakeSupabase({ meals: [{ data: null, error: null }] });
    expect(await restoreModeratedContent(asAdmin(gone), 'food', 'meal-1', params)).toEqual({ kind: 'gone' });
    expect(tablesCalled(gone)).toEqual(['meals']);
    expect(builderOf(gone, 0).update).not.toHaveBeenCalled();

    const shown = createFakeSupabase({ meals: [{ data: { ...row, hidden_at: null, hidden_by: null, hidden_reason: null }, error: null }] });
    const notHidden = await restoreModeratedContent(asAdmin(shown), 'food', 'meal-1', params);
    expect(notHidden.kind).toBe('not_hidden');
    expect(tablesCalled(shown)).toEqual(['meals']);

    const oldAt = new Date(NOW.getTime() - 92 * MS_PER_DAY).toISOString();
    const old = createFakeSupabase({ meals: [{ data: { ...row, hidden_at: oldAt }, error: null }] });
    const expired = await restoreModeratedContent(asAdmin(old), 'food', 'meal-1', params);
    expect(expired.kind).toBe('window_expired');
    expect(tablesCalled(old)).toEqual(['meals']);
    expect(builderOf(old, 0).update).not.toHaveBeenCalled();
  });

  it('U-11: 戻せたら { restored, before, targetIds, restoredIds, approvedFlagIds }。呼ぶ順は 行を読む → まとまりを読む → 通報を更新 → 行を更新', async () => {
    const fake = createFakeSupabase({
      meals: [
        { data: row, error: null },
        group([{ id: 'meal-2', hidden_at: recentHiddenAt, photo_url: 'z', memo: 'z' }]),
        { data: [{ id: 'meal-1' }, { id: 'meal-2' }], error: null },
      ],
      moderation_flags: [{ data: [{ id: 'flag-1' }, { id: 'flag-2' }], error: null }],
    });

    const outcome = await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params);

    expect(outcome).toEqual({
      kind: 'restored',
      before: row,
      targetIds: ['meal-1', 'meal-2'],
      restoredIds: ['meal-1', 'meal-2'],
      approvedFlagIds: ['flag-1', 'flag-2'],
    });
    expect(tablesCalled(fake)).toEqual(['meals', 'meals', 'moderation_flags', 'meals']);
    // 通報の更新に渡した値
    expect(builderOf(fake, 2).update).toHaveBeenCalledWith({
      status: 'approved', resolved_by: 'admin-1', resolved_at: NOW.toISOString(), resolution_note: '誤判定でした',
    });
    // 行の更新は読んだ hidden_at で絞る
    expect(builderOf(fake, 3).eq).toHaveBeenCalledWith('hidden_at', recentHiddenAt);
  });

  it('U-11: recipe は recipes と recipe_flags だけを使う', async () => {
    const fake = createFakeSupabase({
      recipes: [{ data: { id: 'recipe-1', user_id: null, hidden_at: recentHiddenAt, hidden_by: null, hidden_reason: 'moderation:delete_only' }, error: null }, { data: [{ id: 'recipe-1' }], error: null }],
      recipe_flags: [{ data: [{ id: 'rflag-1' }], error: null }],
    });
    const outcome = await restoreModeratedContent(asAdmin(fake), 'recipe', 'recipe-1', params);
    expect(outcome.kind).toBe('restored');
    expect(tablesCalled(fake)).toEqual(['recipes', 'recipe_flags', 'recipes']);
  });

  it('U-14: (b) の行 (別の時刻 t2) があると、行の UPDATE は t2 の組 (eq(hidden_at, t2)) → 通報された行の組 (eq(hidden_at, t1)) の順の 2 文。restoredIds は両方の組の行', async () => {
    const t2 = new Date(NOW.getTime() - 1 * MS_PER_DAY).toISOString();
    const fake = createFakeSupabase({
      meals: [
        { data: row, error: null },
        group([{ id: 'meal-2', hidden_at: t2, photo_url: 'p', memo: 'm' }]),
        { data: [{ id: 'meal-2' }], error: null },
        { data: [{ id: 'meal-1' }], error: null },
      ],
      moderation_flags: [{ data: [{ id: 'flag-1' }], error: null }],
    });

    const outcome = await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params);

    expect(outcome).toMatchObject({ kind: 'restored', targetIds: ['meal-1', 'meal-2'], restoredIds: ['meal-2', 'meal-1'] });
    expect(tablesCalled(fake)).toEqual(['meals', 'meals', 'moderation_flags', 'meals', 'meals']);
    expect(builderOf(fake, 3).eq).toHaveBeenCalledWith('hidden_at', t2);
    expect(builderOf(fake, 3).in).toHaveBeenCalledWith('id', ['meal-2']);
    expect(builderOf(fake, 4).eq).toHaveBeenCalledWith('hidden_at', recentHiddenAt);
    expect(builderOf(fake, 4).in).toHaveBeenCalledWith('id', ['meal-1']);
  });

  it('U-14: t2 の組の失敗は (rows, restoredIds 空)、通報された行の組の失敗は (rows, restoredIds = t2 の組の行)。どちらも通報された行は更新されていない', async () => {
    const t2 = new Date(NOW.getTime() - 1 * MS_PER_DAY).toISOString();
    const make = (batches: Array<{ data: unknown; error: unknown }>) =>
      createFakeSupabase({
        meals: [{ data: row, error: null }, group([{ id: 'meal-2', hidden_at: t2, photo_url: 'p', memo: 'm' }]), ...batches],
        moderation_flags: [{ data: [{ id: 'flag-1' }], error: null }],
      });

    const first = make([{ data: null, error: DB_ERROR }]);
    const firstError = (await restoreModeratedContent(asAdmin(first), 'food', 'meal-1', params).catch((e: unknown) => e)) as HiddenContentRestoreStepError;
    expect(firstError.step).toBe('rows');
    expect(firstError.progress).toEqual({ targetIds: ['meal-1', 'meal-2'], approvedFlagIds: ['flag-1'], restoredIds: [] });
    // t2 の組で止まり、通報された行の組には進まない
    expect(tablesCalled(first)).toEqual(['meals', 'meals', 'moderation_flags', 'meals']);

    const second = make([{ data: [{ id: 'meal-2' }], error: null }, { data: null, error: DB_ERROR }]);
    const secondError = (await restoreModeratedContent(asAdmin(second), 'food', 'meal-1', params).catch((e: unknown) => e)) as HiddenContentRestoreStepError;
    expect(secondError.step).toBe('rows');
    expect(secondError.progress.restoredIds).toEqual(['meal-2']);
    expect(secondError.progress.restoredIds).not.toContain('meal-1');
  });

  it('U-12: 通報された行の組の更新が 0 行なら読み直し、{ raced, again, targetIds, restoredIds, approvedFlagIds } を返す (again は gone / not_hidden / window_expired / restorable = 別の時刻で隠し直されている)', async () => {
    const againCases: Array<[string, unknown]> = [
      ['gone', null],
      ['not_hidden', { ...row, hidden_at: null, hidden_by: null, hidden_reason: null }],
      ['window_expired', { ...row, hidden_at: new Date(NOW.getTime() - 95 * MS_PER_DAY).toISOString() }],
      ['restorable', { ...row, hidden_at: new Date(NOW.getTime() - 60_000).toISOString() }],
    ];
    for (const [kind, rereadRow] of againCases) {
      const fake = plainFood({ rows: { data: [], error: null }, reread: { data: rereadRow, error: null } });
      const outcome = await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params);
      expect(outcome.kind, kind).toBe('raced');
      if (outcome.kind !== 'raced') continue;
      expect(outcome.again.kind).toBe(kind);
      expect(outcome.targetIds).toEqual(['meal-1']);
      expect(outcome.restoredIds).toEqual([]);
      expect(outcome.approvedFlagIds).toEqual(['flag-1']);
      expect(outcome.before.id).toBe('meal-1');
    }
  });

  it('U-12: (b) の組だけ戻って通報された行の組が 0 行のときも raced (restoredIds に (b) の行)', async () => {
    const t2 = new Date(NOW.getTime() - 1 * MS_PER_DAY).toISOString();
    const fake = createFakeSupabase({
      meals: [
        { data: row, error: null },
        group([{ id: 'meal-2', hidden_at: t2, photo_url: 'p', memo: 'm' }]),
        { data: [{ id: 'meal-2' }], error: null },
        { data: [], error: null },
        { data: null, error: null },
      ],
      moderation_flags: [{ data: [], error: null }],
    });

    const outcome = await restoreModeratedContent(asAdmin(fake), 'food', 'meal-1', params);

    expect(outcome.kind).toBe('raced');
    if (outcome.kind === 'raced') {
      expect(outcome.restoredIds).toEqual(['meal-2']);
      expect(outcome.approvedFlagIds).toEqual([]);
      expect(outcome.again.kind).toBe('gone');
    }
  });
});
