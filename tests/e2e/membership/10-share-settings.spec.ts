import { test, expect } from '../fixtures/fresh-user';

test.describe('共有設定 (share settings)', () => {
  test('TODO: share_meals OFF で家族から見えなくなる', async () => {
    // 設計書 02-flow-spec.md §13:
    // 1. Dad が /settings/membership/share → [食事記録 OFF] toggle
    // 2. PATCH /api/family/members/me/share
    //    body: { share_meals: false }
    // 3. server: caller の family_members 行を UPDATE
    // 4. 即時 RLS が反映
    //    → Mom が Dad の /family/members/{dad_id}/meals を見ると空になる
    // 5. 既にペーストされた Mom 自身の meal copies は影響なし (各自の所有物)
    test.skip(true, 'P7 で実装');
  });

  test('TODO: share_meals ON で復活', async () => {
    // 設計書 02-flow-spec.md §13:
    // share_meals を OFF にした後、再度 ON にする
    // 1. Dad が [食事記録 ON] toggle
    // 2. PATCH /api/family/members/me/share
    //    body: { share_meals: true }
    // 3. Mom から Dad の食事記録が再び見えるようになる
    test.skip(true, 'P7 で実装');
  });

  test('TODO: share_health の独立 toggle', async () => {
    // share_health を OFF にしても share_meals / share_menu には影響しない
    // 1. Dad が [健康記録 OFF] → PATCH /api/family/members/me/share
    //    body: { share_health: false }
    // 2. Mom から Dad の健康記録は見えなくなるが
    //    食事記録・週間献立は引き続き見える
    test.skip(true, 'P7 で実装');
  });

  test('TODO: share_menu の独立 toggle', async () => {
    // share_menu を OFF にしても share_meals / share_health には影響しない
    // 1. Dad が [週間献立 OFF] → PATCH /api/family/members/me/share
    //    body: { share_menu: false }
    // 2. Mom から Dad の週間献立は見えなくなるが
    //    食事記録・健康記録は引き続き見える
    test.skip(true, 'P7 で実装');
  });
});
