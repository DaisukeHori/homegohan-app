/**
 * #1176 運営ロールの MFA のバックアップコードの表 (supabase/migrations/<番号>_operator_mfa_backup_codes.sql) の文面の検査 (DB 無し)。
 * docs/design/cross/12-operator-mfa.md §11.1・§21.3 (operator-mfa-backup-codes-migration-contract.test.ts)
 *
 * 確かめること:
 *   - CREATE TABLE IF NOT EXISTS public.operator_mfa_backup_codes・UNIQUE (user_id, code_hash)・hex 64 の CHECK・部分 index (used_at IS NULL)
 *   - ENABLE ROW LEVEL SECURITY・ポリシーが 1 つも無い (service_role 専用)・REVOKE (PUBLIC / anon / authenticated) と GRANT (service_role) の行
 *   - 利用者を消すと行も消える (auth.users への ON DELETE CASCADE)
 *   - down が DROP TABLE / DROP INDEX だけ
 *   - 冒頭のコメントの参照先が実在する (段 B で作る結合テストを除く。下の FORWARD_REFERENCES)
 *   - 表の列が型の生成物 (database.types.ts) と食い違わない・アカウントの書き出しで「出さない表」に分類されている (§23 N-24)
 * 実 DB での確認は段 B の tests/integration/security/operator-mfa.test.ts (M-6)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_EXPORT_EXCLUDED, ACCOUNT_EXPORT_TABLES } from '@/lib/account-export-tables';
import { hashBackupCode } from '@/lib/auth/mfa/backup-codes';

const ROOT = path.resolve(__dirname, '..');
const NAME = 'operator_mfa_backup_codes';
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;
/**
 * 冒頭のコメントが名指しするが、段 A の時点ではまだ無いファイルと理由 (設計書 §11.1 の正典の文面のまま写したため)。
 * 段 B でファイルを作ったら、この一覧から外す (下の検査が「もう実在する」で赤になる)
 */
const FORWARD_REFERENCES: Readonly<Record<string, string>> = {
  'tests/integration/security/operator-mfa.test.ts':
    '実 DB の結合テストは段 B (docs/design/cross/12-operator-mfa.md §21.4・§22.1 の B の行) で作る',
};

function migrationFile(): string {
  const files = fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).filter((f) => new RegExp(`^\\d{14}_${NAME}\\.sql$`).test(f));
  expect(files).toHaveLength(1);
  return files[0];
}

const MIGRATION_FILE = migrationFile();
const ROLLBACK_FILE = MIGRATION_FILE.replace(/\.sql$/, '.down.sql');
const rawMigration = fs.readFileSync(path.join(ROOT, MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
const rawRollback = fs.readFileSync(path.join(ROOT, ROLLBACKS_DIR, ROLLBACK_FILE), 'utf8');

/** SQL のコメント (-- から行末) を外す。説明文の中の語に当たらないようにする */
function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

/** 空白をまとめる */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const migration = squash(stripSqlComments(rawMigration));
const rollback = squash(stripSqlComments(rawRollback));

/** 文 (; 区切り) の一覧 */
function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('operator_mfa_backup_codes の migration', () => {
  it('表: CREATE TABLE IF NOT EXISTS・列と型・auth.users への ON DELETE CASCADE・UNIQUE (user_id, code_hash)・hex 64 の CHECK', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.operator_mfa_backup_codes (');
    expect(migration).toContain('id uuid PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(migration).toContain('user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(migration).toContain('batch_id uuid NOT NULL');
    expect(migration).toContain('code_hash text NOT NULL');
    expect(migration).toContain('created_at timestamptz NOT NULL DEFAULT now()');
    expect(migration).toMatch(/used_at timestamptz,/);
    expect(migration).toContain('CONSTRAINT operator_mfa_backup_codes_user_hash_key UNIQUE (user_id, code_hash)');
    expect(migration).toContain("CONSTRAINT operator_mfa_backup_codes_code_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$')");
    // CHECK の形は、アプリが保存するハッシュ (hashBackupCode) に合う
    expect(new RegExp('^[0-9a-f]{64}$').test(hashBackupCode('11111111-1111-4111-8111-111111111111', 'ABCDEFGHJK'))).toBe(true);
  });

  it('部分 index: 未使用 (used_at IS NULL) の行を user_id で引く', () => {
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS operator_mfa_backup_codes_user_unused_idx ON public.operator_mfa_backup_codes (user_id) WHERE used_at IS NULL',
    );
  });

  it('権限: ENABLE ROW LEVEL SECURITY・ポリシーが 1 つも無い・REVOKE (PUBLIC / anon / authenticated) と GRANT (service_role) の行', () => {
    expect(migration).toContain('ALTER TABLE public.operator_mfa_backup_codes ENABLE ROW LEVEL SECURITY');
    expect(migration).not.toMatch(/CREATE POLICY/i);
    expect(migration).not.toMatch(/ALTER POLICY/i);
    expect(migration).toContain('REVOKE ALL ON TABLE public.operator_mfa_backup_codes FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.operator_mfa_backup_codes TO service_role');
    // anon / authenticated に GRANT する文は無い
    for (const statement of statements(migration).filter((s) => /^GRANT /i.test(s))) {
      expect(statement).not.toMatch(/\b(anon|authenticated|PUBLIC)\b/);
    }
  });

  it('既存の表・列・関数に触れない (CREATE TABLE / INDEX / ALTER TABLE ENABLE RLS / REVOKE / GRANT / COMMENT だけ)', () => {
    const allowed = [/^CREATE TABLE /, /^CREATE INDEX /, /^ALTER TABLE /, /^REVOKE ALL /, /^GRANT /, /^COMMENT ON /];
    const all = statements(migration);
    expect(all.length).toBeGreaterThan(0);
    for (const statement of all) {
      expect(allowed.some((pattern) => pattern.test(statement)), statement).toBe(true);
    }
    for (const statement of statements(migration).filter((s) => /^ALTER TABLE/i.test(s))) {
      expect(statement).toBe('ALTER TABLE public.operator_mfa_backup_codes ENABLE ROW LEVEL SECURITY');
    }
    for (const statement of statements(migration).filter((s) => /^COMMENT ON/i.test(s))) {
      expect(statement).toMatch(/^COMMENT ON (TABLE|COLUMN) public\.operator_mfa_backup_codes\b/);
    }
  });

  it('down が DROP TABLE / DROP INDEX だけ', () => {
    expect(statements(rollback)).toEqual([
      'DROP INDEX IF EXISTS public.operator_mfa_backup_codes_user_unused_idx',
      'DROP TABLE IF EXISTS public.operator_mfa_backup_codes',
    ]);
  });

  it('冒頭のコメントの参照先が実在する (段 B で作る結合テストは FORWARD_REFERENCES)', () => {
    const referenced = new Set(
      [...rawMigration.matchAll(/((?:supabase|tests|docs|src)\/[\w./-]+\.(?:sql|ts|md))/g)].map((m) => m[1]),
    );
    const rollbackRefs = [...rawRollback.matchAll(/^-- rollback: (\S+)$/gm)].map((m) => m[1]);
    expect(rollbackRefs).toEqual([MIGRATION_FILE]);
    expect(referenced).toContain(`${ROLLBACKS_DIR}/${ROLLBACK_FILE}`);
    expect(referenced).toContain('tests/operator-mfa-backup-codes-migration-contract.test.ts');
    expect(referenced).toContain('docs/design/cross/12-operator-mfa.md');
    expect(rawMigration).toContain(`-- migration: ${MIGRATION_FILE}`);
    for (const ref of referenced) {
      const exists = fs.existsSync(path.join(ROOT, ref));
      if (ref in FORWARD_REFERENCES) {
        expect(exists, `${ref} はもう実在する。FORWARD_REFERENCES から外す`).toBe(false);
        expect(FORWARD_REFERENCES[ref].length).toBeGreaterThan(10);
      } else {
        expect(exists, ref).toBe(true);
      }
    }
    for (const ref of Object.keys(FORWARD_REFERENCES)) expect(referenced).toContain(ref);
  });

  it('型の生成物 (2 ファイル) の Row の列が migration の列と同じで、アカウントの書き出しでは「出さない表」に分類されている', () => {
    const columns = ['batch_id', 'code_hash', 'created_at', 'id', 'used_at', 'user_id'];
    for (const file of TYPE_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const block = new RegExp(`\\n      ${NAME}: \\{\\n        Row: \\{\\n([\\s\\S]*?)\\n        \\}`).exec(source)?.[1];
      expect(block, file).toBeDefined();
      const rowColumns = (block ?? '')
        .split('\n')
        .map((line) => /^\s+([a-z_]+)\??:/.exec(line)?.[1])
        .filter((c): c is string => Boolean(c));
      expect(rowColumns, file).toEqual(columns);
      expect(block, file).toContain('used_at: string | null');
    }
    expect(ACCOUNT_EXPORT_EXCLUDED[NAME]).toBe('二段階認証のバックアップコードのハッシュ (認証情報)');
    expect(ACCOUNT_EXPORT_TABLES.map((spec) => spec.table)).not.toContain(NAME);
  });
});
