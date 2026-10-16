/**
 * src/lib/auth/sessions/constants.ts の単体テスト (#1190。設計 docs/design/cross/16-auth-history-sessions.md §12.1・§20.1)
 */
import { describe, expect, it } from 'vitest';
import {
  AUTH_LOGIN_ALERT_ENV_NAME,
  LOGIN_ALERT_MAX_AGE_HOURS,
  LOGIN_ALERT_MAX_ATTEMPTS,
  LOGIN_ALERT_MIN_AGE_SECONDS,
  LOGIN_ALERT_RECLAIM_MINUTES,
  resolveLoginAlertMode,
} from '../sessions/constants';

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

describe('resolveLoginAlertMode', () => {
  it('AUTH_LOGIN_ALERT は未設定で on、off で off、ほかの値は on に戻して ignored', () => {
    expect(AUTH_LOGIN_ALERT_ENV_NAME).toBe('AUTH_LOGIN_ALERT');
    expect(resolveLoginAlertMode(undefined)).toEqual({ mode: 'on', ignored: false });
    expect(resolveLoginAlertMode('')).toEqual({ mode: 'on', ignored: false });
    expect(resolveLoginAlertMode('   ')).toEqual({ mode: 'on', ignored: false });
    expect(resolveLoginAlertMode('on')).toEqual({ mode: 'on', ignored: false });
    expect(resolveLoginAlertMode('off')).toEqual({ mode: 'off', ignored: false });
    expect(resolveLoginAlertMode(' OFF ')).toEqual({ mode: 'off', ignored: false });
    expect(resolveLoginAlertMode('false')).toEqual({ mode: 'on', ignored: true });
    expect(resolveLoginAlertMode('0')).toEqual({ mode: 'on', ignored: true });
  });
});

describe('通知の時間の定数の関係', () => {
  it('LOGIN_ALERT_MAX_AGE_HOURS の時間は LOGIN_ALERT_MIN_AGE_SECONDS より長く、LOGIN_ALERT_RECLAIM_MINUTES × LOGIN_ALERT_MAX_ATTEMPTS の分より長い (ふつうの再試行は期限切れの前に終わる §12.1)', () => {
    const maxAgeSeconds = LOGIN_ALERT_MAX_AGE_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
    const maxAgeMinutes = LOGIN_ALERT_MAX_AGE_HOURS * MINUTES_PER_HOUR;
    expect(maxAgeSeconds).toBeGreaterThan(LOGIN_ALERT_MIN_AGE_SECONDS);
    expect(maxAgeMinutes).toBeGreaterThan(LOGIN_ALERT_RECLAIM_MINUTES * LOGIN_ALERT_MAX_ATTEMPTS);
  });
});
