import { test, expect } from '../fixtures/fresh-user';

test.describe('org 招待 — エッジケース', () => {
  test('TODO: α-3 (email 不一致)', async () => {
    // 設計書 02-flow-spec.md §1.2:
    // 1. admin が alice@a.com 宛に招待発行
    // 2. bob@b.com でログインした状態で /invite/{token} にアクセス
    // 3. server: pending かつログイン中 かつ email 不一致
    //    → 「signOut してから再 click」案内を表示
    // 4. [承諾する] ボタンは表示されない
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-5 (既所属 org)', async () => {
    // 設計書 02-flow-spec.md §1.3:
    // 1. Alice はすでに orgA に所属している状態
    // 2. orgB の admin が Alice に招待発行
    // 3. Alice が /invite/{token} → [承諾する]
    // 4. server: rpc('accept_org_invite') → ALREADY_IN_ORG エラー
    // 5. UI: 「あなたは現在 orgA に所属しています。orgB に移動しますか?」
    // 6a. 「移動する」→ POST /api/org/leave → 再度 accept
    // 6b. 「拒否」→ POST /api/org/invites/{token}/reject
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-6 (別 org owner)', async () => {
    // 設計書 02-flow-spec.md §1.3:
    // 1. Alice は orgA の owner
    // 2. orgB の admin が Alice に招待発行
    // 3. Alice が [承諾する] → IS_ORG_OWNER エラー
    // 4. UI: 「あなたは orgA の Owner です。先に Owner を譲渡してください」
    //    → /org/owner-transfer へ誘導
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-7 (expired token)', async () => {
    // 設計書 02-flow-spec.md §1.2:
    // 1. 期限切れの token で /invite/{token} にアクセス
    // 2. server: get_invite_details → expired
    //    → 表示「期限切れ」メッセージ
    // 3. 再招待 CTA を表示
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-8 (invalid token)', async () => {
    // 設計書 02-flow-spec.md §1.2:
    // 1. 存在しない token で /invite/{token} にアクセス
    // 2. server: get_invite_details → 404 / null 返却
    //    → エラーページ表示 (招待が見つかりません)
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-9 (承諾済み token の再 click)', async () => {
    // 設計書 02-flow-spec.md §1.2:
    // 1. Alice が一度承諾した token で再度 /invite/{token} にアクセス
    // 2. server: get_invite_details → accepted
    //    → 表示「すでに承諾済」+ /home へ CTA
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-10 (招待拒否)', async () => {
    // 設計書 02-flow-spec.md §3:
    // 1. Alice が /invite/{token} → [拒否]
    // 2. POST /api/org/invites/{token}/reject
    //    → rpc('reject_org_invite') → status=rejected
    // 3. UI: 「招待を拒否しました」メッセージ
    // 4. 監査ログに invite_rejected 記録
    test.skip(true, 'P7 で実装');
  });
});
