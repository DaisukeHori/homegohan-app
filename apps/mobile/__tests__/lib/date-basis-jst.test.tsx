/**
 * #1049 F7-21: モバイルの日付の基準を、packages/shared と同じ日本の暦 (Asia/Tokyo) にそろえる
 *
 * packages/shared の日付の関数 (formatLocalDate / todayLocal) は Asia/Tokyo で日付を決めるのに、ネイティブの画面は
 * 端末のタイムゾーンの getDate() や UTC の toISOString() で日付を作っていた (二重の基準)。そのため
 *   - UTC の toISOString() で作った日付は、日本の 0〜9 時に前日になった (書き出しのファイル名)
 *   - 端末のタイムゾーンが日本でないと、今日・週・期限の日付が日本とずれた
 * ここでは次を確かめる。Jest は TZ=UTC で動く (日本より 9 時間遅い端末と同じ) ので、日本の 0〜9 時に固定すると
 * 以前の書き方では前日になる (テストは TZ=UTC で回す決まり。日本のタイムゾーンで回すと、以前の書き方でも通ってしまう)。
 *   1. お気に入りに入れた日の表示・期限までの日数・健康記録の既定の日付が、日本の日付になる
 *   2. ソース (app/ と src/) に、端末のタイムゾーン・UTC で日付の文字列を作る書き方が残っていない
 */

import fs from 'fs';
import path from 'path';

import { formatLocalDate } from '@homegohan/shared';
import { render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import FavoritesScreen from '../../app/(tabs)/favorites';
import HealthQuickRecordPage from '../../app/health/record/quick';
import { daysFromToday } from '../../src/components/menu/PantryItem';

/** 2026-03-15 16:30 UTC = 2026-03-16 01:30 JST (日本では 3/16、UTC ではまだ 3/15) */
const JST_EARLY_MORNING = new Date('2026-03-15T16:30:00Z');
const JST_TODAY = '2026-03-16';

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('日付の表示・既定値が日本の日付になる (#1049 F7-21)', () => {
  it('前提: 固定した時刻は、日本では 3/16、UTC ではまだ 3/15 (TZ=UTC で回すと、以前の書き方は 3/15 を出す)', () => {
    expect(formatLocalDate(JST_EARLY_MORNING)).toBe(JST_TODAY);
    expect(formatLocalDate(JST_EARLY_MORNING, 'UTC')).toBe('2026-03-15');
  });

  it('お気に入りに入れた日 (時刻) を、日本の日付で表示する', async () => {
    mockGet.mockResolvedValue({
      favorites: [{ id: 'f1', recipeName: '肉じゃが', recipeUuid: null, likedAt: '2026-03-15T16:30:00Z' }],
      total: 1,
    });

    render(<FavoritesScreen />);

    await waitFor(() => expect(screen.getByText(/2026\/03\/16 に追加/)).toBeTruthy());
    expect(screen.queryByText(/2026\/03\/15 に追加/)).toBeNull();
  });

  it('健康の簡単記録の既定の日付は、日本の今日', () => {
    jest.useFakeTimers({ now: JST_EARLY_MORNING });

    render(<HealthQuickRecordPage />);

    expect(screen.getByDisplayValue(JST_TODAY)).toBeTruthy();
  });

  it('期限までの日数は、日本の今日から数える (期限が日本の今日なら 0、昨日なら -1)', () => {
    jest.useFakeTimers({ now: JST_EARLY_MORNING });

    expect(daysFromToday(JST_TODAY)).toBe(0);
    expect(daysFromToday('2026-03-15')).toBe(-1);
    expect(daysFromToday('2026-03-17')).toBe(1);
    expect(daysFromToday('2026-04-16')).toBe(31);
  });
});

describe('端末のタイムゾーン・UTC で日付の文字列を作る書き方が残っていない (#1049 F7-21)', () => {
  const MOBILE_ROOT = path.resolve(__dirname, '../..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  /** コメントを外したソース (説明の中の書き方の例は数えない) */
  const sources = ['app', 'src'].flatMap((dir) =>
    walk(path.join(MOBILE_ROOT, dir)).map((file) => ({
      file: path.relative(MOBILE_ROOT, file),
      code: fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1'),
    })),
  );

  it.each([
    ['getDate() をゼロ埋めして日付の文字列を作る', /getDate\(\)\)\.padStart\(/],
    ['UTC の toISOString() の先頭 10 文字を日付にする', /toISOString\(\)\.(?:slice\(0,\s*10\)|split\(["']T["']\)\[0\]|substring\(0,\s*10\))/],
    ['画面ごとに日付の整形の関数を書く (shared の formatCalendarDate / formatLocalDate を使う)', /(?:function\s+|const\s+)formatLocalDate\b/],
    ['@homegohan/core の formatLocalDate (端末のタイムゾーン) を使う', /import\s*\{[^}]*\bformatLocalDate\b[^}]*\}\s*from\s*["']@homegohan\/core["']/],
    ['端末の今日 (new Date()) から週の始まりを求める', /getWeekStart\(\s*new Date\(\)/],
  ])('%s', (_label, pattern) => {
    const offenders = sources.filter(({ code }) => pattern.test(code)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
