import { test, expect } from '../fixtures/fresh-user';

test.describe('family 代表者譲渡', () => {
  test('TODO: 代表者譲渡 2 step (happy path)', async () => {
    // 設計書 02-flow-spec.md §10:
    // org owner 譲渡と同パターン (propose / accept の 2 step)
    // Step 1:
    //   1. representative=Mom が /family/settings/representative-transfer
    //      → Dad を新代表者に選択 → [提案する]
    //   2. POST /api/family/representative-transfer/propose
    //      → rpc('propose_family_representative_transfer')
    //      → proposal_id 返却
    //   3. Dad に通知メール送信
    // Step 2:
    //   4. Dad が /family/transfer-accept/{proposal_id} にアクセス
    //   5. [承諾] → POST /api/family/representative-transfer/{id}/accept
    //      → rpc('accept_family_representative_transfer')
    //   6. Mom.member_role = 'adult', Dad.member_role = 'representative'
    //   7. family_groups.representative_id = dad_id
    //   8. 監査ログ記録
    test.skip(true, 'P7 で実装');
  });

  test('TODO: 代表者譲渡 — child への譲渡は拒否される', async () => {
    // 設計書 02-flow-spec.md §10:
    // 代表は他の adult にしか譲渡できない (child は不可)
    // 1. Mom が child を新代表者として指定しようとする
    // 2. server: エラー応答 (child は representative になれない)
    // 3. UI: エラーメッセージ表示
    test.skip(true, 'P7 で実装');
  });

  test('TODO: 代表者譲渡 解除 (提案キャンセル)', async () => {
    // 1. Mom が代表者譲渡を提案した後、提案を取り消す
    // 2. DELETE or POST /api/family/representative-transfer/{id}/cancel
    //    → proposal を無効化
    // 3. Dad が /family/transfer-accept/{proposal_id} にアクセスしても
    //    「この譲渡提案は無効です」と表示される
    test.skip(true, 'P7 で実装');
  });
});
