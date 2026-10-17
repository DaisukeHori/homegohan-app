// @vitest-environment node
/**
 * #1538 運営が隠したコンテンツを戻す操作 (段 A) の契約テスト (DB を使わない)
 * 設計: docs/design/operator/13-hidden-content-restore.md §13.1
 *
 * 確かめること (ソースの文字列と定数の突き合わせ):
 *   CT-1 保管期間の写しが Edge の正本と同じ
 *   CT-2 戻せる期間 = 保管期間 - 1 日で、その 1 日は完全削除の 1 回の実行の上限より長い
 *   CT-4 戻す route の requireRole のロールは、隠す route と同じ
 *   CT-5 戻す route は recordAdminAudit に request を渡し、監査ログへ直接 INSERT しない
 *   CT-6 戻す部品が hidden_at を書く UPDATE は 1 つで、3 列を null にするだけ
 *   CT-7 戻す部品と route は環境変数を読まない
 *   CT-8 写真とメモの比べ方は隠す側と同じ式
 *   CT-3 画面の理由の長さの写しが schemas と同じ (段 B)
 * CT-7 は段 B で、対象に画面の部品 (ModerationRestoreForm.tsx) を足した。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HIDDEN_CONTENT_PURGE_MAX_DURATION_MS,
  HIDDEN_CONTENT_RETENTION_DAYS as EDGE_RETENTION_DAYS,
} from '../supabase/functions/_shared/hidden-content-purge';
import {
  HIDDEN_CONTENT_RESTORE_MARGIN_DAYS,
  HIDDEN_CONTENT_RESTORE_WINDOW_DAYS,
  HIDDEN_CONTENT_RETENTION_DAYS,
} from '@/lib/admin/hidden-content-restore';
import {
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_NOTE_MIN_LENGTH,
  MODERATION_RESTORE_AUDIT_ACTION,
} from '@/lib/admin/moderation-schemas';

const ROOT = path.resolve(__dirname, '..');
const LIB_FILE = 'src/lib/admin/hidden-content-restore.ts';
const RESTORE_ROUTE_FILE = 'src/app/api/admin/moderation/[type]/[id]/restore/route.ts';
const RESTORE_FORM_FILE = 'src/components/operator/moderation/ModerationRestoreForm.tsx';
const HIDE_ROUTE_FILE = 'src/app/api/admin/moderation/[type]/[id]/route.ts';
const BACKEND_FILE = 'src/lib/admin/moderation-backend.ts';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** ブロックコメントと行コメントを除いたソース (コメントの中の語に反応しないため) */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

/** `requireRole([...])` の配列のロール (文字列リテラル) を、出てくる順に */
function rolesOfRequireRole(source: string): string[] {
  const match = stripComments(source).match(/requireRole\(\s*\[([^\]]*)\]/);
  if (!match) throw new Error('requireRole([...]) が見つからない');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** 関数 `name` の本体にある最初の `return <式>;` の式 (空白を詰める) */
function returnExpressionOf(source: string, name: string): string {
  const code = stripComments(source);
  const start = code.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} が見つからない`);
  const rest = code.slice(start);
  const match = rest.match(/return\s+([^;]+);/);
  if (!match) throw new Error(`function ${name} に return が無い`);
  return match[1].replace(/\s+/g, '');
}

describe('#1538 隠したコンテンツを戻す操作の契約 (段 A・段 B)', () => {
  it('CT-1: src の写し HIDDEN_CONTENT_RETENTION_DAYS は、Edge の正本 (supabase/functions/_shared/hidden-content-purge.ts) と同じ 90', () => {
    expect(HIDDEN_CONTENT_RETENTION_DAYS).toBe(EDGE_RETENTION_DAYS);
    expect(HIDDEN_CONTENT_RETENTION_DAYS).toBe(90);
  });

  it('CT-2: 戻せる期間 = 保管期間 − 1 日 (89) で、1 日 (ms) は完全削除の 1 回の実行の上限 HIDDEN_CONTENT_PURGE_MAX_DURATION_MS より長い', () => {
    expect(HIDDEN_CONTENT_RESTORE_MARGIN_DAYS).toBe(1);
    expect(HIDDEN_CONTENT_RESTORE_WINDOW_DAYS).toBe(EDGE_RETENTION_DAYS - HIDDEN_CONTENT_RESTORE_MARGIN_DAYS);
    expect(HIDDEN_CONTENT_RESTORE_WINDOW_DAYS).toBe(89);
    expect(HIDDEN_CONTENT_RESTORE_MARGIN_DAYS * MS_PER_DAY).toBeGreaterThan(HIDDEN_CONTENT_PURGE_MAX_DURATION_MS);
  });

  it('CT-3: 画面の NOTE_MIN_LENGTH / NOTE_MAX_LENGTH (ModerationRestoreForm.tsx のソース) は schemas の MODERATION_NOTE_MIN_LENGTH / MODERATION_NOTE_MAX_LENGTH と同じ', () => {
    const code = stripComments(read(RESTORE_FORM_FILE));
    const min = code.match(/const NOTE_MIN_LENGTH\s*=\s*(\d+);/);
    const max = code.match(/const NOTE_MAX_LENGTH\s*=\s*(\d+);/);
    expect(min, 'NOTE_MIN_LENGTH の定義が無い').not.toBeNull();
    expect(max, 'NOTE_MAX_LENGTH の定義が無い').not.toBeNull();
    expect(Number(min?.[1])).toBe(MODERATION_NOTE_MIN_LENGTH);
    expect(Number(max?.[1])).toBe(MODERATION_NOTE_MAX_LENGTH);
    // client に schemas (zod) を読み込まない
    expect(code).not.toContain('moderation-schemas');
  });

  it('CT-4: restore の route の requireRole のロールは、隠す route (POST / PUT /api/admin/moderation/[type]/[id]) と同じ 3 つ', () => {
    const restoreRoles = rolesOfRequireRole(read(RESTORE_ROUTE_FILE));
    expect(restoreRoles).toEqual(['admin', 'super_admin', 'content_moderator']);
    expect(restoreRoles).toEqual(rolesOfRequireRole(read(HIDE_ROUTE_FILE)));
    // 既定の assurance (AAL2) のまま。session に緩めない
    expect(stripComments(read(RESTORE_ROUTE_FILE))).not.toMatch(/assurance\s*:/);
  });

  it('CT-5: restore の route は recordAdminAudit に request を渡し、admin_audit_logs へ直接 INSERT しない (actionType は MODERATION_RESTORE_AUDIT_ACTION)', () => {
    const code = stripComments(read(RESTORE_ROUTE_FILE));
    const call = code.match(/recordAdminAudit\(\{([\s\S]*?)\}\);/);
    expect(call, 'recordAdminAudit({ ... }) の呼び出しが無い').not.toBeNull();
    expect(call?.[1]).toMatch(/\brequest,/);
    expect(call?.[1]).toMatch(/actionType:\s*MODERATION_RESTORE_AUDIT_ACTION\b/);
    expect(code).not.toContain("'admin_audit_logs'");
    expect(MODERATION_RESTORE_AUDIT_ACTION).toBe('admin.moderation.restore');
  });

  it('CT-6: hidden-content-restore.ts は hidden_at を書く UPDATE を 1 つだけ持ち、hidden_at / hidden_by / hidden_reason を null にする (別の値を書かない)', () => {
    const code = stripComments(read(LIB_FILE));
    const writes = [...code.matchAll(/\.update\(\{([^}]*)\}\)/g)].filter((m) => m[1].includes('hidden_at'));
    expect(writes).toHaveLength(1);
    const body = writes[0][1].replace(/\s+/g, '');
    expect(body).toBe('hidden_at:null,hidden_by:null,hidden_reason:null');
  });

  it('CT-7: hidden-content-restore.ts と restore の route と画面の部品 (ModerationRestoreForm.tsx) は process.env を読まない (環境変数を足さない: R-17)', () => {
    for (const file of [LIB_FILE, RESTORE_ROUTE_FILE, RESTORE_FORM_FILE]) {
      expect(stripComments(read(file)), file).not.toContain('process.env');
    }
  });

  it('CT-8: hidden-content-restore.ts の hasSameMealContent の式は、moderation-backend.ts の isSameMealContent の式 (a.photo_url === b.photo_url && a.memo === b.memo) と同じ', () => {
    const restoreExpression = returnExpressionOf(read(LIB_FILE), 'hasSameMealContent');
    const hideExpression = returnExpressionOf(read(BACKEND_FILE), 'isSameMealContent');
    expect(restoreExpression).toBe('a.photo_url===b.photo_url&&a.memo===b.memo');
    expect(restoreExpression).toBe(hideExpression);
  });
});
