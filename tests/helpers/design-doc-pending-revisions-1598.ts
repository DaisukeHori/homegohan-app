// tests/helpers/design-doc-pending-revisions-1598.ts
// #1598 の続きで消した画面・ファイルを、設計書がまだ名指ししている行のうち、注記では直らないもの (設計の判断を変えるもの)。
//   - docs/design/cross/12-operator-mfa.md (運営の MFA): 段 D はネイティブの運営の区画 ((super-admin)・(support)) の _layout に
//     確認を入れ、走査の定数 (コードの文字列) もその区画を指す。区画を消したので、段 D の範囲と走査の定数を設計で決め直す
//     (コードの文字列は、同じ行に注記しても赤のまま。tests/design-doc-removed-mobile-screens.test.ts の 4)。
//   - docs/design/mobile/06-push-send.md (サーバーからの Push の送信): 献立の通知の行き先を、消した週の画面 ('/menus/weekly') にし、
//     「行き先が resolveNotificationHref で同じ値に解決される」契約 (§10) を求める。行き先の値を設計で決め直す。
// 設計の改定と同じコミットで、ここから消す。突き合わせの決まりは tests/helpers/design-doc-pending-1598.ts。
import type { PendingEntry } from './design-doc-pending-1598';

export const PENDING_REVISION_MENTIONS: readonly PendingEntry[] = [
  { file: 'docs/design/cross/12-operator-mfa.md', kind: 'screen', target: '(super-admin)/_layout.tsx', count: 4 },
  { file: 'docs/design/cross/12-operator-mfa.md', kind: 'screen', target: '(super-admin)/super-admin/index.tsx', count: 1 },
  { file: 'docs/design/cross/12-operator-mfa.md', kind: 'screen', target: '(support)/_layout.tsx', count: 4 },
  { file: 'docs/design/cross/12-operator-mfa.md', kind: 'file', target: 'apps/mobile/__tests__/org/org-admin-gate.test.tsx', count: 1 },
  { file: 'docs/design/cross/12-operator-mfa.md', kind: 'file', target: 'apps/mobile/src/lib/super-admin-flags.ts', count: 1 },
  { file: 'docs/design/cross/12-operator-mfa.md', kind: 'file', target: 'tests/mobile-super-admin-api-contract.test.ts', count: 1 },
  { file: 'docs/design/cross/12-operator-mfa.md', kind: 'codeLiteral', target: '(super-admin)', count: 1 },
  { file: 'docs/design/cross/12-operator-mfa.md', kind: 'codeLiteral', target: '(support)', count: 1 },
  { file: 'docs/design/mobile/06-push-send.md', kind: 'screen', target: 'health/settings.tsx', count: 1 },
  { file: 'docs/design/mobile/06-push-send.md', kind: 'screen', target: 'menus/weekly/index.tsx', count: 1 },
  // 通知の行き先の宣言 (path の文字列・data.path の代入・path に使う定数の 3 つ)
  { file: 'docs/design/mobile/06-push-send.md', kind: 'pushPath', target: '/menus/weekly', count: 3 },
];
