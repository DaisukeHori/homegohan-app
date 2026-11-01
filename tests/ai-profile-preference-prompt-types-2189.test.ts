// @vitest-environment node
/**
 * #2189 W3 AI への指示 (AI 相談のシステムプロンプト) に、好み・習慣の欄 (update_profile_preferences) の値の型を書く。
 *
 * 問題 (修正前): #2183 Z2 から update_profile_preferences は PUT /api/profile と同じ厳密な型で検査する
 * (src/lib/ai/profile-preference-updates.ts の sanitizeAiProfilePreferenceUpdates。型の合わない欄が 1 つでもあれば何も書かない)。
 * AI への指示には欄の名前しか無く、AI が daily_water_ml に "2000" のような文字列を送ると、何も書かずに失敗の文になっていた。
 *
 * ここで確かめること:
 *   - 型の一覧は列の型 (aiProfilePreferenceSpecOf の kind) から作る: 書いてよい欄が全部、ちょうど 1 回、その型の行に出る
 *   - 手で書いた期待値: daily_water_ml・weekday_cooking_minutes は整数の行、wake_time は時刻の行、cuisine_preferences は文字列の配列の行
 *   - 型の行の文どおりの値は検査を通り、文字列の数値は通らない (指示と検査が食い違わない)
 *   - route のシステムプロンプトの update_profile_preferences の説明の中に、この一覧を差し込んでいる
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_PROFILE_PREFERENCE_FIELD_NAMES,
  aiProfilePreferenceSpecOf,
  aiProfilePreferenceTypesForPrompt,
  sanitizeAiProfilePreferenceUpdates,
} from '@/lib/ai/profile-preference-updates';

const ROUTE_FILE = path.resolve(__dirname, '..', 'src', 'app', 'api', 'ai', 'consultation', 'sessions', '[sessionId]', 'messages', 'route.ts');
/** 1 行の形: "  - <型の書き方>: <欄>, <欄>, ..." */
const LINE = /^ {2}- (.+?): ([a-z_]+(?:, [a-z_]+)*)$/;
const NOT_NULL_LINE_LABEL = 'null を送れない欄';

function linesOfPrompt(): Array<{ label: string; columns: string[] }> {
  return aiProfilePreferenceTypesForPrompt()
    .split('\n')
    .map((line) => {
      const m = LINE.exec(line);
      if (!m) throw new Error(`行の形が違う: ${line}`);
      return { label: m[1], columns: m[2].split(', ') };
    });
}

function labelOfColumn(column: string): string | undefined {
  return linesOfPrompt().find((line) => line.label !== NOT_NULL_LINE_LABEL && line.columns.includes(column))?.label;
}

describe('aiProfilePreferenceTypesForPrompt (#2189 W3)', () => {
  it('書いてよい欄が全部、ちょうど 1 回、型の行に出る (型の行どうしで重ならない)', () => {
    const typed = linesOfPrompt()
      .filter((line) => line.label !== NOT_NULL_LINE_LABEL)
      .flatMap((line) => line.columns);
    const writable = [...AI_PROFILE_PREFERENCE_FIELD_NAMES.keys()].filter((column) => aiProfilePreferenceSpecOf(column));
    expect(writable.length).toBeGreaterThan(0);
    expect([...typed].sort()).toEqual([...writable].sort());
  });

  it('同じ型の欄は同じ行に出る (行は列の型から作り、手で写さない)', () => {
    const labelsByKind = new Map<string, Set<string>>();
    for (const column of AI_PROFILE_PREFERENCE_FIELD_NAMES.keys()) {
      const spec = aiProfilePreferenceSpecOf(column);
      if (!spec) continue;
      const label = labelOfColumn(column);
      expect(label, column).toBeDefined();
      labelsByKind.set(spec.kind, new Set([...(labelsByKind.get(spec.kind) ?? []), label!]));
    }
    for (const labels of labelsByKind.values()) expect(labels.size).toBe(1);
    // 型が違えば行も違う
    const allLabels = [...labelsByKind.values()].map((labels) => [...labels][0]);
    expect(new Set(allLabels).size).toBe(allLabels.length);
  });

  it('手で書いた期待値: 整数・時刻・文字列の配列の行', () => {
    expect(labelOfColumn('daily_water_ml')).toMatch(/^整数/);
    expect(labelOfColumn('weekday_cooking_minutes')).toMatch(/^整数/);
    expect(labelOfColumn('wake_time')).toMatch(/^時刻の文字列 "HH:MM"/);
    expect(labelOfColumn('cuisine_preferences')).toMatch(/^文字列の配列/);
    expect(labelOfColumn('nickname')).toBe('文字列');
  });

  it('null を送れない欄の行は、列の型の nullable が偽の欄と同じ', () => {
    const notNull = linesOfPrompt().find((line) => line.label === NOT_NULL_LINE_LABEL)?.columns ?? [];
    const expected = [...AI_PROFILE_PREFERENCE_FIELD_NAMES.keys()].filter((column) => aiProfilePreferenceSpecOf(column)?.nullable === false);
    expect([...notNull].sort()).toEqual([...expected].sort());
  });

  it('指示どおりの値は検査を通り、文字列の数値・真偽値は通らない (指示と検査が食い違わない)', () => {
    expect(
      sanitizeAiProfilePreferenceUpdates({
        daily_water_ml: 2000,
        weekday_cooking_minutes: 30,
        wake_time: '06:30',
        cuisine_preferences: ['和食', '中華'],
      }).errors,
    ).toEqual([]);
    expect(sanitizeAiProfilePreferenceUpdates({ daily_water_ml: '2000' }).errors).toHaveLength(1);
    expect(sanitizeAiProfilePreferenceUpdates({ wake_time: '24:00' }).errors).toHaveLength(1);
  });
});

describe('AI 相談のシステムプロンプト (#2189 W3)', () => {
  it('update_profile_preferences の説明の中に、型の一覧を差し込んでいる', () => {
    const source = fs.readFileSync(ROUTE_FILE, 'utf8');
    const start = source.indexOf('- update_profile_preferences:');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = source.slice(start, source.indexOf('【', start));
    // テンプレート文字列の差し込み (\${...}) の形で書かれている
    expect(section).toContain(['$', '{aiProfilePreferenceTypesForPrompt()}'].join(''));
  });
});
