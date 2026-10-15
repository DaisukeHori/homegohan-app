/**
 * org-challenges (組織チャレンジの、サーバーと Web で共通の決まり。#1132) のユニットテスト
 *
 * 確かめること:
 *   - 最小人数 ORG_CHALLENGE_MIN_PARTICIPANTS が、DB の関数 get_org_challenge_aggregates の最小人数
 *     (`SELECT n AS min_participants`) と同じ値 (Web の画面が、同じ値を既定にする。モバイルの管理画面は #1598 で消した)
 *   - formatParticipantCount: 人数が無い (API が null で返す) ときは「最小人数 + 人未満」、API が最小人数を返したらそれを使う
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_CHALLENGE_MIN_PARTICIPANTS, formatParticipantCount } from './org-challenges';
import * as shared from './index';

const ROOT = path.resolve(__dirname, '../../..');

/**
 * get_org_challenge_aggregates を最後に定義した migration の、その関数の定義 (流した後に残る定義)。
 * #1132 (*_org_challenge_progress.sql) のあと #1600 (*_org_challenge_min10_join_policy.sql) が作り直したので、
 * ファイル名ではなく定義で探す。コメントの中の語は拾わない
 */
function latestAggregatesDefinition(): string {
  const dir = path.join(ROOT, 'supabase/migrations');
  const definitions = fs
    .readdirSync(dir)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, ''))
    .map((sql) => sql.match(/CREATE OR REPLACE FUNCTION public\.get_org_challenge_aggregates\([\s\S]*?\$\$([\s\S]*?)\$\$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  expect(definitions.length, 'get_org_challenge_aggregates を定義する migration がある').toBeGreaterThan(0);
  return definitions[definitions.length - 1][1];
}

describe('ORG_CHALLENGE_MIN_PARTICIPANTS', () => {
  it('DB の関数 get_org_challenge_aggregates の最小人数と同じ', () => {
    const m = latestAggregatesDefinition().match(/SELECT (\d+) AS min_participants/);
    expect(m, 'migration に最小人数が見つからない').not.toBeNull();
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(Number(m![1]));
  });

  it('パッケージの入口 (@homegohan/shared) から読める (Web の src/lib/org-challenges.ts がここから読み直す)', () => {
    expect(shared.ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(ORG_CHALLENGE_MIN_PARTICIPANTS);
    expect(shared.formatParticipantCount).toBe(formatParticipantCount);
  });
});

describe('formatParticipantCount', () => {
  it('人数があればそのまま (0 人も 0 人)', () => {
    expect(formatParticipantCount(12)).toBe('12人');
    expect(formatParticipantCount(0)).toBe('0人');
  });

  it('人数が無い (null / undefined / NaN) ときは、最小人数の定数で「未満」と表示する', () => {
    const expected = `${ORG_CHALLENGE_MIN_PARTICIPANTS}人未満`;
    expect(formatParticipantCount(null)).toBe(expected);
    expect(formatParticipantCount(undefined)).toBe(expected);
    expect(formatParticipantCount(Number.NaN)).toBe(expected);
    // API の本文に最小人数が無い (aggregate が無い) ときも、定数で表示する
    expect(formatParticipantCount(null, undefined)).toBe(expected);
  });

  it('API が返した最小人数があれば、その人数で「未満」と表示する (定数とずれても API の値が正)', () => {
    expect(formatParticipantCount(null, ORG_CHALLENGE_MIN_PARTICIPANTS + 5)).toBe(
      `${ORG_CHALLENGE_MIN_PARTICIPANTS + 5}人未満`,
    );
  });
});
