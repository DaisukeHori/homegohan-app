/**
 * org-challenges (組織チャレンジの、Web とモバイルで共通の決まり。#1132) のユニットテスト
 *
 * 確かめること:
 *   - 最小人数 ORG_CHALLENGE_MIN_PARTICIPANTS が、DB の関数 get_org_challenge_aggregates の最小人数
 *     (`SELECT n AS min_participants`) と同じ値 (Web とモバイルの画面が、同じ値を既定にする)
 *   - formatParticipantCount: 人数が無い (API が null で返す) ときは「最小人数 + 人未満」、API が最小人数を返したらそれを使う
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_CHALLENGE_MIN_PARTICIPANTS, formatParticipantCount } from './org-challenges';
import * as shared from './index';

const ROOT = path.resolve(__dirname, '../../..');

/** この機能の migration。version (先頭の 14 桁) は付け替えられることがあるので、名前の後ろ半分で探す */
function readMigration(): string {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{14}_org_challenge_progress\.sql$/.test(f));
  expect(files, 'org_challenge_progress の migration がちょうど 1 本ある').toHaveLength(1);
  return fs.readFileSync(path.join(dir, files[0]), 'utf8');
}

describe('ORG_CHALLENGE_MIN_PARTICIPANTS', () => {
  it('DB の関数 get_org_challenge_aggregates の最小人数と同じ', () => {
    const m = readMigration().match(/SELECT (\d+) AS min_participants/);
    expect(m, 'migration に最小人数が見つからない').not.toBeNull();
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(Number(m![1]));
  });

  it('パッケージの入口 (@homegohan/shared) から読める (モバイルの管理画面が使う)', () => {
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
