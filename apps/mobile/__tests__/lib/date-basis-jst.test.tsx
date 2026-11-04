/**
 * #1049 F7-21: モバイルの日付の基準を、packages/shared と同じ日本の暦 (Asia/Tokyo) にそろえる
 *
 * packages/shared の日付の関数 (formatLocalDate / todayLocal) は Asia/Tokyo で日付を決めるのに、ネイティブの画面は
 * 端末のタイムゾーンの getDate() や UTC の toISOString() で日付を作っていた (二重の基準)。そのため
 *   - UTC の toISOString() で作った日付は、日本の 0〜9 時に前日になった (書き出しのファイル名)
 *   - 端末のタイムゾーンが日本でないと、今日・週・期限の日付が日本とずれた
 * ここでは、ソース (app/ と src/) に、端末のタイムゾーン・UTC で日付の文字列を作る書き方が残っていないことを確かめる。
 * (以前は、お気に入りに入れた日の表示・食材の期限までの日数・健康の簡単記録の既定の日付を、画面を描いて確かめていた。
 * その画面 ((tabs)/favorites・health/record/quick・食材の画面の部品 PantryItem) は、通常の操作で届かないネイティブの画面として
 * 消した。#1598)
 */

import fs from 'fs';
import path from 'path';

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

  /** UTC の toISOString() の先頭 10 文字を日付にする書き方 */
  const UTC_ISO_DATE_PATTERN = /toISOString\(\)\.(?:slice\(0,\s*10\)|split\(["']T["']\)\[0\]|substring\(0,\s*10\))/;

  /**
   * 意図して UTC の日付を使っているファイル (パターンの見出し → ファイル)。
   * (以前は設定の画面 (app/(tabs)/settings.tsx) の書き出しのファイル名を、API に合わせて UTC の日付にして載せていた。
   *  #2245 K3 で API・Web と一緒に JST の今日 (todayLocal) にしたので外した。いまは無い)
   */
  const INTENTIONAL_UTC: Record<string, string[]> = {};

  it('走査が空振りしていない (残した画面のソースを読んでいて、パターンは以前の書き出しのファイル名の書き方に当たる)', () => {
    const settings = sources.find(({ file }) => file === path.join('app', '(tabs)', 'settings.tsx'));
    expect(settings).toBeDefined();
    // 書き出しのファイル名の日付は JST の今日 (#2245 K3)
    expect(settings?.code).toMatch(/\btodayLocal\(\)/);
    expect('const today = new Date().toISOString().slice(0, 10);').toMatch(UTC_ISO_DATE_PATTERN);
  });

  it.each([
    ['getDate() をゼロ埋めして日付の文字列を作る', /getDate\(\)\)\.padStart\(/],
    ['UTC の toISOString() の先頭 10 文字を日付にする', UTC_ISO_DATE_PATTERN],
    ['画面ごとに日付の整形の関数を書く (shared の formatCalendarDate / formatLocalDate を使う)', /(?:function\s+|const\s+)formatLocalDate\b/],
    ['@homegohan/core の formatLocalDate (端末のタイムゾーン) を使う', /import\s*\{[^}]*\bformatLocalDate\b[^}]*\}\s*from\s*["']@homegohan\/core["']/],
    ['端末の今日 (new Date()) から週の始まりを求める', /getWeekStart\(\s*new Date\(\)/],
  ])('%s', (label, pattern) => {
    const allowed = INTENTIONAL_UTC[label] ?? [];
    const offenders = sources
      .filter(({ code }) => pattern.test(code))
      .map(({ file }) => file)
      .filter((file) => !allowed.includes(file));
    expect(offenders).toEqual([]);
  });
});
