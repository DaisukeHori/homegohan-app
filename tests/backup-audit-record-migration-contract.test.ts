// @vitest-environment node
/**
 * tests/backup-audit-record-migration-contract.test.ts
 *
 * #1129 migration `<版>_backup_audit_record.sql` (関数 public.record_backup_audit を足すだけ) の文面の契約。
 * 設計 docs/design/cross/17-backup-automation.md §5.2・§15。DB は使わない (実 DB での振る舞いは
 * tests/integration/security/backup-audit-record.test.ts)。action_type と上限は scripts/lib/backup-db.mjs と突き合わせる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AUDIT_DETAILS_MAX_BYTES, BACKUP_AUDIT_ACTION_TYPES } from '../scripts/lib/backup-db.mjs';

const ROOT = path.resolve(__dirname, '..');
const NAME_SUFFIX = '_backup_audit_record.sql';
const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((n) => n.endsWith(NAME_SUFFIX));
const MIGRATION = migrations[0];
const VERSION = MIGRATION?.slice(0, 14);
const ROLLBACK = MIGRATION?.replace(/\.sql$/, '.down.sql');
const SQL = MIGRATION ? fs.readFileSync(path.join(ROOT, 'supabase/migrations', MIGRATION), 'utf8') : '';
const DOWN = ROLLBACK && fs.existsSync(path.join(ROOT, 'supabase/rollbacks', ROLLBACK)) ? fs.readFileSync(path.join(ROOT, 'supabase/rollbacks', ROLLBACK), 'utf8') : '';

/** コメント (-- から行末) を外した本文 */
const code = (text: string) => text.replace(/--[^\n]*/g, '');
const CODE = code(SQL);

describe('backup_audit_record の migration と戻し口', () => {
  it('migration が 1 本・版が 14 桁・戻し口が同じ名前で対', () => {
    expect(migrations).toHaveLength(1);
    expect(VERSION).toMatch(/^\d{14}$/);
    expect(DOWN).not.toBe('');
  });

  it('1・2 行目の見出しと案内・戻し口の 1 行目', () => {
    const lines = SQL.split('\n');
    expect(lines[0]).toBe(`-- migration: ${MIGRATION}`);
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${ROLLBACK}`);
    expect(DOWN.split('\n')[0]).toBe(`-- rollback: ${MIGRATION}`);
  });

  it('SECURITY INVOKER・search_path が空・参照が完全修飾', () => {
    expect(CODE).toContain('SECURITY INVOKER');
    expect(CODE).not.toContain('SECURITY DEFINER');
    expect(CODE).toContain("SET search_path = ''");
    expect(CODE).toContain('INSERT INTO public.admin_audit_logs');
    expect(CODE).toContain('pg_catalog.jsonb_typeof');
    expect(CODE).toContain('pg_catalog.pg_column_size');
  });

  it('受け付ける action_type が BACKUP_AUDIT_ACTION_TYPES と同じ集合', () => {
    const list = /NOT IN \(([^)]*)\)/.exec(CODE)?.[1] ?? '';
    const values = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(values)).toEqual(new Set(BACKUP_AUDIT_ACTION_TYPES));
    expect(values).toHaveLength(BACKUP_AUDIT_ACTION_TYPES.length);
  });

  it('details の上限が AUDIT_DETAILS_MAX_BYTES と同じ', () => {
    expect(/c_details_max_bytes CONSTANT integer := (\d+);/.exec(CODE)?.[1]).toBe(String(AUDIT_DETAILS_MAX_BYTES));
  });

  it('REVOKE が完全形 (PUBLIC, anon, authenticated, service_role) で GRANT が無い', () => {
    expect(CODE).toContain('REVOKE ALL ON FUNCTION public.record_backup_audit(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;');
    expect(CODE).not.toMatch(/\bGRANT\b/);
  });

  it('INSERT の列が actor_id, action_type, target_type, details, severity で actor_id が NULL・target_type が database_backup', () => {
    expect(CODE).toMatch(/INSERT INTO public\.admin_audit_logs \(actor_id, action_type, target_type, details, severity\)\s+VALUES \(NULL, p_action_type, 'database_backup', p_details, v_severity\)/);
  });

  it('既存の表・関数に触れない (CREATE OR REPLACE が 1 つ、ALTER / UPDATE / DELETE / DROP が無い)', () => {
    expect(CODE.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    for (const word of [/\bALTER\b/, /\bUPDATE\b/, /\bDELETE\b/, /\bDROP\b/, /\bCREATE TABLE\b/, /\bCREATE POLICY\b/]) expect(CODE).not.toMatch(word);
  });

  it('down は DROP FUNCTION IF EXISTS だけ', () => {
    const statements = code(DOWN).split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toEqual(['DROP FUNCTION IF EXISTS public.record_backup_audit(text, jsonb)']);
  });
});
