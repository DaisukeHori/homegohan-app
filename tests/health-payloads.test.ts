import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  mergeNotificationPreferences,
  sanitizeBloodTestPayload,
  sanitizeHealthCheckupPayload,
  sanitizeHealthGoalUpdate,
  sanitizeHealthRecordPayload,
  sanitizeNotificationPreferences,
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
});
