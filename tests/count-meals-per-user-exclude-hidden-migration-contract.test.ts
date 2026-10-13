/**
 * #1445 (c) migration *_count_meals_per_user_exclude_hidden.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (隠した食事を数えない) は tests/integration/security/count-meals-per-user.test.ts が確かめる。
 * ここでは、番号の付け直し (main の取り込みで台帳の最大より上へ移したもの) で崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. migration の version (ファイル名の先頭 14 桁) は重複しない
 *   2. count_meals_per_user を定義する migration のうち、番号の最も大きいもの (= 流した後に残る定義) が
 *      本 migration で、隠した行 (hidden_at が入った行) を除いている。後の migration が除かない定義で上書きしていない
 *   3. 本 migration とロールバックの冒頭のコメント・「戻し方」の参照が、実際のファイル名と一致する
 *   4. 本 migration の番号を書いた文書・コード・テストが、実在する migration の version だけを指している
 *      (付け直しの前の番号が残っていない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_count_meals_per_user_exclude_hidden';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;
/** 文面に書かれた migration の version らしい 14 桁の数 (2000 年代の日時) */
const VERSION_TOKEN = /\b20\d{12}\b/g;

/** 本 migration の番号を書いている文書・コード・テスト */
const REFERENCING_FILES = [
  'ENV_SETUP.md',
  'supabase/functions/calculate-segment-stats/index.ts',
  'tests/calculate-segment-stats-planned-meals.test.ts',
  'tests/integration/security/count-meals-per-user.test.ts',
];

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();

const versionOf = (name: string): string => {
  const match = MIGRATION_FILE.exec(name);
  if (!match) throw new Error(`migration のファイル名ではない: ${name}`);
  return match[1];
};

const versions = new Set(migrationFiles.map(versionOf));

const excludeHidden = migrationFiles.filter((name) => name.endsWith(`${STEM_SUFFIX}.sql`));

/** `--` から行末までのコメントを除く */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('#1445 (c) count_meals_per_user の隠した行の除外 migration の番号と参照', () => {
  it('本 migration はちょうど 1 本ある', () => {
    expect(excludeHidden).toHaveLength(1);
  });

  it('migration の version は重複しない', () => {
    expect(versions.size).toBe(migrationFiles.length);
  });

  it('count_meals_per_user を最後に定義する migration が本 migration で、hidden_at IS NULL で絞っている', () => {
    const definers = migrationFiles.filter((name) =>
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.count_meals_per_user\s*\(/i.test(
        stripLineComments(read(`${MIGRATIONS_DIR}/${name}`)),
      ),
    );
    expect(definers.length).toBeGreaterThanOrEqual(2);
    const last = definers[definers.length - 1];
    expect(last).toBe(excludeHidden[0]);
    expect(stripLineComments(read(`${MIGRATIONS_DIR}/${last}`))).toMatch(/WHERE\s+m\.hidden_at\s+IS\s+NULL/i);
  });

  it('冒頭のコメントと「戻し方」・ロールバックの参照が実際のファイル名と一致する', () => {
    const name = excludeHidden[0];
    const stem = name.replace(/\.sql$/, '');
    const rollback = `${ROLLBACKS_DIR}/${stem}.down.sql`;
    expect(fs.existsSync(path.join(ROOT, rollback))).toBe(true);

    const migrationText = read(`${MIGRATIONS_DIR}/${name}`);
    expect(migrationText.split('\n')[0]).toBe(`-- migration: ${name}`);
    expect(migrationText).toContain(`-- 戻し方: ${rollback}`);

    const rollbackText = read(rollback);
    expect(rollbackText.split('\n')[0]).toBe(`-- rollback: ${name}`);
  });

  it('本 migration の番号を書いた文書・コード・テストは、実在する migration の version だけを指す', () => {
    const own = versionOf(excludeHidden[0]);
    const dangling: string[] = [];
    let mentionsOwn = 0;
    for (const file of REFERENCING_FILES) {
      for (const token of read(file).match(VERSION_TOKEN) ?? []) {
        if (token === own) mentionsOwn += 1;
        if (!versions.has(token)) dangling.push(`${file}: ${token}`);
      }
    }
    expect(dangling).toEqual([]);
    // 4 ファイルのどれもが本 migration の番号を書いている (付け直しで置き換え漏れが無いことの裏返し)
    for (const file of REFERENCING_FILES) {
      expect(read(file), file).toContain(own);
    }
    expect(mentionsOwn).toBeGreaterThanOrEqual(REFERENCING_FILES.length);
  });
});
