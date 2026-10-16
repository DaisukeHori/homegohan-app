/**
 * src/lib/auth/sessions/login-alert-policy.ts の単体テスト (#1190。設計 docs/design/cross/16-auth-history-sessions.md §10.1・§12.3・§20.1)
 */
import { describe, expect, it } from 'vitest';
import { LOGIN_HISTORY_RETENTION_DAYS } from '../sessions/constants';
import { SERVER_DEVICE_FAMILY_KEY, UNKNOWN_DEVICE_FAMILY_KEY } from '../sessions/device-family';
import { decideLoginAlert, type LoginContext, type LoginHistoryHorizon } from '../sessions/login-alert-policy';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-16T00:00:00.000Z');

function horizonWithAgeDays(days: number): LoginHistoryHorizon {
  return { accountCreatedAt: new Date(NOW.getTime() - days * MS_PER_DAY), now: NOW, retentionDays: LOGIN_HISTORY_RETENTION_DAYS };
}
function ctx(deviceFamilyKey: string, ipNetwork: string | null = '203.0.113.0/24', countryCode: string | null = null): LoginContext {
  return { deviceFamilyKey, ipNetwork, countryCode };
}
const YOUNG = horizonWithAgeDays(1);

describe('decideLoginAlert', () => {
  it('履歴が無く、アカウントが保持の日数以内に作られたなら first_login で送らない (保持の日数ちょうども first_login)', () => {
    for (const days of [0, 1, LOGIN_HISTORY_RETENTION_DAYS]) {
      expect(decideLoginAlert(ctx('ios/safari'), [], horizonWithAgeDays(days))).toEqual({
        isNewDevice: false,
        isNewIp: false,
        isNewCountry: false,
        shouldNotify: false,
        reason: 'first_login',
      });
    }
  });

  it('履歴が無く、アカウントが保持の日数より前に作られたなら history_expired で送る', () => {
    const justOver = { ...horizonWithAgeDays(LOGIN_HISTORY_RETENTION_DAYS), accountCreatedAt: new Date(NOW.getTime() - LOGIN_HISTORY_RETENTION_DAYS * MS_PER_DAY - 1) };
    expect(decideLoginAlert(ctx('ios/safari'), [], justOver)).toEqual({
      isNewDevice: true,
      isNewIp: true,
      isNewCountry: false,
      shouldNotify: true,
      reason: 'history_expired',
    });
    // IP の範囲が分からなければ isNewIp は false
    expect(decideLoginAlert(ctx('ios/safari', null), [], justOver).isNewIp).toBe(false);
  });

  it('history_expired は current が不明な端末 (other/server・other/other) でも送る (isNewDevice は true)', () => {
    for (const key of [SERVER_DEVICE_FAMILY_KEY, UNKNOWN_DEVICE_FAMILY_KEY]) {
      const decision = decideLoginAlert(ctx(key), [], horizonWithAgeDays(LOGIN_HISTORY_RETENTION_DAYS + 1));
      expect(decision.reason).toBe('history_expired');
      expect(decision.isNewDevice).toBe(true);
      expect(decision.shouldNotify).toBe(true);
    }
  });

  it('同じ端末の種類と同じ IP の範囲は known', () => {
    expect(decideLoginAlert(ctx('ios/safari'), [ctx('ios/safari')], YOUNG)).toEqual({
      isNewDevice: false,
      isNewIp: false,
      isNewCountry: false,
      shouldNotify: false,
      reason: 'known',
    });
  });

  it('端末の種類が新しければ new_device で送る', () => {
    expect(decideLoginAlert(ctx('windows/chrome'), [ctx('ios/safari')], YOUNG)).toEqual({
      isNewDevice: true,
      isNewIp: false,
      isNewCountry: false,
      shouldNotify: true,
      reason: 'new_device',
    });
  });

  it('IP の範囲だけが新しいときは isNewIp だけで送らない', () => {
    expect(decideLoginAlert(ctx('ios/safari', '198.51.100.0/24'), [ctx('ios/safari', '203.0.113.0/24')], YOUNG)).toEqual({
      isNewDevice: false,
      isNewIp: true,
      isNewCountry: false,
      shouldNotify: false,
      reason: 'known',
    });
    // current の IP の範囲が分からなければ新しいとは言わない
    expect(decideLoginAlert(ctx('ios/safari', null), [ctx('ios/safari')], YOUNG).isNewIp).toBe(false);
  });

  it('国が分かる履歴があり国が違えば new_country で送る', () => {
    const decision = decideLoginAlert(ctx('ios/safari', '203.0.113.0/24', 'US'), [ctx('ios/safari', '203.0.113.0/24', 'JP')], YOUNG);
    expect(decision).toEqual({ isNewDevice: false, isNewIp: false, isNewCountry: true, shouldNotify: true, reason: 'new_country' });
    // 国の分かる prior のどれかと同じなら新しくない
    expect(
      decideLoginAlert(ctx('ios/safari', '203.0.113.0/24', 'US'), [ctx('ios/safari', '203.0.113.0/24', 'JP'), ctx('ios/safari', null, 'US')], YOUNG)
        .isNewCountry,
    ).toBe(false);
  });

  it('国が分からない履歴しか無ければ国では送らない', () => {
    expect(decideLoginAlert(ctx('ios/safari', '203.0.113.0/24', 'US'), [ctx('ios/safari', '203.0.113.0/24', null)], YOUNG)).toMatchObject({
      isNewCountry: false,
      shouldNotify: false,
      reason: 'known',
    });
    // current の国が分からないときも国では送らない
    expect(decideLoginAlert(ctx('ios/safari', '203.0.113.0/24', null), [ctx('ios/safari', '203.0.113.0/24', 'JP')], YOUNG).isNewCountry).toBe(false);
  });

  it('current が other/server (Node の既定の UA node) なら、prior に other/server の行があっても new_device で送る (S-4・S-32)', () => {
    expect(decideLoginAlert(ctx(SERVER_DEVICE_FAMILY_KEY), [ctx(SERVER_DEVICE_FAMILY_KEY)], YOUNG)).toEqual({
      isNewDevice: true,
      isNewIp: false,
      isNewCountry: false,
      shouldNotify: true,
      reason: 'new_device',
    });
  });

  it('current が other/other (空の UA) なら、prior に other/other の行があっても new_device で送る', () => {
    const decision = decideLoginAlert(ctx(UNKNOWN_DEVICE_FAMILY_KEY), [ctx(UNKNOWN_DEVICE_FAMILY_KEY)], YOUNG);
    expect(decision.isNewDevice).toBe(true);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.reason).toBe('new_device');
  });

  it('端末と国が両方新しければ new_device_and_country', () => {
    expect(
      decideLoginAlert(ctx('windows/chrome', '198.51.100.0/24', 'US'), [ctx('ios/safari', '203.0.113.0/24', 'JP')], YOUNG),
    ).toEqual({ isNewDevice: true, isNewIp: true, isNewCountry: true, shouldNotify: true, reason: 'new_device_and_country' });
  });
});
