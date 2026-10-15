/**
 * #1178 個人情報の請求の表 (supabase/migrations/<番号>_data_subject_requests.sql) と、正典 src/lib/data-subject-requests/core.ts の
 * 突き合わせ (DB 無し。SQL の文面を読む。設計 cross/15 §4.1・§15)
 *
 * 確かめること:
 *   - auth.users を指す FK は 1 本で ON DELETE SET NULL (退会しても行と応答の記録が残る)
 *   - CHECK の値が core.ts の DSR_REQUEST_TYPES・DSR_STATUSES・DSR_VERIFICATION_METHOD と同じ。長さの CHECK が DSR_DETAILS_MAX_LENGTH・DSR_NOTE_MAX_LENGTH と同じ
 *   - 部分一意索引の WHERE が DSR_OPEN_STATUSES と同じ
 *   - REVOKE が完全形 (PUBLIC, anon, authenticated, service_role)。authenticated は列の GRANT SELECT (…) だけ (表全体の SELECT は無い)。
 *     その列が DSR_OWN_COLUMNS と同じ集合 (admin_notes・verification_token_hash を含まない)。service_role に DELETE が無い。
 *     authenticated / anon に INSERT・UPDATE・DELETE のポリシーも権限も無い
 *   - 既存の表・関数に触れる文が無い (新しい表を足すだけ)
 *   - down は DROP TABLE IF EXISTS だけ
 * 実 DB での確認は tests/integration/rls/data-subject-requests.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DSR_DETAILS_MAX_LENGTH,
  DSR_NOTE_MAX_LENGTH,
  DSR_OPEN_STATUSES,
  DSR_OPERATOR_ROLES,
  DSR_OWN_COLUMNS,
  DSR_REQUEST_TYPES,
  DSR_STATUSES,
  DSR_VERIFICATION_METHOD,
} from '@/lib/data-subject-requests/core';

const ROOT = path.resolve(__dirname, '..');
const NAME = 'data_subject_requests';

function findOne(dir: string, pattern: RegExp): string {
  const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => pattern.test(f));
  expect(files).toHaveLength(1);
  return path.join(ROOT, dir, files[0]);
}

/** SQL のコメント (-- から行末) を外す。説明文の中の語に当たらないようにする */
function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

const migrationPath = findOne('supabase/migrations', new RegExp(`^\\d{14}_${NAME}\\.sql$`));
const rollbackPath = findOne('supabase/rollbacks', new RegExp(`^\\d{14}_${NAME}\\.down\\.sql$`));
const migration = stripSqlComments(fs.readFileSync(migrationPath, 'utf8'));
const rollback = stripSqlComments(fs.readFileSync(rollbackPath, 'utf8'));

/** 'a', 'b' の並びを配列にする */
function quotedList(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function checkBody(name: string): string {
  const body = new RegExp(`CONSTRAINT ${name}\\s+CHECK \\(([\\s\\S]*?)\\),?\\n`).exec(migration)?.[1];
  expect(body, name).toBeDefined();
  return body ?? '';
}

function columnsOf(list: string): string[] {
  return list.split(',').map((c) => c.trim()).filter(Boolean);
}

/** 文 (; まで) の一覧。空白を 1 つにそろえる */
const statements = migration
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

describe('data_subject_requests の migration と core.ts', () => {
  it('migration と down の番号が同じ', () => {
    expect(path.basename(rollbackPath).replace('.down.sql', '.sql')).toBe(path.basename(migrationPath));
  });

  it('auth.users を指す FK は 1 本で ON DELETE SET NULL・user_id は NULL 許容', () => {
    const refs = [...migration.matchAll(/REFERENCES auth\.users\(id\)([^,\n]*)/g)];
    expect(refs).toHaveLength(1);
    expect(refs[0][1].trim()).toBe('ON DELETE SET NULL');
    expect(migration).toMatch(/\n\s+user_id\s+UUID\s+REFERENCES auth\.users\(id\) ON DELETE SET NULL,/);
    expect(migration).not.toMatch(/user_id\s+UUID\s+NOT NULL/);
  });

  it('種類・状態・本人確認の方法の CHECK の値が core.ts と同じ', () => {
    expect(quotedList(checkBody('data_subject_requests_request_type_check'))).toEqual([...DSR_REQUEST_TYPES]);
    expect(quotedList(checkBody('data_subject_requests_status_check'))).toEqual([...DSR_STATUSES]);
    expect(quotedList(checkBody('data_subject_requests_verification_method_check'))).toEqual([DSR_VERIFICATION_METHOD]);
    expect(migration).toMatch(/\n\s+status\s+TEXT\s+NOT NULL DEFAULT 'pending_verification',/);
    expect(migration).toMatch(new RegExp(`\\n\\s+verification_method\\s+TEXT\\s+NOT NULL DEFAULT '${DSR_VERIFICATION_METHOD}',`));
  });

  it('長さの CHECK が DSR_DETAILS_MAX_LENGTH・DSR_NOTE_MAX_LENGTH と同じ', () => {
    expect(checkBody('data_subject_requests_details_length_check')).toBe(`char_length(details) BETWEEN 1 AND ${DSR_DETAILS_MAX_LENGTH}`);
    expect(checkBody('data_subject_requests_response_note_length_check')).toBe(
      `response_note IS NULL OR char_length(response_note) <= ${DSR_NOTE_MAX_LENGTH}`,
    );
    expect(checkBody('data_subject_requests_admin_notes_length_check')).toBe(
      `admin_notes IS NULL OR char_length(admin_notes) <= ${DSR_NOTE_MAX_LENGTH}`,
    );
  });

  it('部分一意索引 (同じ人・同じ種類の開いている請求は 1 つ) の WHERE が DSR_OPEN_STATUSES と同じ', () => {
    const index = /CREATE UNIQUE INDEX IF NOT EXISTS data_subject_requests_one_open_per_type\s+ON public\.data_subject_requests \(user_id, request_type\)\s+WHERE status IN \(([^)]*)\)/.exec(
      migration,
    );
    expect(index).not.toBeNull();
    expect(quotedList(index?.[1] ?? '')).toEqual([...DSR_OPEN_STATUSES]);
  });

  it('RLS を有効にし、既定の権限を完全形で外す', () => {
    expect(statements).toContain('ALTER TABLE public.data_subject_requests ENABLE ROW LEVEL SECURITY');
    expect(statements).toContain('REVOKE ALL ON public.data_subject_requests FROM PUBLIC, anon, authenticated, service_role');
  });

  it('authenticated は列の GRANT SELECT (…) だけで、その列は DSR_OWN_COLUMNS と同じ集合 (内部メモと hash を含まない)', () => {
    const grants = statements.filter((s) => /^GRANT /.test(s));
    const toAuthenticated = grants.filter((s) => / TO authenticated$/.test(s));
    expect(toAuthenticated).toHaveLength(1);
    const columns = /^GRANT SELECT \(([^)]*)\) ON public\.data_subject_requests TO authenticated$/.exec(toAuthenticated[0])?.[1];
    expect(columns).toBeDefined();
    const granted = columnsOf(columns ?? '');
    expect([...granted].sort()).toEqual([...columnsOf(DSR_OWN_COLUMNS)].sort());
    expect(granted).not.toContain('admin_notes');
    expect(granted).not.toContain('verification_token_hash');
    // 表全体の GRANT SELECT (列の指定なし) を authenticated / anon に付けない
    expect(grants.some((s) => /^GRANT SELECT ON public\.data_subject_requests TO/.test(s))).toBe(false);
    expect(grants.some((s) => /\banon\b/.test(s))).toBe(false);
  });

  it('service_role は SELECT, INSERT, UPDATE だけ (DELETE は誰にも付けない)', () => {
    const toServiceRole = statements.filter((s) => /^GRANT .* TO service_role$/.test(s));
    expect(toServiceRole).toEqual(['GRANT SELECT, INSERT, UPDATE ON public.data_subject_requests TO service_role']);
    expect(statements.some((s) => /^GRANT [^;]*\bDELETE\b/.test(s))).toBe(false);
    expect(statements.some((s) => /^GRANT ALL\b/.test(s))).toBe(false);
  });

  it('ポリシーは SELECT の 2 本だけ (本人の行・運営のロール)。書き込みのポリシーは無い', () => {
    const policies = statements.filter((s) => /^CREATE POLICY /.test(s));
    expect(policies).toHaveLength(2);
    for (const policy of policies) expect(policy).toMatch(/ FOR SELECT TO authenticated USING /);
    expect(policies[0]).toContain('data_subject_requests_select_self');
    expect(policies[0]).toContain('USING (user_id = (SELECT auth.uid()))');
    expect(policies[1]).toContain('data_subject_requests_select_operator');
    const roles = /ARRAY\[([^\]]*)\]::TEXT\[\] && up\.roles/.exec(policies[1])?.[1];
    expect(quotedList(roles ?? '')).toEqual([...DSR_OPERATOR_ROLES]);
  });

  it('既存の表・関数に触れる文が無い (新しい表・索引・トリガー・ポリシー・コメントだけ)', () => {
    const allowed = [
      /^CREATE TABLE IF NOT EXISTS public\.data_subject_requests /,
      /^CREATE (UNIQUE )?INDEX IF NOT EXISTS \w+ ON public\.data_subject_requests /,
      /^DROP TRIGGER IF EXISTS trigger_data_subject_requests_updated_at ON public\.data_subject_requests$/,
      /^CREATE TRIGGER trigger_data_subject_requests_updated_at BEFORE UPDATE ON public\.data_subject_requests FOR EACH ROW EXECUTE FUNCTION public\.update_updated_at_column\(\)$/,
      /^ALTER TABLE public\.data_subject_requests ENABLE ROW LEVEL SECURITY$/,
      /^REVOKE ALL ON public\.data_subject_requests FROM /,
      /^GRANT .* ON public\.data_subject_requests TO /,
      /^DROP POLICY IF EXISTS \w+ ON public\.data_subject_requests$/,
      /^CREATE POLICY \w+ ON public\.data_subject_requests /,
      /^COMMENT ON (TABLE|COLUMN) public\.data_subject_requests\b/,
    ];
    for (const statement of statements) {
      expect(allowed.some((re) => re.test(statement)), statement.slice(0, 120)).toBe(true);
    }
    expect(migration).not.toMatch(/\bCREATE (OR REPLACE )?FUNCTION\b/i);
    expect(migration).not.toMatch(/\bALTER TABLE (?!public\.data_subject_requests )/i);
  });

  it('本人確認と受付・終わりの整合の CHECK がある', () => {
    expect(checkBody('data_subject_requests_send_count_check')).toBe('verification_send_count >= 0');
    expect(migration).toContain('CONSTRAINT data_subject_requests_verified_consistency_check CHECK (');
    expect(migration).toContain(
      "(status = 'pending_verification' AND verified_at IS NULL AND due_at IS NULL)",
    );
    expect(migration).toContain(
      "OR (status IN ('received', 'in_progress', 'fulfilled', 'rejected') AND verified_at IS NOT NULL AND due_at IS NOT NULL)",
    );
    expect(migration).toContain("(status IN ('fulfilled', 'rejected', 'withdrawn')) = (resolved_at IS NOT NULL)");
  });

  it('down は DROP TABLE IF EXISTS だけ', () => {
    const downStatements = rollback
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    expect(downStatements).toEqual(['DROP TABLE IF EXISTS public.data_subject_requests']);
  });
});
