// src/lib/admin/audit-severity-labels.ts
// 運営の画面で、監査ログ (admin_audit_logs) の重要度 (severity) を日本語の表示名で出すための表 (#2112 Z3)。
//
// 以前、運営の利用者の詳細 (src/app/admin/users/[id]/page.tsx) の監査ログ・監査ログの画面 (src/app/super-admin/audit-logs/page.tsx)・
// バックアップの画面 (src/app/super-admin/backups/page.tsx) の一覧は、重要度を英字の内部の値 (info / warn / critical) のまま出していた。
// 値の一覧は src/lib/admin/audit.ts の AdminAuditSeverity (あのファイルはサーバーの部品を import するので、表は型だけを読んでここに置く)。
// キーの型を AdminAuditSeverity にして、値を足すと表示名の漏れが型の誤りになる形にする (USER_LIST_STATUS_LABELS と同じ形)。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

import type { AdminAuditSeverity } from '@/lib/admin/audit';
import { labelOrRaw } from '@/lib/admin/value-labels';

/** 監査ログの重要度の値 (軽いものから。絞り込みの選択肢の並び) */
export const ADMIN_AUDIT_SEVERITIES = ['info', 'warn', 'critical'] as const satisfies readonly AdminAuditSeverity[];

/** 監査ログの重要度の表示名 */
export const ADMIN_AUDIT_SEVERITY_LABELS: Readonly<Record<AdminAuditSeverity, string>> = {
  info: '情報',
  warn: '警告',
  critical: '重大',
};

/** 監査ログの重要度の表示名。表に無い値 (将来の値・壊れた応答) はそのまま */
export function adminAuditSeverityLabel(severity: string): string {
  return labelOrRaw(ADMIN_AUDIT_SEVERITY_LABELS, severity);
}
