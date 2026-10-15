// tests/helpers/design-doc-pending-notes-1598.ts
// #1598 の続きで消した画面・ファイルを、設計書がまだ注記なしで名指ししている行のうち、同じ行に「削除した」と注記すれば済むもの。
// 設計の判断は変えない (行が指すファイルが消えたことを書くだけ)。設計書に注記を足す差分と同じコミットで、ここから消す。
// 突き合わせの決まり (両方向に厳しい・1 つの設計書はこの一覧か設計の改定を待つ一覧のどちらか一方にだけ載せる) は
// tests/helpers/design-doc-pending-1598.ts。
import type { PendingEntry } from './design-doc-pending-1598';

export const PENDING_NOTE_MENTIONS: readonly PendingEntry[] = [
  // 共通の部品の拡張の表 (BadgesPage の Mobile 側)
  { file: 'docs/design/cross/03-design-system.md', kind: 'screen', target: 'badges/index.tsx', count: 1 },
  // 同意のゲートの外の経路 (アプリが Supabase を直接読むファイル)・招待の route を呼ぶ画面・走査のテストの表
  { file: 'docs/design/cross/13a-legal-consent-api-server.md', kind: 'screen', target: '(org)/org/invites.tsx', count: 1 },
  { file: 'docs/design/cross/13a-legal-consent-api-server.md', kind: 'file', target: 'apps/mobile/src/lib/recipeCollections.ts', count: 1 },
  { file: 'docs/design/cross/13a-legal-consent-api-server.md', kind: 'file', target: 'tests/mobile-super-admin-api-contract.test.ts', count: 1 },
  // 最終ログインの列を読む運営の画面 (§3・§21.4)・反応するテストの表 (N-30)・Q-22
  { file: 'docs/design/cross/16-auth-history-sessions.md', kind: 'screen', target: '(super-admin)/super-admin/admins.tsx', count: 1 },
  { file: 'docs/design/cross/16-auth-history-sessions.md', kind: 'screen', target: '(support)/support/users.tsx', count: 3 },
  { file: 'docs/design/cross/16-auth-history-sessions.md', kind: 'screen', target: '(support)/support/users/[id].tsx', count: 2 },
  {
    file: 'docs/design/cross/16-auth-history-sessions.md',
    kind: 'file',
    target: 'apps/mobile/__tests__/app/profile-name-placeholder-lists.test.tsx',
    count: 1,
  },
  { file: 'docs/design/cross/16-auth-history-sessions.md', kind: 'file', target: 'tests/mobile-super-admin-api-contract.test.ts', count: 1 },
  // ハンズオンツアーの BadgesPage (家族の UI の仕様・未決事項・モバイルの構成)
  { file: 'docs/design/family/03-ui-spec.md', kind: 'screen', target: 'badges/index.tsx', count: 1 },
  { file: 'docs/design/family/09-onboarding-handson-tour/99-open-questions.md', kind: 'screen', target: 'badges/index.tsx', count: 2 },
  { file: 'docs/design/mobile/01-architecture.md', kind: 'screen', target: 'badges/index.tsx', count: 1 },
  // 食事の写真の表示に使う部品
  { file: 'docs/design/mobile/04-storage-camera.md', kind: 'file', target: 'apps/mobile/src/components/photo/SignedPhotoImage.tsx', count: 1 },
];
