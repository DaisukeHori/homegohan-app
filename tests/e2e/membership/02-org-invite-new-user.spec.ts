import { test, expect } from '../fixtures/fresh-user';

test.describe('org 招待 — 新規ユーザ (α-4)', () => {
  test('TODO: α-4 (新規 signup → 即メンバ化 happy path)', async () => {
    // 設計書 02-flow-spec.md §2:
    // 1. admin が POST /api/org/invites で招待発行 (template B)
    // 2. Alice (未登録) がメールの /invite/{token} をクリック
    // 3. server: get_invite_details → pending かつ未認証
    //    → 「アカウントを作成して参加」フォームを表示 (email pre-fill, disabled)
    // 4. Alice が password を入力して [作成して参加] をクリック
    // 5. POST /api/auth/signup-and-accept-invite
    //    body: { token, password }
    //    → supabase.auth.signUp → signInWithPassword → rpc('accept_org_invite')
    // 6. 200 { data: { organization_id, org_role, user_id } }
    // 7. onboarding 1問目から開始
    test.skip(true, 'P7 で実装');
  });

  test('TODO: α-4 (新規 signup 後のメンバシップ確認)', async () => {
    // signup-and-accept-invite 後に user_profiles.organization_id が設定されていること
    // 監査ログに invite_accepted が記録されていること
    test.skip(true, 'P7 で実装');
  });
});
