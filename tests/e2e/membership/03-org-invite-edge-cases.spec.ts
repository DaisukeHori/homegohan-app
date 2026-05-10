/**
 * tests/e2e/membership/03-org-invite-edge-cases.spec.ts
 *
 * spec 03: org 招待 — edge cases
 * 設計書 02-flow-spec.md §1.2, §1.3, §3 (α-3, α-5〜α-10) を E2E で検証する。
 */

import { test, expect } from '../fixtures/fresh-org';
import { createFreshUser, cleanupFreshUser, injectSession } from '../fixtures/fresh-user';
import { createClient } from '@supabase/supabase-js';
import {
  expireOrgInvite,
  revokeOrgInvite,
  setUserOrgRole,
  getUserProfile,
  createFreshOrg,
  cleanup,
  extractInviteUrl,
  normalizeInviteUrl,
  setupUserProfile,
} from '../helpers/membership';
import * as path from 'path';
import { config as dotenvConfig } from 'dotenv';
import type { Page } from '@playwright/test';

// worktree 環境でも .env.local を読み込む
dotenvConfig({ path: path.resolve(__dirname, '../../../.env.local') });
dotenvConfig({ path: path.resolve(__dirname, '../../../../.env.local') });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws') as typeof WebSocket;

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

/**
 * 共通: ownerPage で招待を発行して inviteUrl と token を返す。
 * 失敗時はエラーメッセージ付きで expect を失敗させる。
 */
async function postInvite(
  ownerPage: Page,
  email: string,
  role: 'member' | 'admin' = 'member',
): Promise<{ inviteUrl: string; token: string }> {
  const res = await ownerPage.request.post(`${BASE_URL}/api/org/invites`, {
    data: { email, role },
  });
  const json = await res.json() as Record<string, unknown>;
  expect(
    res.ok(),
    `招待発行 失敗 (status: ${res.status()}) body: ${JSON.stringify(json)}`,
  ).toBeTruthy();
  const rawUrl = extractInviteUrl(json);
  expect(rawUrl, `invite_url/inviteUrl が取得できない: ${JSON.stringify(json)}`).toContain('/invite/');
  const inviteUrl = normalizeInviteUrl(rawUrl, BASE_URL);
  const token = inviteUrl.split('/invite/')[1] ?? '';
  expect(token, 'token が空').toBeTruthy();
  return { inviteUrl, token };
}

test.describe('org 招待 — エッジケース', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // α-3: email 不一致
  // ─────────────────────────────────────────────────────────────────────────
  test('α-3: email 不一致 — 「ログアウトしてやり直す」表示', async ({ freshOrgWithOwner, browser }) => {
    const { page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    const alice = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-alice-invitee' });
    const bob = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-bob-wrong' });
    // middleware の onboarding チェックを回避するために user_profiles を作成
    await setupUserProfile({ userId: alice.id });
    await setupUserProfile({ userId: bob.id });

    try {
      const { inviteUrl } = await postInvite(ownerPage, alice.email);

      // bob がログイン済み状態で alice 宛の招待 URL にアクセス
      const bobPage = await browser.newPage();
      try {
        await injectSession(bobPage, bob.email, bob.password);
        await bobPage.goto(inviteUrl);

        // パターン C: email 不一致 → 「ログアウトしてやり直す」ボタン表示
        await expect(
          bobPage.getByRole('button', { name: /ログアウトしてやり直す/i }),
        ).toBeVisible({ timeout: 15_000 });

        // 招待先メール (alice) と現在のメール (bob) が表示
        await expect(bobPage.getByText(alice.email, { exact: false })).toBeVisible();
        await expect(bobPage.getByText(bob.email, { exact: false })).toBeVisible();

        // 「承諾する」ボタンは表示されないこと
        await expect(
          bobPage.getByRole('button', { name: '承諾する' }),
        ).not.toBeVisible();
      } finally {
        await bobPage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, alice.id);
      await cleanupFreshUser(supabaseAdmin, bob.id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-7: 期限切れ招待
  // ─────────────────────────────────────────────────────────────────────────
  test('α-7: expired token — 「期限切れ」表示', async ({ freshOrgWithOwner, browser }) => {
    const { page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    const invitee = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-expired-invitee' });
    // α-7 は未認証アクセスで期限切れ表示を確認 (user_profiles 不要)

    try {
      const { inviteUrl, token } = await postInvite(ownerPage, invitee.email);

      // expires_at を過去日時に強制変更
      await expireOrgInvite(token);

      const inviteePage = await browser.newPage();
      try {
        await inviteePage.goto(inviteUrl);

        // 期限切れ表示 (パターン D: expired)
        await expect(
          inviteePage.getByText(/期限切れ|招待は無効|有効期限|この招待は/, { exact: false }),
        ).toBeVisible({ timeout: 15_000 });

        // 「承諾する」ボタンは表示されない
        await expect(
          inviteePage.getByRole('button', { name: '承諾する' }),
        ).not.toBeVisible();
      } finally {
        await inviteePage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, invitee.id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-8: 存在しない (invalid) token
  // ─────────────────────────────────────────────────────────────────────────
  test('α-8: invalid token — エラーページ表示', async ({ browser }) => {
    const invalidToken = 'totally-invalid-nonexistent-token-12345';

    const inviteePage = await browser.newPage();
    try {
      await inviteePage.goto(`${BASE_URL}/invite/${invalidToken}`);

      await expect(
        inviteePage.getByText(/招待が見つかりません|見つかりません|invalid|存在しません|招待リンクが無効/, { exact: false }),
      ).toBeVisible({ timeout: 15_000 });

      await expect(
        inviteePage.getByRole('button', { name: /ホームへ戻る|ホームへ|戻る/ }),
      ).toBeVisible({ timeout: 5_000 });
    } finally {
      await inviteePage.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-9: 承諾済み token の再 click
  // ─────────────────────────────────────────────────────────────────────────
  test('α-9: accepted token の再アクセス — 「すでに承諾済」表示', async ({ freshOrgWithOwner, browser }) => {
    const { page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    const invitee = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-accepted-invitee' });
    // middleware の onboarding チェックを回避するために user_profiles を作成
    await setupUserProfile({ userId: invitee.id });

    try {
      const { inviteUrl, token } = await postInvite(ownerPage, invitee.email);

      const inviteePage = await browser.newPage();
      try {
        await injectSession(inviteePage, invitee.email, invitee.password);

        // 一度承諾
        const acceptRes = await inviteePage.request.post(`${BASE_URL}/api/org/invites/${token}/accept`);
        expect(acceptRes.ok(), `1回目 accept 失敗: ${acceptRes.status()}`).toBeTruthy();

        // 承諾済みトークンに再アクセス
        await inviteePage.goto(inviteUrl);

        // パターン D: accepted → 「承諾済み」等のメッセージ表示
        await expect(
          inviteePage.getByText(/承諾済み|すでに承諾|accepted|招待は無効/, { exact: false }),
        ).toBeVisible({ timeout: 15_000 });

        // 「承諾する」ボタンは表示されない
        await expect(
          inviteePage.getByRole('button', { name: '承諾する' }),
        ).not.toBeVisible();
      } finally {
        await inviteePage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, invitee.id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-10: 招待拒否
  // ─────────────────────────────────────────────────────────────────────────
  test('α-10: 招待拒否 — POST /api/org/invites/{token}/reject', async ({ freshOrgWithOwner, browser }) => {
    const { page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    const invitee = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-reject-invitee' });
    // middleware の onboarding チェックを回避するために user_profiles を作成
    await setupUserProfile({ userId: invitee.id });

    try {
      const { inviteUrl, token } = await postInvite(ownerPage, invitee.email);

      const inviteePage = await browser.newPage();
      try {
        await injectSession(inviteePage, invitee.email, invitee.password);
        await inviteePage.goto(inviteUrl);

        await expect(
          inviteePage.getByRole('button', { name: '拒否する' }),
        ).toBeVisible({ timeout: 15_000 });

        const [rejectRes] = await Promise.all([
          inviteePage.waitForResponse(
            (res) => res.url().includes(`/api/org/invites/${token}/reject`) && res.request().method() === 'POST',
            { timeout: 15_000 },
          ),
          inviteePage.getByRole('button', { name: '拒否する' }).click(),
        ]);

        expect(rejectRes.status()).toBe(200);

        const profile = await getUserProfile(invitee.id);
        expect(profile.organization_id).toBeNull();
      } finally {
        await inviteePage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, invitee.id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-5: 既所属 org ユーザーが別 org に承諾しようとする
  // ─────────────────────────────────────────────────────────────────────────
  test('α-5: 既所属 org — ALREADY_IN_ORG エラーまたは確認モーダル', async ({ freshOrgWithOwner, browser }) => {
    const { orgId: orgBId, page: ownerBPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    const alice = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-already-member' });
    let orgAId: string | null = null;

    try {
      orgAId = await createFreshOrg({ ownerUserId: alice.id, name: `OrgA-${Date.now()}` });
      await setUserOrgRole({ userId: alice.id, orgId: orgAId, orgRole: 'member' });

      const { inviteUrl, token } = await postInvite(ownerBPage, alice.email);

      const alicePage = await browser.newPage();
      try {
        await injectSession(alicePage, alice.email, alice.password);
        await alicePage.goto(inviteUrl);

        await expect(
          alicePage.getByRole('button', { name: '承諾する' }),
        ).toBeVisible({ timeout: 15_000 });

        const [acceptRes] = await Promise.all([
          alicePage.waitForResponse(
            (res) => res.url().includes(`/api/org/invites/${token}/accept`) && res.request().method() === 'POST',
            { timeout: 15_000 },
          ),
          alicePage.getByRole('button', { name: '承諾する' }).click(),
        ]);

        const acceptJson = await acceptRes.json() as {
          ok?: boolean;
          error?: { code: string; message: string };
          organization_id?: string;
        };

        if (acceptRes.status() === 200) {
          expect(acceptJson.organization_id).toBe(orgBId);
        } else {
          expect(acceptJson.error?.code).toMatch(/ALREADY_IN_ORG|ALREADY_MEMBER/i);
          await expect(
            alicePage.getByText(/所属しています|ALREADY_IN_ORG|別の組織|移動/, { exact: false }),
          ).toBeVisible({ timeout: 10_000 });
        }
      } finally {
        await alicePage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, alice.id);
      if (orgAId) {
        await cleanup({ orgIds: [orgAId] });
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // revoke 済み招待
  // ─────────────────────────────────────────────────────────────────────────
  test('revoke 済み招待 — 「取り消し済み」表示', async ({ freshOrgWithOwner, browser }) => {
    const { page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    const invitee = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-revoke-invitee' });
    // middleware の onboarding チェックを回避するために user_profiles を作成
    await setupUserProfile({ userId: invitee.id });

    try {
      const { inviteUrl, token } = await postInvite(ownerPage, invitee.email);

      await revokeOrgInvite(token);

      const inviteePage = await browser.newPage();
      try {
        await injectSession(inviteePage, invitee.email, invitee.password);
        await inviteePage.goto(inviteUrl);

        await expect(
          inviteePage.getByText(/取り消し|revoked|招待は無効|無効/, { exact: false }),
        ).toBeVisible({ timeout: 15_000 });

        await expect(
          inviteePage.getByRole('button', { name: '承諾する' }),
        ).not.toBeVisible();
      } finally {
        await inviteePage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, invitee.id);
    }
  });
});
