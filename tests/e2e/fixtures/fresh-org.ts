/**
 * tests/e2e/fixtures/fresh-org.ts
 *
 * org 系 E2E テスト用 fixture。
 * fresh-user.ts の createFreshUser / injectSession を利用して
 * org owner + メンバーを持つ組織を素早くセットアップする。
 */

import { test as base, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import * as path from 'path';
import { config as dotenvConfig } from 'dotenv';
import {
  createFreshUser,
  cleanupFreshUser,
  injectSession,
  type FreshUserInfo,
} from './fresh-user';
import { createFreshOrg, cleanup } from '../helpers/membership';

// worktree 環境でも .env.local を読み込む (2段フォールバック)
dotenvConfig({ path: path.resolve(__dirname, '../../../.env.local') });
dotenvConfig({ path: path.resolve(__dirname, '../../../../.env.local') });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws') as typeof WebSocket;

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[fresh-org fixture] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      // @ts-expect-error ws は Node.js 用 WebSocket 実装
      transport: ws,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 型定義
// ─────────────────────────────────────────────────────────────────────────────

export type OrgOwnerFixtureValue = {
  /** owner がログイン済みの Playwright page */
  page: Page;
  userId: string;
  email: string;
  password: string;
  orgId: string;
  orgName: string;
};

export type OrgWithMembersFixtureValue = {
  /** owner がログイン済みの Playwright page */
  ownerPage: Page;
  owner: FreshUserInfo & { orgId: string };
  /** active メンバー (member ロール) の情報。各自のページは未作成 */
  members: FreshUserInfo[];
  /** admin ロールのメンバー情報 */
  admin: FreshUserInfo;
  orgId: string;
  orgName: string;
};

type FreshOrgFixtures = {
  /**
   * freshOrgWithOwner:
   * - fresh user を admin.createUser で作成
   * - organizations に fresh org を INSERT (service_role)
   * - user_profiles に org_role='owner' / organization_id を UPSERT
   * - session inject 済みの ownerPage を返す
   * - afterAll で所属を外して org → ユーザーの順に削除 (owner_id は ON DELETE RESTRICT。tests/e2e/helpers/membership.ts の cleanup)
   */
  freshOrgWithOwner: OrgOwnerFixtureValue;
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 実装
// ─────────────────────────────────────────────────────────────────────────────

export const test = base.extend<FreshOrgFixtures>({
  /**
   * freshOrgWithOwner: owner 1 名のシンプルな fresh org。
   */
  freshOrgWithOwner: async ({ page }, use) => {
    const supabaseAdmin = getAdminClient();

    // 1. owner ユーザー作成
    const owner = await createFreshUser(supabaseAdmin, {
      emailPrefix: 'e2e-org-owner',
    });

    let orgId: string | null = null;

    try {
      // 2. org 作成 + owner に org_role='owner' UPSERT
      const orgName = `E2E Org ${Date.now()}`;
      orgId = await createFreshOrg({ ownerUserId: owner.id, name: orgName });

      // 3. session inject
      await injectSession(page, owner.email);

      await use({
        page,
        userId: owner.id,
        email: owner.email,
        password: owner.password,
        orgId,
        orgName,
      });
    } finally {
      // 組織を先に消す (organizations.owner_id → auth.users は ON DELETE RESTRICT。#1103 項目 10)。
      // cleanup() は、組織に所属している利用者 (持ち主・テストが足したメンバー) の organization_id / org_role を
      // 先に NULL に戻してから組織を消す (CHECK user_profiles_org_consistency)。失敗すれば例外になる
      if (orgId) {
        await cleanup({ orgIds: [orgId] });
      }
      await cleanupFreshUser(supabaseAdmin, owner.id);
    }
  },
});

export { expect } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// freshOrgWithMembers ヘルパー関数 (fixture ではなく直接使えるユーティリティ)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * owner + N 名 member + admin 1 名のフル org セットアップ。
 * fixture として使いづらい場合はこちらを test 内で直接呼ぶ。
 *
 * 使い方:
 *   const org = await setupFreshOrgWithMembers({ memberCount: 2, ownerPage: page });
 *   // テスト終了時に cleanup が必要:
 *   await org.cleanup();
 */
export async function setupFreshOrgWithMembers(options: {
  memberCount: number;
  ownerPage: Page;
}): Promise<OrgWithMembersFixtureValue & { cleanup: () => Promise<void> }> {
  const supabaseAdmin = getAdminClient();
  const { supabaseUrl, serviceRoleKey } = (() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    return { supabaseUrl: url, serviceRoleKey: key };
  })();

  const orgName = `E2E Members Org ${Date.now()}`;

  // owner 作成
  const ownerInfo = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-org-owner' });
  const orgId = await createFreshOrg({ ownerUserId: ownerInfo.id, name: orgName });

  // session inject for owner page
  await injectSession(options.ownerPage, ownerInfo.email);

  // members 作成
  const members: FreshUserInfo[] = [];
  for (let i = 0; i < options.memberCount; i++) {
    const m = await createFreshUser(supabaseAdmin, { emailPrefix: `e2e-org-member-${i}` });
    // user_profiles に member として UPSERT
    await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: m.id,
        nickname: `E2E Member ${i}`,
        age_group: '30s',
        gender: 'unspecified',
        roles: ['user'],
        organization_id: orgId,
        org_role: 'member',
        onboarding_completed_at: new Date().toISOString(),
      }),
    });
    members.push(m);
  }

  // admin 作成
  const adminInfo = await createFreshUser(supabaseAdmin, { emailPrefix: 'e2e-org-admin' });
  await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      id: adminInfo.id,
      nickname: 'E2E Org Admin',
      age_group: '30s',
      gender: 'unspecified',
      roles: ['org_admin'],
      organization_id: orgId,
      org_role: 'admin',
      onboarding_completed_at: new Date().toISOString(),
    }),
  });

  const allUserIds = [ownerInfo.id, ...members.map((m) => m.id), adminInfo.id];

  return {
    ownerPage: options.ownerPage,
    owner: { ...ownerInfo, orgId },
    members,
    admin: adminInfo,
    orgId,
    orgName,
    cleanup: async () => {
      await cleanup({ orgIds: [orgId], userIds: allUserIds });
    },
  };
}
