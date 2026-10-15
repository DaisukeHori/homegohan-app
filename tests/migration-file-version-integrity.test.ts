/**
 * #1636 migration のファイル名 (版の番号) と、番号を書いた箇所の付け直し漏れを見張る静的な検査 (DB を使わない)。
 *
 * 背景: #1636 の migration は並行の案件と番号が重なって付け直し、さらに main に入った新しい migration より
 * 番号が小さくなったため、もう一度付け直した。
 * 付け直しではファイル名・1 行目の見出し・戻し口のファイル名と見出し・本文の「戻し方」の参照を全部そろえる必要があり、
 * 1 箇所でも残ると、戻し口が別の migration を指したり、存在しないファイルを案内したりする。
 *
 * ここで確かめること:
 *   - supabase/migrations の版の番号 (ファイル名の先頭 14 桁) が重ならない (重なると片方しか当たらない)
 *   - migration の 1 行目が `-- migration: <名前>` なら、その名前が自分のファイル名と一致する
 *   - migration の本文が案内する `supabase/rollbacks/<名前>` が実在する
 *   - 戻し口 `supabase/rollbacks/<版>_<名>.down.sql` には同じ名前の migration があり、
 *     1 行目が `-- rollback: <名前>` ならその名前もその migration を指す
 *   - #1636 の migration と戻し口がいまの番号で対になっている (付け直しの番兵)
 *
 * ここで確かめられないこと: main に入った migration の最大番号より上かどうか。main は並行の案件で動くので、
 * 静的なテストに番号を固定すると後から入る案件で main が赤になる。この順序は
 * .github/workflows/deploy-supabase-migrations.yml の drift の検査 (台帳の最大以下の LOCAL_ONLY を止める) が受け持つ。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase/rollbacks');

/** 版の番号 = YYYYMMDDHHMMSS の 14 桁 (supabase CLI の migration の版の形) */
const VERSION_PATTERN = /^(\d{14})_[A-Za-z0-9_]+\.sql$/;
/** 戻し口のファイル名の形 (<migration のファイル名から .sql を除いたもの>.down.sql) */
const ROLLBACK_PATTERN = /^(\d{14}_[A-Za-z0-9_]+)\.down\.sql$/;
const MIGRATION_HEADER = /^-- migration:\s*(\S+)/;
const ROLLBACK_HEADER = /^-- rollback:\s*(\S+)/;
const ROLLBACK_REFERENCE = /supabase\/rollbacks\/([A-Za-z0-9_]+(?:\.down)?\.sql)/g;

/** #1636 の migration の名前 (付け直しの番兵) */
const PUSH_TOKEN_INSTALL_SECRET_MIGRATION = '20261016163600_user_push_tokens_install_secret';

/** 見出しの名前は .sql を付けない書き方も既存にあるので、.sql を補ってから比べる */
function withSqlExtension(name: string): string {
  return name.endsWith('.sql') ? name : `${name}.sql`;
}

function firstLine(file: string): string {
  return fs.readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
}

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
const rollbackFiles = fs.readdirSync(ROLLBACKS_DIR).filter((name) => ROLLBACK_PATTERN.test(name)).sort();
const migrationSet = new Set(migrationFiles);

describe('#1636 migration のファイル名と番号の参照', () => {
  it('migration と戻し口を読めている (読み取りが壊れて素通りしない)', () => {
    expect(migrationFiles).toContain(`${PUSH_TOKEN_INSTALL_SECRET_MIGRATION}.sql`);
    expect(rollbackFiles).toContain(`${PUSH_TOKEN_INSTALL_SECRET_MIGRATION}.down.sql`);
  });

  it('migration のファイル名はどれも <14 桁の版>_<名>.sql の形', () => {
    const malformed = migrationFiles.filter((name) => !VERSION_PATTERN.test(name));
    expect(malformed).toEqual([]);
  });

  it('migration の版の番号が重ならない', () => {
    const byVersion = new Map<string, string[]>();
    for (const name of migrationFiles) {
      const version = VERSION_PATTERN.exec(name)?.[1];
      if (version === undefined) continue;
      byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
    }
    const duplicated = [...byVersion.values()].filter((names) => names.length > 1);
    expect(duplicated).toEqual([]);
  });

  it('migration の 1 行目の見出しの名前が自分のファイル名と一致する', () => {
    const mismatched: string[] = [];
    for (const name of migrationFiles) {
      const header = MIGRATION_HEADER.exec(firstLine(path.join(MIGRATIONS_DIR, name)))?.[1];
      if (header !== undefined && withSqlExtension(header) !== name) mismatched.push(`${name} :: ${header}`);
    }
    expect(mismatched).toEqual([]);
  });

  it('migration が案内する supabase/rollbacks/ のファイルが実在する', () => {
    const missing: string[] = [];
    for (const name of migrationFiles) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      for (const match of sql.matchAll(ROLLBACK_REFERENCE)) {
        const target = match[1];
        if (!fs.existsSync(path.join(ROLLBACKS_DIR, target))) missing.push(`${name} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('戻し口には同じ名前の migration があり、1 行目の見出しもその migration を指す', () => {
    const orphaned: string[] = [];
    const mismatched: string[] = [];
    for (const name of rollbackFiles) {
      const migration = `${ROLLBACK_PATTERN.exec(name)?.[1] ?? ''}.sql`;
      if (!migrationSet.has(migration)) orphaned.push(name);
      const header = ROLLBACK_HEADER.exec(firstLine(path.join(ROLLBACKS_DIR, name)))?.[1];
      if (header !== undefined && withSqlExtension(header) !== migration) mismatched.push(`${name} :: ${header}`);
    }
    expect(orphaned).toEqual([]);
    expect(mismatched).toEqual([]);
  });

  it('#1636 の migration の見出し・戻し方の案内・戻し口の見出しがいまの番号でそろっている', () => {
    const migrationPath = path.join(MIGRATIONS_DIR, `${PUSH_TOKEN_INSTALL_SECRET_MIGRATION}.sql`);
    const rollbackPath = path.join(ROLLBACKS_DIR, `${PUSH_TOKEN_INSTALL_SECRET_MIGRATION}.down.sql`);
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    expect(firstLine(migrationPath)).toBe(`-- migration: ${PUSH_TOKEN_INSTALL_SECRET_MIGRATION}.sql`);
    expect([...migrationSql.matchAll(ROLLBACK_REFERENCE)].map((match) => match[1])).toEqual([
      `${PUSH_TOKEN_INSTALL_SECRET_MIGRATION}.down.sql`,
    ]);
    expect(firstLine(rollbackPath)).toBe(`-- rollback: ${PUSH_TOKEN_INSTALL_SECRET_MIGRATION}.sql`);
  });
});
