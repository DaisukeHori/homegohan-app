import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  mergeNotificationPreferences,
  RECORD_DATE_PATTERN,
  sanitizeBloodTestPayload,
  sanitizeHealthCheckupPayload,
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
