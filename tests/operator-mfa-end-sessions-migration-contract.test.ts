/**
 * #1707 運営ロールの MFA: 別の super_admin による解除 (段 C) が対象の全セッションを終える関数
 * (supabase/migrations/<番号>_operator_mfa_end_sessions.sql) の文面の検査 (DB 無し)。
 * docs/design/cross/12-operator-mfa.md §11.5・§21.3 (operator-mfa-end-sessions-migration-contract.test.ts)
 *
 * 確かめること:
 *   - CREATE OR REPLACE FUNCTION public.operator_mfa_end_sessions(p_user_id uuid) が RETURNS integer・LANGUAGE plpgsql・VOLATILE・
 *     SECURITY DEFINER・SET search_path = ''
 *   - 本体の DELETE は DELETE FROM auth.sessions s WHERE s.user_id = p_user_id の 1 文だけで、UPDATE・INSERT・ended_reason・
 *     user_sessions_metadata の語が無い (判定も記録も持たない)。GET DIAGNOSTICS v_deleted = ROW_COUNT と RETURN v_deleted
 *   - REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role と GRANT EXECUTE ... TO service_role
 *   - down は DROP FUNCTION IF EXISTS public.operator_mfa_end_sessions(uuid) だけ
 *   - OPERATOR_MFA_END_SESSIONS_RPC (src/lib/auth/mfa/sessions.ts) と関数の名前が同じ
 *   - 型の生成物 2 ファイルの Functions に operator_mfa_end_sessions (Args p_user_id: string・Returns number) がある
 *   - 冒頭のコメントの参照先が実在する (operator-mfa-backup-codes-migration-contract.test.ts と同じ型)
 * 実 DB での確認は tests/integration/security/operator-mfa.test.ts (M-5・M-15・M-16) と
 * tests/integration/security/anon-definer-execute.test.ts (EXECUTE の権限)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATOR_MFA_END_SESSIONS_RPC } from '@/lib/auth/mfa/sessions';

const ROOT = path.resolve(__dirname, '..');
const NAME = 'operator_mfa_end_sessions';
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;

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

/** 関数の本体 ($$ と $$ の間) */
function functionBody(): string {
  const match = /AS \$\$ (.*?) \$\$;/.exec(migration);
  expect(match, 'AS $$ ... $$; の本体').not.toBeNull();
  return match?.[1] ?? '';
}

/** 本体の外の文 (; 区切り) の一覧 */
function outerStatements(): string[] {
  return migration
    .replace(/AS \$\$ .*? \$\$;/, 'AS $$BODY$$;')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('operator_mfa_end_sessions の migration', () => {
  it("関数の宣言: CREATE OR REPLACE FUNCTION public.operator_mfa_end_sessions(p_user_id uuid)・RETURNS integer・LANGUAGE plpgsql・VOLATILE・SECURITY DEFINER・SET search_path = ''", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.operator_mfa_end_sessions(p_user_id uuid) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$",
    );
    // 同じ名前の関数を作るのはこの 1 か所だけ
    expect(migration.match(/CREATE (OR REPLACE )?FUNCTION/g)).toHaveLength(1);
  });

  it('本体: DELETE は auth.sessions の対象の行の 1 文だけで、判定も記録も持たない (UPDATE・INSERT・ended_reason・user_sessions_metadata が無い)。消した行数を返し、NULL は 22023', () => {
    const body = functionBody();
    expect(body.match(/\bDELETE\b/g)).toHaveLength(1);
    expect(body).toContain('DELETE FROM auth.sessions s WHERE s.user_id = p_user_id;');
    for (const word of ['UPDATE', 'INSERT', 'ended_reason', 'user_sessions_metadata', 'auth.uid', 'roles']) {
      expect(body, word).not.toContain(word);
    }
    expect(body).toContain('GET DIAGNOSTICS v_deleted = ROW_COUNT;');
    expect(body).toContain('RETURN v_deleted;');
    expect(body).toContain('DECLARE v_deleted integer;');
    expect(body).toContain(
      "IF p_user_id IS NULL THEN RAISE EXCEPTION 'operator_mfa_end_sessions: p_user_id is required' USING ERRCODE = '22023'; END IF;",
    );
  });

  it('権限: REVOKE ALL (PUBLIC / anon / authenticated / service_role) の後に GRANT EXECUTE を service_role にだけ', () => {
    const statements = outerStatements();
    const revoke = 'REVOKE ALL ON FUNCTION public.operator_mfa_end_sessions(uuid) FROM PUBLIC, anon, authenticated, service_role';
    const grant = 'GRANT EXECUTE ON FUNCTION public.operator_mfa_end_sessions(uuid) TO service_role';
    expect(statements).toContain(revoke);
    expect(statements).toContain(grant);
    expect(statements.indexOf(revoke)).toBeLessThan(statements.indexOf(grant));
    for (const statement of statements.filter((s) => /^GRANT /i.test(s))) {
      expect(statement).toBe(grant);
    }
  });

  it('関数の新設だけ (CREATE FUNCTION / REVOKE / GRANT / COMMENT ON FUNCTION のほかに文が無い。表・ポリシー・トリガーに触れない)', () => {
    const allowed = [/^CREATE OR REPLACE FUNCTION public\.operator_mfa_end_sessions\(/, /^REVOKE ALL ON FUNCTION /, /^GRANT EXECUTE ON FUNCTION /, /^COMMENT ON FUNCTION public\.operator_mfa_end_sessions\(uuid\) IS /];
    const statements = outerStatements();
    expect(statements).toHaveLength(4);
    for (const statement of statements) {
      expect(allowed.some((pattern) => pattern.test(statement)), statement).toBe(true);
    }
  });

  it('down は DROP FUNCTION IF EXISTS public.operator_mfa_end_sessions(uuid) だけ', () => {
    expect(
      rollback
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
    ).toEqual(['DROP FUNCTION IF EXISTS public.operator_mfa_end_sessions(uuid)']);
  });

  it('OPERATOR_MFA_END_SESSIONS_RPC (src/lib/auth/mfa/sessions.ts) と関数の名前が同じ', () => {
    expect(OPERATOR_MFA_END_SESSIONS_RPC).toBe(NAME);
  });

  it('型の生成物 2 ファイルの Functions に operator_mfa_end_sessions (Args p_user_id: string・Returns number) がある', () => {
    for (const file of TYPE_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const functionsAt = source.indexOf('\n    Functions: {');
      expect(functionsAt, file).toBeGreaterThan(0);
      const entry = new RegExp(`\\n      ${NAME}: \\{\\n        Args: \\{ p_user_id: string \\}\\n        Returns: number\\n      \\}`).exec(
        source.slice(functionsAt),
      );
      expect(entry, file).not.toBeNull();
    }
  });

  it('冒頭のコメントの参照先が実在する', () => {
    const referenced = new Set(
      [...rawMigration.matchAll(/((?:supabase|tests|docs|src)\/[\w./-]+\.(?:sql|ts|md))/g)].map((m) => m[1]),
    );
    const rollbackRefs = [...rawRollback.matchAll(/^-- rollback: (\S+)$/gm)].map((m) => m[1]);
    expect(rollbackRefs).toEqual([MIGRATION_FILE]);
    expect(referenced).toContain(`${ROLLBACKS_DIR}/${ROLLBACK_FILE}`);
    expect(referenced).toContain('tests/operator-mfa-end-sessions-migration-contract.test.ts');
    expect(referenced).toContain('tests/integration/security/operator-mfa.test.ts');
    expect(referenced).toContain('tests/integration/security/anon-definer-execute.test.ts');
    expect(referenced).toContain('docs/design/cross/12-operator-mfa.md');
    expect(rawMigration).toContain(`-- migration: ${MIGRATION_FILE}`);
    for (const ref of referenced) {
      expect(fs.existsSync(path.join(ROOT, ref)), ref).toBe(true);
    }
  });
});
