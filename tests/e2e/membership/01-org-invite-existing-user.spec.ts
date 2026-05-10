/**
 * tests/e2e/membership/01-org-invite-existing-user.spec.ts
 *
 * spec 01: org 招待 — 既存ユーザー受諾
 * 設計書 02-flow-spec.md §1 (α-1, α-2) を E2E で検証する。
 */

import { test as freshOrgTest, expect } from '../fixtures/fresh-org';
import {
  createFreshUser,
  cleanupFreshUser,
  injectSession,
} from '../fixtures/fresh-user';
import { createClient } from '@supabase/supabase-js';
import { getUserProfile } from '../helpers/membership';
import * as path from 'path';
import { config as dotenvConfig } from 'dotenv';

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

// ─────────────────────────────────────────────────────────────────────────────
// α-1: 既存ユーザー承諾 happy path
// ─────────────────────────────────────────────────────────────────────────────

freshOrgTest.describe('org 招待 — 既存ユーザ', () => {
  freshOrgTest('α-1: 既存ユーザ承諾 happy path', async ({ freshOrgWithOwner, browser }) => {
    const { orgId, orgName, page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    // 招待先ユーザー作成 (既存ユーザー)
    const invitee = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-invite-existing' });

    try {
      // 1. owner が POST /api/org/invites で招待発行
      const inviteRes = await ownerPage.request.post(`${BASE_URL}/api/org/invites`, {
        data: { email: invitee.email, role: 'member' },
      });

      const inviteJsonRaw = await inviteRes.json() as {
        ok?: boolean;
        invite?: { invite_url?: string; token?: string; status?: string };
        error?: unknown;
      };
      expect(
        inviteRes.ok(),
        `招待発行 失敗 (status: ${inviteRes.status()}) body: ${JSON.stringify(inviteJsonRaw)}`,
      ).toBeTruthy();
      expect(inviteJsonRaw.ok, `ok フィールドが false: ${JSON.stringify(inviteJsonRaw)}`).toBe(true);
      expect(
        inviteJsonRaw.invite?.invite_url,
        `invite_url が undefined: ${JSON.stringify(inviteJsonRaw)}`,
      ).toContain('/invite/');

      const inviteUrl = inviteJsonRaw.invite!.invite_url!;
      const token = inviteUrl.split('/invite/')[1];
      expect(token, `token が取得できない: inviteUrl=${inviteUrl}`).toBeTruthy();

      // 2. 招待先ユーザーが未ログイン状態で /invite/{token} にアクセス
      const inviteePage = await browser.newPage();
      try {
        await inviteePage.goto(inviteUrl);

        // パターン A: pending + 未ログイン → 「ログインする」「アカウントを作成」ボタンが表示
        await expect(
          inviteePage.getByRole('button', { name: 'ログインする' }),
        ).toBeVisible({ timeout: 15_000 });

        // org 名が表示されていることを確認
        await expect(inviteePage.getByText(orgName, { exact: false })).toBeVisible();

        // 3. invitee のセッションを注入 (ログイン済みにする)
        await injectSession(inviteePage, invitee.email, invitee.password);

        // /invite/{token} に再アクセス
        await inviteePage.goto(inviteUrl);

        // パターン B: pending + ログイン中 + email 一致 → 「承諾する」ボタンが表示
        await expect(
          inviteePage.getByRole('button', { name: '承諾する' }),
        ).toBeVisible({ timeout: 15_000 });

        // 4. 「承諾する」ボタンをクリック → POST /api/org/invites/{token}/accept
        const [acceptRes] = await Promise.all([
          inviteePage.waitForResponse(
            (res) => res.url().includes(`/api/org/invites/${token}/accept`) && res.request().method() === 'POST',
            { timeout: 15_000 },
          ),
          inviteePage.getByRole('button', { name: '承諾する' }).click(),
        ]);

        expect(acceptRes.status()).toBe(200);
        const acceptJson = await acceptRes.json() as { ok: boolean; organization_id: string };
        expect(acceptJson.ok).toBe(true);
        expect(acceptJson.organization_id).toBe(orgId);

        // 5. user_profiles.organization_id が org_id にセットされていること DB 検証
        const profile = await getUserProfile(invitee.id);
        expect(profile.organization_id).toBe(orgId);
        expect(profile.org_role).toBe('member');

        // 6. redirect: /org/dashboard に遷移すること
        await inviteePage.waitForURL((url) => url.pathname.startsWith('/org/dashboard'), {
          timeout: 15_000,
        });
      } finally {
        await inviteePage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, invitee.id);
    }
  });

  freshOrgTest('α-2: 既ログイン中ユーザーの承諾', async ({ freshOrgWithOwner, browser }) => {
    const { orgId, page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    // 招待先ユーザー作成
    const invitee = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-invite-loggedin' });

    try {
      // 1. owner が招待発行
      const inviteRes = await ownerPage.request.post(`${BASE_URL}/api/org/invites`, {
        data: { email: invitee.email, role: 'member' },
      });
      const inviteJsonRaw2 = await inviteRes.json() as {
        ok?: boolean;
        invite?: { invite_url?: string };
        error?: unknown;
      };
      expect(
        inviteRes.ok(),
        `招待発行 失敗 (status: ${inviteRes.status()}) body: ${JSON.stringify(inviteJsonRaw2)}`,
      ).toBeTruthy();
      expect(
        inviteJsonRaw2.invite?.invite_url,
        `invite_url が undefined: ${JSON.stringify(inviteJsonRaw2)}`,
      ).toContain('/invite/');
      const inviteUrl = inviteJsonRaw2.invite!.invite_url!;
      const token = inviteUrl.split('/invite/')[1];

      // 2. invitee がログイン済み状態でアクセス (セッション注入 → 直接アクセス)
      const inviteePage = await browser.newPage();
      try {
        await injectSession(inviteePage, invitee.email, invitee.password);

        // /invite/{token} に直接アクセス → ログイン画面を経由しない
        await inviteePage.goto(inviteUrl);

        // パターン B: pending + ログイン中 + email 一致 → 承諾画面を直接表示
        await expect(
          inviteePage.getByRole('button', { name: '承諾する' }),
        ).toBeVisible({ timeout: 15_000 });

        // 「ログインする」ボタンは表示されないこと (パターン A でない)
        await expect(
          inviteePage.getByRole('button', { name: 'ログインする' }),
        ).not.toBeVisible();

        // 3. 「承諾する」クリック
        const [acceptRes] = await Promise.all([
          inviteePage.waitForResponse(
            (res) => res.url().includes(`/api/org/invites/${token}/accept`) && res.request().method() === 'POST',
            { timeout: 15_000 },
          ),
          inviteePage.getByRole('button', { name: '承諾する' }).click(),
        ]);

        expect(acceptRes.status()).toBe(200);

        // 4. user_profiles.organization_id が設定される
        const profile = await getUserProfile(invitee.id);
        expect(profile.organization_id).toBe(orgId);

        // 5. /org/dashboard へ redirect
        await inviteePage.waitForURL((url) => url.pathname.startsWith('/org/dashboard'), {
          timeout: 15_000,
        });
      } finally {
        await inviteePage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, invitee.id);
    }
  });
});
