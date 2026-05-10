/**
 * tests/e2e/membership/04-org-member-management.spec.ts
 *
 * spec 04: org メンバー管理
 * 設計書 02-flow-spec.md §4, §5 (α-11〜α-14) を E2E で検証する。
 */

import { test, expect } from '../fixtures/fresh-org';
import { createFreshUser, cleanupFreshUser, injectSession } from '../fixtures/fresh-user';
import { createClient } from '@supabase/supabase-js';
import {
  getUserProfile,
  setUserOrgRole,
} from '../helpers/membership';
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

test.describe('org メンバ管理', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // α-11: メンバー除名
  // ─────────────────────────────────────────────────────────────────────────
  test('α-11: owner がメンバーを除名 — user_profiles.organization_id = NULL', async ({
    freshOrgWithOwner,
  }) => {
    const { orgId, page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    // member として組織に追加
    const member = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-remove-member' });

    try {
      // member を org に追加 (service_role で直接 UPSERT)
      await setUserOrgRole({ userId: member.id, orgId, orgRole: 'member' });

      // owner が POST /api/org/members/{user_id}/remove
      const removeRes = await ownerPage.request.post(
        `${BASE_URL}/api/org/members/${member.id}/remove`,
      );
      expect(removeRes.ok(), `除名 API status: ${removeRes.status()}`).toBeTruthy();

      const removeJson = await removeRes.json() as { ok: boolean };
      expect(removeJson.ok).toBe(true);

      // user_profiles.organization_id = NULL, org_role = NULL
      const profile = await getUserProfile(member.id);
      expect(profile.organization_id).toBeNull();
      expect(profile.org_role).toBeNull();
    } finally {
      await cleanupFreshUser(supabaseAdmin, member.id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-12: 自発脱退
  // ─────────────────────────────────────────────────────────────────────────
  test('α-12: member が自発的に脱退 — user_profiles.organization_id = NULL', async ({
    freshOrgWithOwner,
    browser,
  }) => {
    const { orgId } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    const member = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-leave-member' });

    try {
      // member を org に追加
      await setUserOrgRole({ userId: member.id, orgId, orgRole: 'member' });

      // member の page でログイン
      const memberPage = await browser.newPage();
      try {
        await injectSession(memberPage, member.email, member.password);

        // POST /api/org/leave
        const leaveRes = await memberPage.request.post(`${BASE_URL}/api/org/leave`);
        expect(leaveRes.ok(), `脱退 API status: ${leaveRes.status()}`).toBeTruthy();

        const leaveJson = await leaveRes.json() as { ok: boolean };
        expect(leaveJson.ok).toBe(true);

        // user_profiles 更新確認
        const profile = await getUserProfile(member.id);
        expect(profile.organization_id).toBeNull();
        expect(profile.org_role).toBeNull();
      } finally {
        await memberPage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, member.id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-13: Owner 譲渡 2 step
  // ─────────────────────────────────────────────────────────────────────────
  test('α-13 Owner 譲渡 — propose → accept → org_role 入れ替わり', async ({
    freshOrgWithOwner,
    browser,
  }) => {
    const { orgId, userId: ownerId, page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    // Bob: admin として org に追加 (譲渡先)
    const bob = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-transfer-target' });

    try {
      // Bob を admin として追加
      await setUserOrgRole({ userId: bob.id, orgId, orgRole: 'admin' });

      // Step 1: owner (Alice) が Bob へ譲渡提案
      const proposeRes = await ownerPage.request.post(`${BASE_URL}/api/org/owner-transfer/propose`, {
        data: {
          organization_id: orgId,
          to_user_id: bob.id,
        },
      });
      expect(proposeRes.ok(), `提案 API status: ${proposeRes.status()}`).toBeTruthy();

      const proposeJson = await proposeRes.json() as { proposal_id: string };
      const proposalId = proposeJson.proposal_id;
      expect(proposalId).toBeTruthy();

      // Step 2: Bob が承諾
      const bobPage = await browser.newPage();
      try {
        await injectSession(bobPage, bob.email, bob.password);

        const acceptRes = await bobPage.request.post(
          `${BASE_URL}/api/org/owner-transfer/${proposalId}/accept`,
        );
        expect(acceptRes.ok(), `承諾 API status: ${acceptRes.status()}`).toBeTruthy();

        const acceptJson = await acceptRes.json() as { ok: boolean };
        expect(acceptJson.ok).toBe(true);

        // Alice.org_role = 'admin', Bob.org_role = 'owner'
        const aliceProfile = await getUserProfile(ownerId);
        const bobProfile = await getUserProfile(bob.id);

        expect(aliceProfile.org_role).toBe('admin');
        expect(bobProfile.org_role).toBe('owner');
        expect(bobProfile.organization_id).toBe(orgId);
      } finally {
        await bobPage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, bob.id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-13 decline ケース
  // ─────────────────────────────────────────────────────────────────────────
  test('α-13 Owner 譲渡 — decline → org_role は変わらない', async ({
    freshOrgWithOwner,
    browser,
  }) => {
    const { orgId, userId: ownerId, page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();

    const bob = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-decline-target' });

    try {
      await setUserOrgRole({ userId: bob.id, orgId, orgRole: 'admin' });

      // 提案
      const proposeRes = await ownerPage.request.post(`${BASE_URL}/api/org/owner-transfer/propose`, {
        data: {
          organization_id: orgId,
          to_user_id: bob.id,
        },
      });
      expect(proposeRes.ok()).toBeTruthy();

      const proposeJson = await proposeRes.json() as { proposal_id: string };
      const proposalId = proposeJson.proposal_id;

      // Bob が decline
      const bobPage = await browser.newPage();
      try {
        await injectSession(bobPage, bob.email, bob.password);

        const declineRes = await bobPage.request.post(
          `${BASE_URL}/api/org/owner-transfer/${proposalId}/decline`,
        );
        expect(declineRes.ok(), `decline API status: ${declineRes.status()}`).toBeTruthy();

        // org_role は変わらないこと
        const aliceProfile = await getUserProfile(ownerId);
        const bobProfile = await getUserProfile(bob.id);

        expect(aliceProfile.org_role).toBe('owner');
        expect(bobProfile.org_role).toBe('admin');
      } finally {
        await bobPage.close();
      }
    } finally {
      await cleanupFreshUser(supabaseAdmin, bob.id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // α-14: seat 上限
  // ─────────────────────────────────────────────────────────────────────────
  test('α-14: seat 上限 — SEAT_LIMIT_EXCEEDED エラー', async ({ freshOrgWithOwner }) => {
    const { orgId, page: ownerPage } = freshOrgWithOwner;
    const supabaseAdmin = getAdminClient();
    const { supabaseUrl, serviceRoleKey } = (() => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      return { supabaseUrl: url, serviceRoleKey: key };
    })();

    // org_license_pools の seat_limit を 0 または使用済みシートと同値に設定して満席にする
    const setLimitResp = await fetch(
      `${supabaseUrl}/rest/v1/org_license_pools?organization_id=eq.${orgId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ seat_limit: 0 }),
      },
    );

    if (!setLimitResp.ok) {
      // org_license_pools が存在しない場合はテストをスキップ (テーブル未作成)
      test.skip(true, `org_license_pools テーブルが見つからないためスキップ (status: ${setLimitResp.status})`);
      return;
    }

    // 満席状態で招待を試みる
    const uniqueId = `${Date.now()}`;
    const inviteRes = await ownerPage.request.post(`${BASE_URL}/api/org/invites`, {
      data: { email: `e2e-seat-test-${uniqueId}@homegohan.test`, role: 'member' },
    });

    // 400 SEAT_LIMIT_EXCEEDED が返る
    expect(inviteRes.status()).toBe(400);
    const inviteJson = await inviteRes.json() as { error: { code: string } };
    expect(inviteJson.error.code).toMatch(/SEAT_LIMIT_EXCEEDED/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // owner を除名しようとするとエラー
  // ─────────────────────────────────────────────────────────────────────────
  test('owner を除名しようとすると拒否される', async ({ freshOrgWithOwner }) => {
    const { userId: ownerId, page: ownerPage } = freshOrgWithOwner;

    // owner 自身を除名しようとする
    const removeRes = await ownerPage.request.post(
      `${BASE_URL}/api/org/members/${ownerId}/remove`,
    );

    // 拒否 (403 or 400 または RPC エラー)
    expect(removeRes.status()).toBeGreaterThanOrEqual(400);
  });
});
