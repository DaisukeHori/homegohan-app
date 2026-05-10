import { test, expect } from '../fixtures/fresh-user';

test.describe('family 招待 — エッジケース', () => {
  test('TODO: β-3 (別 family の代表者)', async () => {
    // 設計書 02-flow-spec.md §6, §7:
    // 1. Bob はすでに familyB の representative
    // 2. familyA の Mom が Bob に招待発行
    // 3. Bob が /invite/family/{token} → [承諾する]
    // 4. server: rpc('accept_family_invite') → ALREADY_IN_FAMILY エラー
    //    (または IS_FAMILY_REPRESENTATIVE エラー)
    // 5. UI: 既に別の家族グループに所属している旨のエラーメッセージ
    test.skip(true, 'P7 で実装');
  });

  test('TODO: β-4 (別 family の一般メンバ)', async () => {
    // 設計書 02-flow-spec.md §7:
    // 1. Bob はすでに familyB の adult member
    // 2. familyA の Mom が Bob に招待発行
    // 3. Bob が /invite/family/{token} → [承諾する]
    // 4. server: ALREADY_IN_FAMILY エラー
    // 5. UI: エラーメッセージ表示
    //    (現在の family から脱退してから参加するよう案内)
    test.skip(true, 'P7 で実装');
  });

  test('TODO: β-8 (family 人数上限)', async () => {
    // 設計書 02-flow-spec.md §8:
    // 1. family が member_limit に達している状態で
    //    representative が新しいメンバを招待しようとする
    // 2. POST /api/family/invites → エラー応答
    //    (または add_family_child → 人数上限エラー)
    // 3. UI: 人数上限に達した旨のエラーメッセージ
    test.skip(true, 'P7 で実装');
  });
});
