/**
 * expiry-days.test.ts
 * 食材の期限までの日数 (src/components/menu/PantryItem.tsx の daysFromToday / getExpiryStatus) のテスト (#1049 F7-21)
 *
 * 以前は、期限日 (YYYY-MM-DD) を new Date('YYYY-MM-DD') (UTC の 0 時) で読み、端末のタイムゾーンの
 * 「今日の 0 時」との差で日数を出していた。端末のタイムゾーンによって 1 日ずれる。
 * 今は、期限日と今日 (Asia/Tokyo) の暦日の差を、文字列のまま数える。
 *
 * テストでは時計を固定する。CI の端末は UTC なので、JST の朝 (UTC ではまだ前日) の時刻で、
 * 端末のタイムゾーンの日付を使うと 1 日ずれることを確かめられる。
 */

import { daysFromToday, getExpiryStatus } from '../../src/components/menu/PantryItem';

/** Date だけを固定する (setTimeout などは本物のまま) */
function freezeDate(iso: string) {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'hrtime',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
  });
}

afterEach(() => {
  jest.useRealTimers();
});

describe('daysFromToday — 今日は Asia/Tokyo の暦日', () => {
  // JST の 2026-10-08 の 1 日の中で、UTC の日付が 10/7 になる時間帯 (0:00〜8:59) と、10/8 の時間帯 (9:00〜23:59)
  it.each([
    ['00:00 JST (UTC では前日の 15:00)', '2026-10-07T15:00:00Z'],
    ['08:30 JST (UTC では前日の 23:30)', '2026-10-07T23:30:00Z'],
    ['09:00 JST (UTC でも 10/8 になった直後)', '2026-10-08T00:00:00Z'],
    ['12:00 JST', '2026-10-08T03:00:00Z'],
    ['23:59 JST (UTC では 14:59)', '2026-10-08T14:59:00Z'],
  ])('%s でも、期限が今日なら 0 日、明日なら 1 日、昨日なら -1 日', (_label, instant) => {
    freezeDate(instant);

    expect(daysFromToday('2026-10-08')).toBe(0);
    expect(daysFromToday('2026-10-09')).toBe(1);
    expect(daysFromToday('2026-10-07')).toBe(-1);
    expect(daysFromToday('2026-10-15')).toBe(7);
  });

  it('月末・年末をまたいでも日数が合う', () => {
    freezeDate('2026-12-30T20:00:00Z'); // = 2026-12-31 05:00 JST

    expect(daysFromToday('2027-01-01')).toBe(1);
    expect(daysFromToday('2027-01-31')).toBe(31);
  });

  it('時刻つきの値 (2026-10-09T00:00:00+00:00 など) でも、日付の部分で数える', () => {
    freezeDate('2026-10-07T23:30:00Z');

    expect(daysFromToday('2026-10-09T00:00:00+00:00')).toBe(1);
  });
});

describe('getExpiryStatus — 期限当日は期限切れにしない', () => {
  it('期限が今日なら (JST の何時でも) 期限間近。期限切れではない', () => {
    for (const instant of ['2026-10-07T23:30:00Z', '2026-10-08T03:00:00Z', '2026-10-08T14:59:00Z']) {
      freezeDate(instant);
      expect(getExpiryStatus('2026-10-08')).toBe('expiringSoon');
      jest.useRealTimers();
    }
  });

  it('期限が昨日以前なら期限切れ、明日なら期限間近、2 日後以降なら通常', () => {
    freezeDate('2026-10-07T23:30:00Z'); // 08:30 JST

    expect(getExpiryStatus('2026-10-07')).toBe('expired');
    expect(getExpiryStatus('2026-10-09')).toBe('expiringSoon');
    expect(getExpiryStatus('2026-10-10')).toBe('normal');
  });

  it('期限が無ければ通常', () => {
    expect(getExpiryStatus(null)).toBe('normal');
  });
});
