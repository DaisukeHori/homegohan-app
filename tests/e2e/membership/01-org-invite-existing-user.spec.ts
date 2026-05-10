import { test, expect } from '../fixtures/fresh-user';

test.describe('org 招待 — 既存ユーザ', () => {
  test('TODO: α-1 (既存ユーザ承諾 happy path)', async () => {
    // 設計書 02-flow-spec.md §1.2:
    // 1. admin が POST /api/org/invites で招待発行
    //    body: { organization_id, email: alice@a.com, role: 'member', custom_message? }
    // 2. 既存ユーザ Alice にメール送信される (template A)
    // 3. /invite/{token} click → ログイン → 承諾画面 (organization 詳細表示)
    // 4. [承諾する] → POST /api/org/invites/{token}/accept
    //    → rpc('accept_org_invite') → user_profiles.organization_id 設定
    // 5. 監査ログに invite_accepted 記録
    // 6. /org/dashboard へ redirect
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-2 (既ログイン中の承諾)', async () => {
    // 設計書 02-flow-spec.md §1.2:
    // 1. admin が招待発行
    // 2. Alice がすでにログイン状態で /invite/{token} にアクセス
    // 3. server: pending かつログイン中 かつ email 一致 → 承諾画面 を直接表示
    //    (「ログイン or signup」画面を経由しない)
    // 4. [承諾する] → user_profiles 更新 → /org/dashboard へ redirect
    test.skip(true, 'P7 で実装');
  });
});
