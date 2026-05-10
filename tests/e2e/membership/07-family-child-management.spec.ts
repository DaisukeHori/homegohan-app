import { test, expect } from '../fixtures/fresh-user';

test.describe('family 子供メンバ管理 (β-5, β-6)', () => {
  test('TODO: β-5 (子供追加 — auth account なし)', async () => {
    // 設計書 02-flow-spec.md §8:
    // 1. adult が /family/members → [子供を追加]
    // 2. 名前/年齢/性別/アレルギー を入力
    // 3. POST /api/family/members/child
    //    body: { display_name, child_profile: { age, gender, allergies, ... } }
    // 4. rpc('add_family_child')
    //    → family_members INSERT (user_id=NULL, role='child', child_profile)
    //    → 整合性: family.member_limit に対する human count 検証
    //    → 監査ログ
    // 5. メンバ一覧に子供が表示される (auth account なし)
    test.skip(true, 'P7 で実装');
  });

  test('TODO: β-6 (子供 promote — auth account 紐付け)', async () => {
    // 設計書 02-flow-spec.md §9:
    // 1. adult が /family/members/{id} → [アカウントを発行する]
    //    (子供本人の email or 親が代理 email 指定)
    // 2. 子供が別途 signup → 親に通知 → 親が「同一人物」確認
    // 3. POST /api/family/members/{id}/promote
    //    body: { user_id }
    // 4. rpc('promote_child_to_user')
    //    → family_members.user_id = X, child_profile = NULL
    //    → user_profiles.family_id 設定
    //    → 過去 meals/health の child_profile_id 参照を user_id に書き換え
    //    → 監査ログ
    test.skip(true, 'P7 で実装');
  });

  test('TODO: 子供削除 (family から外す)', async () => {
    // 1. adult が /family/members/{childId} → [家族から外す]
    // 2. POST /api/family/members/{user_id}/remove
    //    → rpc('remove_family_member', { p_family_id, p_user_id })
    //    (child の場合 p_user_id は NULL → member_id で指定する想定、要仕様確認)
    // 3. family_members.status = 'removed'
    // 4. meals 等は保持 (削除しない)
    // 5. メンバ一覧から子供が消える
    test.skip(true, 'P7 で実装');
  });
});
