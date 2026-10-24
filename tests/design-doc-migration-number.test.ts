/**
 * 設計書が名指す migration のファイル名の版の書き方 (tests/helpers/design-doc-migration-number.ts) の単体テスト。
 * 実際の設計書への当てはめは tests/apple-sign-in-tokens-migration-contract.test.ts (mobile/08) が行う。
 *
 * 文面は mobile/08 §8.1 の形 (migration の見出し・戻し方の案内・戻し口の見出し) を縮めたもの。
 */
import { describe, expect, it } from 'vitest';
import { collectMigrationNameMentions, findMigrationNumberProblems } from './helpers/design-doc-migration-number';

const NAME = 'apple_sign_in_tokens';
const REAL_VERSION = '20261024100000';
const OTHER_VERSION = '20261024090000';

/** 3 つの見出しの版を差し替えた文面 (1 行目 = migration の見出し・2 行目 = 戻し方の案内・4 行目 = 戻し口の見出し) */
function doc(migration: string, guide: string, rollback: string): string {
  return [
    `-- migration: ${migration}_${NAME}.sql`,
    `-- 戻し方: supabase/rollbacks/${guide}_${NAME}.down.sql`,
    '',
    `-- rollback: ${rollback}_${NAME}.sql`,
  ].join('\n');
}

function problemsOf(text: string): string[] {
  return findMigrationNumberProblems(collectMigrationNameMentions(text, NAME), REAL_VERSION);
}

describe('collectMigrationNameMentions', () => {
  it('置き場と 14 桁の番号の両方を、行と版つきで集める (.sql と .down.sql)', () => {
    expect(collectMigrationNameMentions(doc('<番号はマージ時に確定>', REAL_VERSION, '<同じ番号>'), NAME)).toEqual([
      { line: 1, version: '<番号はマージ時に確定>', fileName: `<番号はマージ時に確定>_${NAME}.sql` },
      { line: 2, version: REAL_VERSION, fileName: `${REAL_VERSION}_${NAME}.down.sql` },
      { line: 4, version: '<同じ番号>', fileName: `<同じ番号>_${NAME}.sql` },
    ]);
  });

  it('別の名前の migration・名前の無い置き場 (`<名前>`)・14 桁より長い数は集めない', () => {
    const text = [
      `-- migration: <番号>_other_table.sql`,
      '`-- rollback: <名前>` (対の migration と一致)',
      `${REAL_VERSION}_${NAME}_extra.sql`,
      `9${REAL_VERSION}_${NAME}.sql`,
    ].join('\n');
    expect(collectMigrationNameMentions(text, NAME)).toEqual([]);
  });
});

describe('findMigrationNumberProblems', () => {
  it('すべてが置き場なら問題は無い (まだ番号を書き入れていない)', () => {
    expect(problemsOf(doc('<番号はマージ時に確定>', '<同じ番号>', '<同じ番号>'))).toEqual([]);
  });

  it('すべてが実在する番号なら問題は無い (書き入れ終えた)', () => {
    expect(problemsOf(doc(REAL_VERSION, REAL_VERSION, REAL_VERSION))).toEqual([]);
  });

  it('見出しを番号にしたのに戻し口の見出しが置き場のまま残ると、その行を返す (#1917 の差分で起きた形)', () => {
    expect(problemsOf(doc(REAL_VERSION, REAL_VERSION, '<同じ番号>'))).toEqual([
      `4: <同じ番号>_${NAME}.sql (ほかの箇所は番号を書き入れたのに、ここは置き場のまま)`,
    ]);
  });

  it('実在する migration と違う番号を返す (置き場が無くても)', () => {
    expect(problemsOf(doc(REAL_VERSION, OTHER_VERSION, REAL_VERSION))).toEqual([
      `2: ${OTHER_VERSION}_${NAME}.down.sql (実在する migration の番号 ${REAL_VERSION} と違う)`,
    ]);
  });

  it('名指しが無ければ問題は無い', () => {
    expect(findMigrationNumberProblems([], REAL_VERSION)).toEqual([]);
  });
});
