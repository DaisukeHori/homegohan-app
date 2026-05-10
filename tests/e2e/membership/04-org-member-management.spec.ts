import { test, expect } from '../fixtures/fresh-user';

test.describe('org メンバ管理', () => {
  test('TODO: α-11 (メンバ除名)', async () => {
    // 設計書 02-flow-spec.md §4:
    // 1. admin が /org/members/{id} → [このメンバを外す] をクリック
    // 2. POST /api/org/members/{user_id}/remove
    //    → rpc('remove_org_member', { p_organization_id, p_user_id })
    // 3. 整合性: target が owner なら拒否
    // 4. 整合性: admin が admin を除名しようとすると拒否 (owner のみ可)
    // 5. user_profiles.organization_id = NULL, org_role = NULL
    // 6. 監査ログ記録
    // 7. メンバ一覧から該当ユーザーが消えること
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-12 (自発脱退)', async () => {
    // 設計書 02-flow-spec.md §4:
    // 1. member=Alice が /settings/membership → [脱退する]
    // 2. POST /api/org/leave
    //    → rpc('leave_org')
    // 3. 整合性: caller が owner なら IS_ORG_OWNER エラー (先に譲渡を要求)
    // 4. user_profiles 更新 (organization_id=NULL, org_role=NULL)
    // 5. 監査ログ記録
    // 6. /home へ redirect (or 脱退完了画面)
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-13 (Owner 譲渡 2 step)', async () => {
    // 設計書 02-flow-spec.md §5:
    // Step 1:
    //   1. owner=Alice が /org/settings/owner-transfer → Bob を新 owner に選択
    //   2. POST /api/org/owner-transfer/propose
    //      → rpc('propose_org_owner_transfer') → proposal_id
    //   3. Bob に通知メール送信
    // Step 2:
    //   4. Bob が /org/transfer-accept/{proposal_id} にアクセス
    //   5. [承諾] → POST /api/org/owner-transfer/{proposal_id}/accept
    //      → rpc('accept_org_owner_transfer')
    //   6. Alice.org_role = 'admin', Bob.org_role = 'owner'
    //   7. 監査ログ owner_transferred
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-14 (seat 上限)', async () => {
    // 設計書 02-flow-spec.md §1.2:
    // 1. org の used_seats が seat_limit に達している状態で
    //    admin が POST /api/org/invites を試みる
    // 2. server: SELECT seat_limit/used_seats from org_license_pools
    //    → seats full → 400 SEAT_LIMIT_EXCEEDED
    // 3. UI にエラーメッセージ表示
    test.skip(true, 'P7 で実装');
  });
});
