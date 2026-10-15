/**
 * #1659 (#1634) 設計書の正典 SQL (docs/design/membership/01-data-model.md §4.1) と、paste_meal_to_family を最後に定義する migration の突き合わせ (DB は使わない)
 *
 * 設計書の正典を写して実装すると、古い正典の欠陥 (元の行が無いと持ち主の確認をすり抜ける `IF v_source.user_id <> auth.uid()`。#1634) を戻してしまう。
 * 関数を作り直す migration を足したのに設計書を写し直し忘れたら、ここで落とす。
 *   1. §4.1 の ```sql のブロックの関数の定義 (CREATE OR REPLACE ... END $$;) が、コメントと空白の違いを除いて、
 *      paste_meal_to_family を最後に定義する migration の定義と一致する
 *   2. §4.1 の権限の文 (ALTER FUNCTION ... OWNER / REVOKE / GRANT) が、その migration の権限の文と一致する
 *   3. §4.1 の本文が、その migration のファイル名を「正」として名指しする
 *   4. 写した定義は、元の行が無いときも断る持ち主の確認と、監査の行 (membership_audit の paste_executed) を含む
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const DESIGN_DOC = 'docs/design/membership/01-data-model.md';
/** §4.1 の見出し (この行から次の見出しの手前までを §4.1 とみなす) */
const SECTION_HEADING = '### 4.1 ペースト RPC';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^\d{14}_.+\.sql$/;
/** paste_meal_to_family を作り直す文 */
const DEFINES_FUNCTION = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.paste_meal_to_family\s*\(/i;
/** 関数の定義 (CREATE OR REPLACE ... END $$;) */
const DEFINITION = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.paste_meal_to_family\s*\([\s\S]*?\$\$[\s\S]*?END\s+\$\$;/i;
/** 権限と持ち主の文 (1 文ずつ。`;` まで) */
const PRIVILEGE_STATEMENT = /^(?:ALTER\s+FUNCTION|REVOKE|GRANT)\s[^;]*public\.paste_meal_to_family[^;]*;/gim;
/** 見出し (§4.1 の終わりを探す) */
const NEXT_HEADING = /^#{1,3} /m;
/** §4.1 の SQL のブロック */
const SQL_FENCE = /```sql\n([\s\S]*?)\n```/;

/** 元の行が無いときも、持ち主の列が NULL のときも断る持ち主の確認 (#1634) */
const OWNER_CHECK = 'IF NOT FOUND OR v_source.user_id IS DISTINCT FROM auth.uid() THEN';
/** 元の行が無いと NULL になってすり抜ける、古い持ち主の確認 */
const OLD_OWNER_CHECK = 'IF v_source.user_id <> auth.uid() THEN';
/** 監査の行 (本番の定義が書くもの) */
const AUDIT_INSERT = "INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata) VALUES ('family', v_caller_family_id, 'paste_executed', auth.uid(),";

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** `--` から行末までのコメントを除く */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** 空白の並びを 1 つに詰める */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** 関数の定義を、コメントを除き空白を詰めて取り出す */
function definitionOf(sql: string, where: string): string {
  const match = DEFINITION.exec(stripLineComments(sql));
  if (!match) throw new Error(`paste_meal_to_family の定義が無い: ${where}`);
  return squash(match[0]);
}

/** 権限と持ち主の文を、コメントを除き空白を詰めて並べる */
function privilegesOf(sql: string): string[] {
  return (stripLineComments(sql).match(PRIVILEGE_STATEMENT) ?? []).map(squash);
}

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();

/** paste_meal_to_family を定義する migration (番号の順) */
const definers = migrationFiles.filter((name) => DEFINES_FUNCTION.test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))));

/** 流した後に残る定義 = 番号の最も大きい migration */
function latestDefiner(): string {
  const latest = definers[definers.length - 1];
  if (!latest) throw new Error('paste_meal_to_family を定義する migration が無い');
  return latest;
}

/** 設計書の §4.1 (見出しから次の見出しの手前まで) */
function designSection(): string {
  const doc = read(DESIGN_DOC);
  const start = doc.indexOf(SECTION_HEADING);
  if (start < 0) throw new Error(`${DESIGN_DOC} に「${SECTION_HEADING}」が無い`);
  const rest = doc.slice(start + SECTION_HEADING.length);
  const next = NEXT_HEADING.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** 設計書の §4.1 の SQL のブロック */
function designSql(): string {
  const match = SQL_FENCE.exec(designSection());
  if (!match) throw new Error(`${DESIGN_DOC} §4.1 に SQL のブロックが無い`);
  return match[1];
}

describe('#1659 設計書の paste_meal_to_family の正典 SQL は、最後に定義する migration と一致する', () => {
  it('paste_meal_to_family を定義する migration がある', () => {
    expect(definers.length).toBeGreaterThan(0);
  });

  it('§4.1 の関数の定義は、コメントと空白の違いを除いて最後に定義する migration と同じ', () => {
    const latest = latestDefiner();
    expect(definitionOf(designSql(), `${DESIGN_DOC} §4.1`)).toBe(definitionOf(read(`${MIGRATIONS_DIR}/${latest}`), latest));
  });

  it('§4.1 の権限と持ち主の文は、最後に定義する migration と同じ', () => {
    const latest = latestDefiner();
    const expected = privilegesOf(read(`${MIGRATIONS_DIR}/${latest}`));
    expect(expected.length).toBeGreaterThan(0);
    expect(privilegesOf(designSql())).toEqual(expected);
  });

  it('§4.1 の本文は、最後に定義する migration のファイル名を正として名指しする', () => {
    expect(designSection()).toContain(`\`${latestDefiner()}\``);
  });

  it('写した定義は、元の行が無いときも断る持ち主の確認と、監査の行 (paste_executed) を含む', () => {
    const definition = definitionOf(designSql(), `${DESIGN_DOC} §4.1`);
    expect(definition).toContain(OWNER_CHECK);
    expect(definition).not.toContain(OLD_OWNER_CHECK);
    expect(definition).toContain(AUDIT_INSERT);
  });
});
