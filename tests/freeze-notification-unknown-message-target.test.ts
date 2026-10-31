/**
 * #2026 の続き: 凍結の通知の結果が読めないときの文 (FREEZE_NOTIFICATION_UNKNOWN_MESSAGE) が、
 * 実際に結果を確かめられる画面を指していること。
 *
 * 結果は監査 admin.user.ban の details.notification に残る (POST /api/admin/users/[id]/freeze)。
 * 利用者の詳細 (/admin/users/[id]) の監査ログは super_admin にだけ出し、action_type・severity・日時だけで details を描かないので、
 * そこを指すと admin はどこでも確かめられず、super_admin もその画面では読めない。
 * details を描くのは super_admin の監査ログ閲覧 (/super-admin/audit-logs) の行を展開したとき。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FREEZE_NOTIFICATION_AUDIT_ACTION_TYPE,
  FREEZE_NOTIFICATION_AUDIT_LOGS_PATH,
  FREEZE_NOTIFICATION_UNKNOWN_MESSAGE,
  describeFreezeNotificationOutcome,
} from '@/lib/admin/freeze-notification-status';
import { SUPER_ADMIN_SCREEN_LABEL } from '@/lib/admin/operator-role-labels';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 行コメントとブロックコメントを除いた本文 (コメントの中の語に一致させないため) */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FREEZE_ROUTE = 'src/app/api/admin/users/[id]/freeze/route.ts';
const USER_DETAIL_PAGE = 'src/app/admin/users/[id]/page.tsx';
const SUPER_ADMIN_LAYOUT = 'src/app/super-admin/layout.tsx';

describe('凍結の通知の結果が読めないときの文は、結果を確かめられる画面を指す', () => {
  it('読めないとき (null) の文は FREEZE_NOTIFICATION_UNKNOWN_MESSAGE で、監査ログ閲覧の道と監査の種別を含む', () => {
    expect(describeFreezeNotificationOutcome(null)).toBe(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE);
    expect(FREEZE_NOTIFICATION_AUDIT_LOGS_PATH).toBe('/super-admin/audit-logs');
    expect(FREEZE_NOTIFICATION_AUDIT_ACTION_TYPE).toBe('admin.user.ban');
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).toBe(
      '通知メールの結果を確認できませんでした (運営最上位の画面の監査ログ閲覧 /super-admin/audit-logs で admin.user.ban の行を展開し、details の notification を確認してください)',
    );
  });

  it('利用者の詳細の監査ログは details を描かないので、文はそこを指さない', () => {
    const detailPage = withoutComments(read(USER_DETAIL_PAGE));
    expect(detailPage).not.toMatch(/log\.details/);
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).not.toContain('利用者の詳細');
  });

  it('文が指す画面は実在し、super_admin だけが開け、行の details を描く', () => {
    const pageFile = path.join('src/app', FREEZE_NOTIFICATION_AUDIT_LOGS_PATH, 'page.tsx');
    expect(fs.existsSync(path.join(ROOT, pageFile))).toBe(true);
    expect(withoutComments(read(pageFile))).toContain('JSON.stringify(log.details, null, 2)');
    expect(withoutComments(read(SUPER_ADMIN_LAYOUT))).toMatch(/requireRoleForPage\(\['super_admin'\]/);
    // 開ける人は、運営の画面の呼び名 (運営最上位の画面。src/lib/admin/operator-role-labels.ts) で書く (#2134 U1)
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).toContain(SUPER_ADMIN_SCREEN_LABEL);
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).not.toMatch(/super_admin|スーパー管理者/);
  });

  it('文が名指す監査の種別は、凍結の route が通知の結果 (notification) を残す種別と同じ', () => {
    const route = withoutComments(read(FREEZE_ROUTE));
    const banAudit = route.match(/actionType: 'admin\.user\.ban',[\s\S]*?\n {2}\}\);/);
    expect(banAudit).not.toBeNull();
    expect(banAudit?.[0]).toMatch(/\n {6}notification: \{/);
    expect(route).toContain(`actionType: '${FREEZE_NOTIFICATION_AUDIT_ACTION_TYPE}'`);
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).toContain(FREEZE_NOTIFICATION_AUDIT_ACTION_TYPE);
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).toContain(FREEZE_NOTIFICATION_AUDIT_LOGS_PATH);
  });
});
