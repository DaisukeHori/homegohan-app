import { test, expect } from '../fixtures/fresh-user';

test.describe('meal paste (家族へのペースト)', () => {
  test('TODO: ペースト実行 happy path', async () => {
    // 設計書 02-flow-spec.md §12:
    // 1. Mom が /menus/weekly → 既存夕食レコードを長押し → action sheet
    //    → [家族にもペースト]
    // 2. モーダル: メンバチェックボックス [☑ 父 ☐ 子A ☑ 子B]
    // 3. [選択してペースト] → POST /api/meals/paste
    //    body: { source_meal_id, target_user_ids: [father_id, childB_id] }
    // 4. server: 認可確認 (source_meal.user_id == auth.uid())
    //    → 整合性: 全 target が同 family の active member
    //    → rpc('paste_meal_to_family')
    //    → 各 target に新 meal レコード INSERT (paste_group_id 共通)
    //    → source meal にも paste_group_id を後付け
    //    → 監査ログ paste_executed
    // 5. 200 { data: { paste_group_id, inserted_count: 2 } }
    test.skip(true, 'P7 で実装');
  });

  test('TODO: paste_group 表示 (「3人で共有」バッジ)', async () => {
    // ペースト後:
    // 各メンバの献立表に同じ夕食レコードが表示される
    // paste_group_id で「🔗 3人で共有」または同等の表示がある
    // Dad/子B の献立表にも同じ食事が表示される
    test.skip(true, 'P7 で実装');
  });

  test('TODO: 編集独立性 (ペースト後に各自が個別編集できる)', async () => {
    // ペーストで作られた meal は各自が独立して編集できる
    // Dad が自分のコピーを編集しても Mom の元レコードに影響しない
    // 同一 paste_group_id だが food_items は独立
    test.skip(true, 'P7 で実装');
  });

  test('TODO: 「全員に反映」bulk update', async () => {
    // paste_group の食事を一括更新する機能 (要設計確認)
    // 1. Mom が paste_group の「全員に反映」を選択
    // 2. 全メンバのコピーが同じ内容に更新される
    test.skip(true, 'P7 で実装');
  });
});
