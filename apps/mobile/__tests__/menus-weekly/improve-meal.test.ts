/**
 * 「献立を改善」(#1138) の純粋ロジックのテスト
 *
 * 検証対象: apps/mobile/src/lib/improve-meal.ts
 *
 * 背景:
 * - ImproveMealModal は存在しない API (POST /api/ai/menu/meal/improve) を呼んでいて必ず失敗していた。
 * - Web の「献立を改善」と同じく POST /api/ai/menu/v4/generate
 *   (targetSlots + resolveExistingMeals: true + note) に揃えたため、
 *   画面の入力 {date, mealTypes, nextDay} からリクエストを組み立てる部分をここで固定する。
 */

import {
  ImproveMealRejectedError,
  MAX_IMPROVE_NOTE_LENGTH,
  addDaysToDateString,
  buildImproveNote,
  buildImproveTargetSlots,
  isImproveMealRejectedError,
  isImproveTargetPast,
  resolveImproveTargetDate,
  submitImprove,
  type ImproveMealRequest,
} from '../../src/lib/improve-meal';

const baseRequest: ImproveMealRequest = {
  date: '2026-10-08',
  mealTypes: ['breakfast', 'lunch', 'dinner'],
  nextDay: false,
};

// サーバー (src/app/api/ai/menu/v4/generate/route.ts の validateTargetSlots) と同じ検証。
// ここを通らない targetSlots は 400 になるため、モバイル側で作る値が必ず通ることを確かめる。
const SERVER_VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];
function validateLikeServer(slots: unknown): string | null {
  if (!Array.isArray(slots) || slots.length === 0) return 'empty';
  if (slots.length > 93) return 'too many';
  const seen = new Set<string>();
  for (const slot of slots as Array<Record<string, unknown>>) {
    if (typeof slot.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(slot.date)) return 'bad date';
    if (typeof slot.mealType !== 'string' || !SERVER_VALID_MEAL_TYPES.includes(slot.mealType)) return 'bad mealType';
    const key = `${slot.date}:${slot.mealType}`;
    if (seen.has(key)) return 'duplicate';
    seen.add(key);
  }
  return null;
}

describe('addDaysToDateString', () => {
  it.each([
    ['2026-10-08', 1, '2026-10-09'],
    ['2026-10-31', 1, '2026-11-01'], // 月末
    ['2026-12-31', 1, '2027-01-01'], // 年末
    ['2028-02-28', 1, '2028-02-29'], // うるう年
    ['2028-02-29', 1, '2028-03-01'],
    ['2026-02-28', 1, '2026-03-01'], // うるう年ではない
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-03-08', 1, '2026-03-09'], // 米国の夏時間開始日 (端末の TZ に依存しないこと)
    ['2026-11-01', 1, '2026-11-02'], // 米国の夏時間終了日
    ['2026-09-27', 1, '2026-09-28'], // ニュージーランドの夏時間開始日
  ])('%s に %i 日足すと %s', (date, days, expected) => {
    expect(addDaysToDateString(date, days)).toBe(expected);
  });

  it('端末のローカル時刻に依存する Date の API を使わない (TZ・夏時間でずれないため)', () => {
    const spies = ['getDate', 'getMonth', 'getFullYear', 'setDate', 'getHours', 'getDay', 'getTimezoneOffset'].map(
      (name) => jest.spyOn(Date.prototype, name as 'getDate'),
    );
    try {
      expect(addDaysToDateString('2026-03-08', 1)).toBe('2026-03-09');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it.each(['2026-13-01', '2026-02-30', '2026-1-1', 'abc', '', '2026-10-08T00:00:00'])(
    '不正な日付 %p は例外にする',
    (bad) => {
      expect(() => addDaysToDateString(bad, 1)).toThrow();
    },
  );
});

describe('resolveImproveTargetDate', () => {
  it('nextDay=false なら選択日そのもの', () => {
    expect(resolveImproveTargetDate({ ...baseRequest, nextDay: false })).toBe('2026-10-08');
  });

  it('nextDay=true なら選択日の翌日', () => {
    expect(resolveImproveTargetDate({ ...baseRequest, nextDay: true })).toBe('2026-10-09');
  });
});

describe('buildImproveTargetSlots', () => {
  it('朝・昼・夕を選択日のスロットにする (plannedMealId はサーバーが resolveExistingMeals で付ける)', () => {
    expect(buildImproveTargetSlots(baseRequest)).toEqual([
      { date: '2026-10-08', mealType: 'breakfast' },
      { date: '2026-10-08', mealType: 'lunch' },
      { date: '2026-10-08', mealType: 'dinner' },
    ]);
    for (const slot of buildImproveTargetSlots(baseRequest)) {
      expect(slot).not.toHaveProperty('plannedMealId');
    }
  });

  it('翌日フラグがあれば全スロットが翌日になる', () => {
    expect(buildImproveTargetSlots({ ...baseRequest, mealTypes: ['breakfast'], nextDay: true })).toEqual([
      { date: '2026-10-09', mealType: 'breakfast' },
    ]);
  });

  it('月・年をまたぐ翌日も正しい', () => {
    const slots = buildImproveTargetSlots({ ...baseRequest, date: '2026-12-31', mealTypes: ['dinner'], nextDay: true });
    expect(slots).toEqual([{ date: '2027-01-01', mealType: 'dinner' }]);
  });

  it('選んだ順番に関係なく 朝→昼→夕 の順にする', () => {
    const slots = buildImproveTargetSlots({ ...baseRequest, mealTypes: ['dinner', 'breakfast'] });
    expect(slots.map((s) => s.mealType)).toEqual(['breakfast', 'dinner']);
  });

  it('同じ食事タイプが重複しても 1 つにする (サーバーは重複スロットを 400 にする)', () => {
    const slots = buildImproveTargetSlots({ ...baseRequest, mealTypes: ['lunch', 'lunch', 'lunch'] });
    expect(slots).toEqual([{ date: '2026-10-08', mealType: 'lunch' }]);
  });

  it('朝・昼・夕以外の値は取り除く', () => {
    const slots = buildImproveTargetSlots({
      ...baseRequest,
      mealTypes: ['breakfast', 'snack'] as unknown as ImproveMealRequest['mealTypes'],
    });
    expect(slots).toEqual([{ date: '2026-10-08', mealType: 'breakfast' }]);
  });

  it('何も選ばなければ空配列', () => {
    expect(buildImproveTargetSlots({ ...baseRequest, mealTypes: [] })).toEqual([]);
  });

  it.each([
    ['3 食・当日', baseRequest],
    ['1 食・翌日', { ...baseRequest, mealTypes: ['lunch'], nextDay: true } as ImproveMealRequest],
    ['年末の翌日', { ...baseRequest, date: '2026-12-31', nextDay: true } as ImproveMealRequest],
  ])('%s: サーバーの targetSlots 検証を通る形になる', (_label, request) => {
    expect(validateLikeServer(buildImproveTargetSlots(request))).toBeNull();
  });
});

describe('buildImproveNote', () => {
  it('AI 栄養士の提案が無ければ空文字 (Web と同じく要望なしで生成する)', () => {
    expect(buildImproveNote(baseRequest)).toBe('');
    expect(buildImproveNote({ ...baseRequest, advice: null })).toBe('');
    expect(buildImproveNote({ ...baseRequest, advice: '' })).toBe('');
    expect(buildImproveNote({ ...baseRequest, advice: '  \n ' })).toBe('');
  });

  it('提案があれば Web と同じ書き出しで、分析した日付と提案を渡す', () => {
    expect(buildImproveNote({ ...baseRequest, advice: 'たんぱく質を増やしましょう' })).toBe(
      '2026-10-08の栄養分析に基づくAI栄養士の提案を参考に改善してください：\nたんぱく質を増やしましょう',
    );
  });

  it('翌日を改善するときも「分析した日」は選択日のまま (対象日ではない)', () => {
    const note = buildImproveNote({ ...baseRequest, nextDay: true, advice: '野菜を足す' });
    expect(note.startsWith('2026-10-08の栄養分析')).toBe(true);
    expect(note).not.toContain('2026-10-09');
  });

  it('提案の前後の空白は取り除く', () => {
    expect(buildImproveNote({ ...baseRequest, advice: '  塩分を控える \n' }).endsWith('：\n塩分を控える')).toBe(true);
  });

  it(`長すぎる提案は ${MAX_IMPROVE_NOTE_LENGTH} 文字までに切り詰める (サーバー側の要望の上限に合わせる)`, () => {
    const note = buildImproveNote({ ...baseRequest, advice: 'あ'.repeat(5000) });
    expect(Array.from(note)).toHaveLength(MAX_IMPROVE_NOTE_LENGTH);
  });

  it('切り詰めで絵文字 (サロゲートペア) を壊さない', () => {
    const note = buildImproveNote({ ...baseRequest, advice: '🥦'.repeat(2000) });
    expect(Array.from(note)).toHaveLength(MAX_IMPROVE_NOTE_LENGTH);
    // 孤立したサロゲートがあると encodeURIComponent は URIError を投げる
    expect(() => encodeURIComponent(note)).not.toThrow();
    expect(note.endsWith('🥦')).toBe(true);
  });
});

describe('isImproveTargetPast', () => {
  const today = '2026-10-08';

  it('今日・未来は過去ではない', () => {
    expect(isImproveTargetPast({ ...baseRequest, date: '2026-10-08' }, today)).toBe(false);
    expect(isImproveTargetPast({ ...baseRequest, date: '2026-10-09' }, today)).toBe(false);
  });

  it('昨日以前は過去', () => {
    expect(isImproveTargetPast({ ...baseRequest, date: '2026-10-07' }, today)).toBe(true);
    expect(isImproveTargetPast({ ...baseRequest, date: '2025-12-31' }, today)).toBe(true);
  });

  it('昨日を選んでも翌日 (=今日) を対象にすれば過去ではない', () => {
    expect(isImproveTargetPast({ ...baseRequest, date: '2026-10-07', nextDay: true }, today)).toBe(false);
  });

  it('一昨日を選んで翌日 (=昨日) を対象にしても過去', () => {
    expect(isImproveTargetPast({ ...baseRequest, date: '2026-10-06', nextDay: true }, today)).toBe(true);
  });
});

describe('ImproveMealRejectedError', () => {
  it('利用者向けの文言を持つエラーとして判別できる', () => {
    const err = new ImproveMealRejectedError('生成中です');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('生成中です');
    expect(isImproveMealRejectedError(err)).toBe(true);
  });

  it('通常のエラーや null は判別されない', () => {
    expect(isImproveMealRejectedError(new Error('HTTP 500'))).toBe(false);
    expect(isImproveMealRejectedError(null)).toBe(false);
    expect(isImproveMealRejectedError('x')).toBe(false);
  });
});

describe('submitImprove', () => {
  const today = '2026-10-08';

  function setup(overrides: Partial<Parameters<typeof submitImprove>[0]> = {}) {
    const generate = jest.fn().mockResolvedValue({ requestId: 'req-1', totalSlots: 3 });
    const args = { request: baseRequest, today, isBusy: false, generate, ...overrides };
    return { generate, run: () => submitImprove(args) };
  }

  it('v4 生成を「既存の献立を差し替える」指定で 1 回だけ呼ぶ', async () => {
    const { generate, run } = setup();
    await run();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      {
        targetSlots: [
          { date: '2026-10-08', mealType: 'breakfast' },
          { date: '2026-10-08', mealType: 'lunch' },
          { date: '2026-10-08', mealType: 'dinner' },
        ],
        resolveExistingMeals: true,
        constraints: {},
        note: '',
        ultimateMode: false,
      },
      // 失敗は改善モーダルが自分で表示するため、画面全体のエラー表示には出さない
      { silent: true },
    );
  });

  it('提案と翌日指定を note と targetSlots に反映する', async () => {
    const { generate, run } = setup({
      request: { date: '2026-10-08', mealTypes: ['lunch'], nextDay: true, advice: '鉄分を足す' },
    });
    await run();
    const [params] = generate.mock.calls[0];
    expect(params.targetSlots).toEqual([{ date: '2026-10-09', mealType: 'lunch' }]);
    expect(params.note).toBe('2026-10-08の栄養分析に基づくAI栄養士の提案を参考に改善してください：\n鉄分を足す');
  });

  it('別の生成が進行中なら開始せず、利用者向けのエラーにする', async () => {
    const { generate, run } = setup({ isBusy: true });
    const error = await run().catch((e) => e);
    expect(isImproveMealRejectedError(error)).toBe(true);
    expect(error.message).toContain('生成中');
    expect(generate).not.toHaveBeenCalled();
  });

  it('過去の日付は開始せず、対象日を示したエラーにする', async () => {
    const { generate, run } = setup({ request: { ...baseRequest, date: '2026-10-07' } });
    const error = await run().catch((e) => e);
    expect(isImproveMealRejectedError(error)).toBe(true);
    expect(error.message).toContain('2026-10-07');
    expect(generate).not.toHaveBeenCalled();
  });

  it('昨日を選んでも翌日 (=今日) を対象にすれば開始できる', async () => {
    const { generate, run } = setup({ request: { ...baseRequest, date: '2026-10-07', nextDay: true } });
    await run();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].targetSlots[0].date).toBe('2026-10-08');
  });

  it('食事タイプが 1 つも無ければ開始せず、利用者向けのエラーにする', async () => {
    const { generate, run } = setup({ request: { ...baseRequest, mealTypes: [] } });
    const error = await run().catch((e) => e);
    expect(isImproveMealRejectedError(error)).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });

  it('生成リクエストの失敗はそのまま投げる (利用者向けエラーには変換しない)', async () => {
    const failure = new Error('HTTP 429 Too Many Requests');
    const { run } = setup({ generate: jest.fn().mockRejectedValue(failure) });
    const error = await run().catch((e) => e);
    expect(error).toBe(failure);
    expect(isImproveMealRejectedError(error)).toBe(false);
  });
});
