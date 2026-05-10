import { test, expect } from '../fixtures/fresh-user';

test.describe('family 作成 + 招待 + 承諾 (β-1, β-2)', () => {
  test('TODO: β-1 (family グループ作成 happy path)', async () => {
    // 設計書 02-flow-spec.md §6:
    // 1. Mom が /family/setup → [家族グループを作る] → 名前「山田家」を入力
    // 2. POST /api/family/groups
    //    body: { name: '山田家', plan_key: 'free' }
    // 3. rpc('create_family_group')
    //    → 整合性: caller が既に他 family にいたら ALREADY_IN_FAMILY エラー
    //    → family_groups INSERT, family_members INSERT (representative)
    //    → user_profiles.family_id = new
    //    → 監査ログ
    // 4. 201 { data: { family_group } }
    // 5. family ダッシュボードへ遷移
    test.skip(true, 'P7 で実装');
  });

  test('TODO: β-2 (family 招待発行 → Dad 承諾 + 共有設定)', async () => {
    // 設計書 02-flow-spec.md §7:
    // 1. Mom が family 管理画面 → [Dad を招待] → email 入力
    // 2. POST /api/family/invites
    //    → rpc('create_family_invite') → template C でメール送信
    // 3. Dad が /invite/family/{token} にアクセス
    // 4. 承諾モーダル表示 (閲覧権限選択):
    //    - 食事記録: ☑ ON
    //    - 健康記録: ☐ OFF
    //    - 週間献立: ☑ ON
    // 5. [承諾する] → POST /api/family/invites/{token}/accept
    //    body: { share_meals: true, share_health: false, share_menu: true }
    //    → rpc('accept_family_invite') → family_members INSERT
    // 6. user_profiles.family_id 設定
    // 7. 監査ログ記録
    test.skip(true, 'P7 で実装');
  });

  test('TODO: β-2 (承諾後の共有設定が DB に正しく保存される)', async () => {
    // family_members.share_meals / share_health / share_menu の値が
    // 承諾モーダルで選択した値と一致することを確認
    test.skip(true, 'P7 で実装');
  });
});
