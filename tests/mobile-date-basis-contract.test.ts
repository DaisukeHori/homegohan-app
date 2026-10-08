/**
 * モバイルアプリの「今日」の基準が Asia/Tokyo に揃っていることの契約テスト (#1049 F7-21)
 *
 * 以前は、日付の基準が 2 つあった。
 *   - @homegohan/shared (Web・サーバーと共通): Asia/Tokyo の暦日
 *   - モバイルの画面ごとの書き方: 端末のタイムゾーンの暦日 (new Date() を整形した画面ごとの formatLocalDate など)、
 *     または UTC の暦日 (new Date().toISOString().slice(0, 10)。JST の 0〜9 時は前日になる)
 * そのため、同じ瞬間でも、Web (WebView のタブ) とネイティブ画面で「今日」が違ったり、
 * 朝の時間帯に今日の記録が表示されなかったりした。
 *
 * 今は、「今日」は @homegohan/shared の todayLocal() / startOfTodayLocal() から取り、
 * 日付の加減算は addDaysToDateString() などの文字列計算で行う。
 * ここでは、画面ごとの書き方が再び生えていないことを、ソースを読んで確かめる。
 * 日付の計算そのものの正しさは packages/shared/src/date-utils.test.ts と、モバイルの Jest で確かめている。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_SOURCE_DIRS = ['apps/mobile/app', 'apps/mobile/src'];

/** コメントを除く (説明文の中に書いた禁止パターンを、本物のコードと取り違えないため) */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function listSourceFiles(relativeDir: string): string[] {
  const dir = path.join(ROOT, relativeDir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const SOURCES = MOBILE_SOURCE_DIRS.flatMap(listSourceFiles).map((file) => ({
  file: path.relative(ROOT, file),
  code: withoutComments(fs.readFileSync(file, 'utf8')),
}));

function filesMatching(pattern: RegExp): string[] {
  return SOURCES.filter(({ code }) => pattern.test(code)).map(({ file }) => file);
}

describe('モバイルの日付の基準 (#1049 F7-21)', () => {
  it('ソースを読めている (このテストが空振りしていない)', () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(SOURCES.some(({ file }) => file.endsWith('src/hooks/useHomeData.ts'))).toBe(true);
  });

  it('日付を toISOString() の UTC 日付から作らない (JST の 0〜9 時は前日になる)', () => {
    const offenders = filesMatching(
      /toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\])/,
    );

    expect(offenders).toEqual([]);
  });

  it('画面ごとに formatLocalDate を定義し直さない (カレンダー上の Date の整形は @homegohan/core のものを使う)', () => {
    const offenders = filesMatching(/(?:const|let|var|function)\s+formatLocalDate\b/);

    expect(offenders).toEqual([]);
  });

  it('端末のタイムゾーンの年・月・日から YYYY-MM-DD を組み立てる処理を、画面に直接書かない', () => {
    // `${d.getFullYear()}-${String(d.getMonth() + 1)...` のような組み立て
    const offenders = filesMatching(/getFullYear\(\)\s*\}\s*-\s*\$\{[^}]*getMonth\(\)/);

    expect(offenders).toEqual([]);
  });

  it('「今日」を @homegohan/core の formatLocalDate(new Date()) で作らない (端末のタイムゾーンの今日になる)', () => {
    const offenders = SOURCES.filter(
      ({ code }) =>
        /import\s*\{[^}]*\bformatLocalDate\b[^}]*\}\s*from\s*['"]@homegohan\/core['"]/.test(code) &&
        /formatLocalDate\(\s*new Date\(\s*\)\s*\)/.test(code),
    ).map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('日付だけの文字列 (YYYY-MM-DD) を new Date(dateStr) で読まない (UTC の 0 時になる)。parseLocalDate を使う', () => {
    // 月単位の概算で、1 日のずれが結果に影響しない所だけは、そのまま読んでよい
    const ALLOWED = ['apps/mobile/app/onboarding/questions.tsx'];
    // 日付だけの値を持つ変数名・プロパティ名に限って確かめる (タイムスタンプ列の new Date(createdAt) などは対象外)
    const offenders = filesMatching(
      /new Date\(\s*(?:[A-Za-z_.]*\.)?(?:target_date|record_date|day_date|checkup_date|expiration_date|expirationDate|analysis_date|dateStr)\s*\)/,
    ).filter((file) => !ALLOWED.includes(file));

    expect(offenders).toEqual([]);
  });
});
