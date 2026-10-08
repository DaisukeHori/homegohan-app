import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  mergeNotificationPreferences,
  RECORD_DATE_PATTERN,
  sanitizeBloodTestPayload,
  sanitizeHealthCheckupPayload,
  sanitizeHealthGoalCreate,
  sanitizeHealthGoalUpdate,
  sanitizeHealthRecordPayload,
  sanitizeNotificationPreferences,
  stripUndefined,
} from '../src/lib/health-payloads';

describe('health payload sanitizers', () => {
  it('merges notification defaults and strips unknown fields', () => {
    const merged = mergeNotificationPreferences({
      enabled: false,
      morning_reminder_time: '08:00',
      user_id: 'should-not-pass',
    });

    expect(merged).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      enabled: false,
      morning_reminder_time: '08:00',
    });
  });

  it('rejects invalid notification values', () => {
    const result = sanitizeNotificationPreferences({
      quiet_hours_start: '25:61',
      record_mode: 'sometimes',
    });

    expect(result.data).toEqual({});
    expect(result.errors).toHaveLength(2);
  });

  it('keeps only allowed health record fields', () => {
    const result = sanitizeHealthRecordPayload({
      weight: '60.5',
      mood_score: 4,
      notes: 'legacy note',
      user_id: 'blocked',
    }, { acceptLegacyNotes: true });

    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({
      weight: 60.5,
      mood_score: 4,
      daily_note: 'legacy note',
    });
  });

  it('keeps only editable health goal fields', () => {
    const result = sanitizeHealthGoalUpdate({
      current_value: '61.2',
      target_value: 58,
      status: 'achieved',
      achieved_at: '2026-01-01T00:00:00Z',
    });

    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({
      current_value: 61.2,
      target_value: 58,
    });
  });

  it('sanitizes health checkup and blood test payloads', () => {
    const checkup = sanitizeHealthCheckupPayload({
      checkup_date: '2026-03-01',
      blood_pressure_systolic: '120',
      individual_review: { summary: 'blocked' },
    });
    const bloodTest = sanitizeBloodTestPayload({
      test_date: '2026-03-01',
      hba1c: '5.4',
      user_id: 'blocked',
    });

    expect(checkup.errors).toEqual([]);
    expect(checkup.data).toEqual({
      checkup_date: '2026-03-01',
      blood_pressure_systolic: 120,
    });
    expect(bloodTest.errors).toEqual([]);
    expect(bloodTest.data).toEqual({
      test_date: '2026-03-01',
      hba1c: 5.4,
    });
  });

  // #1048 F2-08: AI 経由 add_health_record がレンジ検証をバイパスしていた
  // (weight:5000 がそのまま保存される) の回帰テスト。
  it('rejects out-of-range health record values (e.g. weight=5000)', () => {
    const result = sanitizeHealthRecordPayload({ weight: 5000 });
    expect(result.data.weight).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a negative/zero weight', () => {
    expect(sanitizeHealthRecordPayload({ weight: 0 }).errors.length).toBeGreaterThan(0);
    expect(sanitizeHealthRecordPayload({ weight: -5 }).errors.length).toBeGreaterThan(0);
  });

  it('accepts the health record weight boundary values (20 and 300)', () => {
    expect(sanitizeHealthRecordPayload({ weight: 20 }).errors).toEqual([]);
    expect(sanitizeHealthRecordPayload({ weight: 300 }).errors).toEqual([]);
    expect(sanitizeHealthRecordPayload({ weight: 19.9 }).errors.length).toBeGreaterThan(0);
    expect(sanitizeHealthRecordPayload({ weight: 300.1 }).errors.length).toBeGreaterThan(0);
  });

  it('rejects out-of-range blood pressure (systolic_bp)', () => {
    expect(sanitizeHealthRecordPayload({ systolic_bp: 500 }).errors.length).toBeGreaterThan(0);
    expect(sanitizeHealthRecordPayload({ systolic_bp: 10 }).errors.length).toBeGreaterThan(0);
  });

  // #1046 F2-13: mood/sleep_quality等のスコア系は記録画面(renderScoreButtons、
  // 1-5の絵文字5段階)・AI相談プロンプト(x/5表記)がいずれも1-5スケールで運用されているが、
  // サニタイザだけmax=10のままだったため、UI上ありえない6-10の値も通過してしまっていた。
  it('rejects out-of-range 1-5 scale score fields (mood_score:8 must be 400)', () => {
    expect(sanitizeHealthRecordPayload({ mood_score: 8 }).errors.length).toBeGreaterThan(0);
    expect(sanitizeHealthRecordPayload({ sleep_quality: 8 }).errors.length).toBeGreaterThan(0);
    expect(sanitizeHealthRecordPayload({ overall_condition: 8 }).errors.length).toBeGreaterThan(0);
    expect(sanitizeHealthRecordPayload({ energy_level: 8 }).errors.length).toBeGreaterThan(0);
    expect(sanitizeHealthRecordPayload({ stress_level: 8 }).errors.length).toBeGreaterThan(0);
  });

  it('accepts the 1-5 scale boundary values and rejects 0/6', () => {
    for (const field of ['mood_score', 'sleep_quality', 'overall_condition', 'energy_level', 'stress_level']) {
      expect(sanitizeHealthRecordPayload({ [field]: 1 }).errors).toEqual([]);
      expect(sanitizeHealthRecordPayload({ [field]: 5 }).errors).toEqual([]);
      expect(sanitizeHealthRecordPayload({ [field]: 0 }).errors.length).toBeGreaterThan(0);
      expect(sanitizeHealthRecordPayload({ [field]: 6 }).errors.length).toBeGreaterThan(0);
    }
  });
});

// #1229: 目標値 (target_value / current_value) が符号も範囲も見られず、-50 のような体重目標が通っていた。
// goal_type ごとの範囲 (src/lib/health-goal-types.ts。health_records と同値) で検証する。
describe('sanitizeHealthGoalUpdate with goal type ranges (#1229)', () => {
  // [goalType, field, value, 通るか]。境界値は両端を含む
  const RANGE_CASES: Array<[string, 'target_value' | 'current_value', number, boolean]> = [
    ['weight', 'target_value', 20, true],
    ['weight', 'target_value', 300, true],
    ['weight', 'target_value', 19.99, false],
    ['weight', 'target_value', 300.01, false],
    ['weight', 'target_value', 0, false],
    ['weight', 'target_value', -50, false],
    ['weight', 'current_value', 20, true],
    ['weight', 'current_value', 300, true],
    ['weight', 'current_value', 19.99, false],
    ['weight', 'current_value', 0, false],
    ['weight', 'current_value', -1, false],
    ['body_fat', 'target_value', 1, true],
    ['body_fat', 'target_value', 70, true],
    ['body_fat', 'target_value', 0.99, false],
    ['body_fat', 'target_value', 70.01, false],
    ['body_fat', 'current_value', 1, true],
    ['body_fat', 'current_value', 70.5, false],
    ['steps', 'target_value', 1, true],
    ['steps', 'target_value', 100000, true],
    ['steps', 'target_value', 0, false],
    ['steps', 'target_value', 100001, false],
    ['steps', 'current_value', 0, true], // 今日の歩数 0 歩は有効な計測値
    ['steps', 'current_value', 100000, true],
    ['steps', 'current_value', -1, false],
    ['steps', 'current_value', 100001, false],
    // 現行モバイルが送る語彙 (step_count は steps の別名)
    ['step_count', 'target_value', 8000, true],
    ['step_count', 'target_value', 0, false],
    ['step_count', 'current_value', 0, true],
    ['step_count', 'current_value', 100001, false],
    ['sleep_hours', 'target_value', 1, true],
    ['sleep_hours', 'target_value', 7.5, true],
    ['sleep_hours', 'target_value', 24, true],
    ['sleep_hours', 'target_value', 0.5, false],
    ['sleep_hours', 'target_value', 25, false],
    ['sleep_hours', 'current_value', 0, true],
    ['sleep_hours', 'current_value', 24, true],
    ['sleep_hours', 'current_value', -0.1, false],
    ['sleep_hours', 'current_value', 24.1, false],
  ];

  it.each(RANGE_CASES)('%s: %s=%s -> accepted=%s', (goalType, field, value, accepted) => {
    const result = sanitizeHealthGoalUpdate({ [field]: value }, { goalType });
    if (accepted) {
      expect(result.errors).toEqual([]);
      expect(result.data).toEqual({ [field]: value });
    } else {
      expect(result.errors).toHaveLength(1);
      expect(result.data).toEqual({});
    }
  });

  it('reports out-of-range values in Japanese with the goal type label and unit (shown to the user as-is)', () => {
    expect(sanitizeHealthGoalUpdate({ target_value: 500 }, { goalType: 'weight' }).errors).toEqual([
      '体重の目標値 (kg) は 300 以下の値を入力してください',
    ]);
    expect(sanitizeHealthGoalUpdate({ target_value: -50 }, { goalType: 'weight' }).errors).toEqual([
      '体重の目標値 (kg) は 20 以上の値を入力してください',
    ]);
    expect(sanitizeHealthGoalUpdate({ current_value: 30 }, { goalType: 'sleep_hours' }).errors).toEqual([
      '睡眠時間の現在値 (時間) は 24 以下の値を入力してください',
    ]);
  });

  it('accepts decimal strings and still rejects hex / exponent notation', () => {
    expect(sanitizeHealthGoalUpdate({ target_value: '58.5' }, { goalType: 'weight' }).data).toEqual({ target_value: 58.5 });
    expect(sanitizeHealthGoalUpdate({ target_value: '0x10' }, { goalType: 'weight' }).errors).toHaveLength(1);
    expect(sanitizeHealthGoalUpdate({ target_value: '1e2' }, { goalType: 'weight' }).errors).toHaveLength(1);
    expect(sanitizeHealthGoalUpdate({ target_value: 'abc' }, { goalType: 'weight' }).errors).toHaveLength(1);
  });

  it('lets null through for the caller to decide (current_value can be cleared; target_value null is rejected by the callers)', () => {
    const result = sanitizeHealthGoalUpdate({ current_value: null, target_value: null }, { goalType: 'weight' });
    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({ current_value: null, target_value: null });
  });

  it('checks both values and returns every error', () => {
    const result = sanitizeHealthGoalUpdate({ target_value: -1, current_value: 999 }, { goalType: 'weight' });
    expect(result.errors).toHaveLength(2);
  });

  it('does not accept a goal_type or status change (not editable)', () => {
    const result = sanitizeHealthGoalUpdate(
      { goal_type: 'steps', status: 'achieved', user_id: 'x', target_value: 60 },
      { goalType: 'weight' },
    );
    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({ target_value: 60 });
  });

  describe('without a usable goal type (not given, or an existing row whose type is not known)', () => {
    it.each([
      ['no goalType option', undefined],
      ['empty goalType', ''],
      ['a type created before types were fixed', 'exercise'],
      ['a prototype key', 'constructor'],
    ])('%s: only signs and overflow are checked', (_label, goalType) => {
      const opts = goalType === undefined ? undefined : { goalType };
      expect(sanitizeHealthGoalUpdate({ target_value: 3, current_value: 0 }, opts).errors).toEqual([]);
      expect(sanitizeHealthGoalUpdate({ target_value: 500000, current_value: 1234567 }, opts).errors).toEqual([]);
      // 0 以下の目標値・負の現在値は種類が分からなくても拒否する
      expect(sanitizeHealthGoalUpdate({ target_value: -50 }, opts).errors).toEqual(['目標値 は 0.01 以上の値を入力してください']);
      expect(sanitizeHealthGoalUpdate({ target_value: 0 }, opts).errors).toHaveLength(1);
      // numeric(10,2) で 0.00 に丸まる値は 0 以下と同じ扱い
      expect(sanitizeHealthGoalUpdate({ target_value: 0.004 }, opts).errors).toHaveLength(1);
      expect(sanitizeHealthGoalUpdate({ current_value: -0.01 }, opts).errors).toHaveLength(1);
      // 桁あふれ (numeric(10,2) の上限超え) は DB エラー (500) になる前に 400 で返す
      expect(sanitizeHealthGoalUpdate({ target_value: 100000000 }, opts).errors).toHaveLength(1);
      expect(sanitizeHealthGoalUpdate({ current_value: 1e9 }, opts).errors).toHaveLength(1);
    });
  });
});

describe('sanitizeHealthGoalCreate (#1229)', () => {
  const WEB_BODY = {
    goal_type: 'weight',
    target_value: 60,
    target_unit: 'kg',
    target_date: '2026-12-31',
    note: '夏までに',
  };

  it('accepts what the web goals page sends', () => {
    expect(sanitizeHealthGoalCreate(WEB_BODY)).toEqual({
      data: { goal_type: 'weight', target_value: 60, target_unit: 'kg', target_date: '2026-12-31', note: '夏までに' },
      errors: [],
    });
    expect(
      sanitizeHealthGoalCreate({ goal_type: 'steps', target_value: 10000, target_unit: '歩', target_date: null }).data,
    ).toEqual({ goal_type: 'steps', target_value: 10000, target_unit: '歩', target_date: null, note: null });
  });

  it('accepts what the current mobile app sends (step_count / sleep_hours, with the units it uses)', () => {
    expect(
      sanitizeHealthGoalCreate({ goal_type: 'step_count', target_value: 8000, target_unit: '歩', target_date: null }),
    ).toEqual({
      data: { goal_type: 'step_count', target_value: 8000, target_unit: '歩', target_date: null, note: null },
      errors: [],
    });
    expect(
      sanitizeHealthGoalCreate({ goal_type: 'sleep_hours', target_value: 7.5, target_unit: '時間', target_date: null }).data,
    ).toEqual({ goal_type: 'sleep_hours', target_value: 7.5, target_unit: '時間', target_date: null, note: null });
    expect(
      sanitizeHealthGoalCreate({ goal_type: 'body_fat', target_value: '18.5', target_unit: '%', target_date: '' }).data,
    ).toEqual({ goal_type: 'body_fat', target_value: 18.5, target_unit: '%', target_date: null, note: null });
  });

  it('trims goal_type, target_unit and note', () => {
    const result = sanitizeHealthGoalCreate({ goal_type: '  weight  ', target_value: 60, target_unit: ' kg ', note: ' memo ' });
    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({ goal_type: 'weight', target_value: 60, target_unit: 'kg', target_date: null, note: 'memo' });
  });

  it('rejects a goal_type that is not one of the accepted types and lists the accepted ones', () => {
    for (const goalType of ['exercise', 'etc', 'Weight', '体重', 'weight loss', "weight'; drop table health_goals; --", 'constructor', '__proto__']) {
      const result = sanitizeHealthGoalCreate({ ...WEB_BODY, goal_type: goalType });
      expect(result.data, goalType).toBeNull();
      expect(result.errors, goalType).toEqual([
        'goal_type は weight, body_fat, steps, step_count, sleep_hours のいずれかを指定してください',
      ]);
    }
  });

  it('keeps the legacy "required" message when goal_type / target_value / target_unit is missing', () => {
    const REQUIRED = 'goal_type, target_value, and target_unit are required';
    for (const body of [
      { ...WEB_BODY, goal_type: undefined },
      { ...WEB_BODY, goal_type: '' },
      { ...WEB_BODY, goal_type: '   ' },
      { ...WEB_BODY, goal_type: 5 },
      { ...WEB_BODY, target_value: undefined },
      { ...WEB_BODY, target_value: null },
      { ...WEB_BODY, target_value: '' },
      { ...WEB_BODY, target_unit: undefined },
      { ...WEB_BODY, target_unit: '' },
      { ...WEB_BODY, target_unit: null },
    ]) {
      const result = sanitizeHealthGoalCreate(body);
      expect(result.data, JSON.stringify(body)).toBeNull();
      expect(result.errors, JSON.stringify(body)).toEqual([REQUIRED]);
    }
  });

  it('reports format and range errors before the "required" message (same order as the old route)', () => {
    const result = sanitizeHealthGoalCreate({ goal_type: undefined, target_value: 'abc', target_unit: 'kg' });
    expect(result.data).toBeNull();
    expect(result.errors).toEqual(['target_value must be a finite number or null']);
  });

  it.each([
    ['weight', -50, '体重の目標値 (kg) は 20 以上の値を入力してください'],
    ['weight', 0, '体重の目標値 (kg) は 20 以上の値を入力してください'],
    ['weight', 500, '体重の目標値 (kg) は 300 以下の値を入力してください'],
    ['body_fat', 80, '体脂肪率の目標値 (%) は 70 以下の値を入力してください'],
    ['steps', 0, '1日の歩数の目標値 (歩) は 1 以上の値を入力してください'],
    ['step_count', 100001, '1日の歩数の目標値 (歩) は 100000 以下の値を入力してください'],
    ['sleep_hours', 25, '睡眠時間の目標値 (時間) は 24 以下の値を入力してください'],
  ])('rejects %s target_value=%s', (goalType, value, message) => {
    const result = sanitizeHealthGoalCreate({ goal_type: goalType, target_value: value, target_unit: 'x' });
    expect(result.data).toBeNull();
    expect(result.errors).toEqual([message]);
  });

  it('defaultUnit fills in the unit for the goal type when it is omitted (AI consultation: targetUnit is optional)', () => {
    const REQUIRED = 'goal_type, target_value, and target_unit are required';
    // 既定では必須のまま (API)
    expect(sanitizeHealthGoalCreate({ goal_type: 'weight', target_value: 60 }).errors).toEqual([REQUIRED]);
    expect(sanitizeHealthGoalCreate({ goal_type: 'weight', target_value: 60 }, { defaultUnit: true }).data?.target_unit).toBe('kg');
    expect(sanitizeHealthGoalCreate({ goal_type: 'body_fat', target_value: 20 }, { defaultUnit: true }).data?.target_unit).toBe('%');
    expect(sanitizeHealthGoalCreate({ goal_type: 'steps', target_value: 8000 }, { defaultUnit: true }).data?.target_unit).toBe('歩');
    expect(sanitizeHealthGoalCreate({ goal_type: 'sleep_hours', target_value: 7 }, { defaultUnit: true }).data?.target_unit).toBe('時間');
    // 指定された単位は上書きしない
    expect(
      sanitizeHealthGoalCreate({ goal_type: 'weight', target_value: 60, target_unit: 'キロ' }, { defaultUnit: true }).data?.target_unit,
    ).toBe('キロ');
    // goal_type が不正なら単位を補っても通らない
    expect(sanitizeHealthGoalCreate({ goal_type: 'exercise', target_value: 3 }, { defaultUnit: true }).data).toBeNull();
  });

  it('ignores fields it does not own (user_id / status / current_value / start_value ...)', () => {
    const result = sanitizeHealthGoalCreate({
      ...WEB_BODY,
      user_id: 'attacker',
      status: 'achieved',
      current_value: 55,
      start_value: 80,
      progress_percentage: 100,
      achieved_at: '2026-01-01T00:00:00Z',
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.data ?? {}).sort()).toEqual(['goal_type', 'note', 'target_date', 'target_unit', 'target_value']);
  });

  it('rejects a malformed date and a non-string note', () => {
    expect(sanitizeHealthGoalCreate({ ...WEB_BODY, target_date: '2026/12/31' }).data).toBeNull();
    expect(sanitizeHealthGoalCreate({ ...WEB_BODY, note: 123 }).data).toBeNull();
  });

  it('rejects a body that is not a JSON object', () => {
    for (const body of [null, undefined, 'weight', 5, ['weight']]) {
      const result = sanitizeHealthGoalCreate(body);
      expect(result.data).toBeNull();
      expect(result.errors).toEqual(['Body must be a JSON object']);
    }
  });
});

describe('RECORD_DATE_PATTERN', () => {
  it('accepts a valid YYYY-MM-DD date', () => {
    expect(RECORD_DATE_PATTERN.test('2026-01-15')).toBe(true);
  });

  it('rejects malformed / non-date strings (e.g. records/[date] path param)', () => {
    expect(RECORD_DATE_PATTERN.test('abc')).toBe(false);
    expect(RECORD_DATE_PATTERN.test('2026/01/15')).toBe(false);
    expect(RECORD_DATE_PATTERN.test('2026-1-5')).toBe(false);
    expect(RECORD_DATE_PATTERN.test('')).toBe(false);
    expect(RECORD_DATE_PATTERN.test("'; DROP TABLE health_records; --")).toBe(false);
  });
});

describe('stripUndefined', () => {
  // #1048 F2-19: `{ weight: body.weight }` のように詰め替えると、body.weight が
  // undefined でもキー自体は残る（hasOwnProperty は true）。これを事前に除去しないと
  // sanitizeHealthRecordPayload の hasOwn 判定で「null 送信」と誤認され、
  // 未送信フィールドが null で上書きされてしまう。
  it('removes keys whose value is undefined', () => {
    const input: Record<string, unknown> = { a: 1, b: undefined, c: null, d: 'x' };
    expect(stripUndefined(input)).toEqual({ a: 1, c: null, d: 'x' });
  });

  it('keeps explicit null values (distinct from "not provided")', () => {
    expect(stripUndefined({ weight: null })).toEqual({ weight: null });
  });

  it('prevents a mood-only quick record from wiping out weight/sleep_quality to null', () => {
    // records/quick/route.ts が行っていた詰め替えを再現
    const body: { mood_score: number; weight?: number; sleep_quality?: number } = { mood_score: 4 };
    const merged = {
      weight: body.weight,
      sleep_quality: body.sleep_quality,
      mood_score: body.mood_score,
    };

    // 修正前: stripUndefined を挟まないと weight/sleep_quality キーが
    // undefined のまま残り、sanitizeHealthRecordPayload が null を返してしまう。
    const buggy = sanitizeHealthRecordPayload(merged);
    expect(buggy.data.weight).toBeNull();
    expect(buggy.data.sleep_quality).toBeNull();

    // 修正後: stripUndefined で未送信キーを除去してから渡す
    const fixed = sanitizeHealthRecordPayload(stripUndefined(merged));
    expect(fixed.errors).toEqual([]);
    expect(fixed.data).toEqual({ mood_score: 4 });
    expect(fixed.data.weight).toBeUndefined();
    expect(fixed.data.sleep_quality).toBeUndefined();
  });
});
