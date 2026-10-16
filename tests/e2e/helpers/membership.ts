/**
 * tests/e2e/helpers/membership.ts
 *
 * org 招待・メンバー管理 E2E テスト用ヘルパー群。
 * Supabase service_role REST API / admin API を直接呼び出して
 * テストデータを組み立てる。
 */

import type { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import * as path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { generateTestPassword } from './credentials';

// worktree 環境でも .env.local を読み込む (2段フォールバック)
dotenvConfig({ path: path.resolve(__dirname, '../../../.env.local') });
dotenvConfig({ path: path.resolve(__dirname, '../../../../.env.local') });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws') as typeof WebSocket;

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

// 実行ごとにランダムな値 (リポジトリに固定のパスワードを置かない)
export const TEST_PASSWORD = generateTestPassword();

// ─────────────────────────────────────────────────────────────────────────────
// Supabase admin クライアント (service_role)
// ─────────────────────────────────────────────────────────────────────────────

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      '[membership helper] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。',
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      // @ts-expect-error ws は Node.js 用 WebSocket 実装
      transport: ws,
    },
  });
}

function getEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[membership helper] 環境変数が未設定です');
  }
  return { supabaseUrl, serviceRoleKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// createFreshOrg
// ─────────────────────────────────────────────────────────────────────────────

/**
 * org を作成し、指定 userId を owner に設定して org_id を返す。
 * service_role REST API を直接使用。
 * organizations.owner_id は NOT NULL (#1103 項目 10 / migration 20261017100000) なので INSERT に含める。
 */
export async function createFreshOrg(options: {
  ownerUserId: string;
  name?: string;
}): Promise<string> {
  const { supabaseUrl, serviceRoleKey } = getEnv();
  const orgName = options.name ?? `E2E Org ${Date.now()}`;

  // organizations INSERT
  const orgResp = await fetch(`${supabaseUrl}/rest/v1/organizations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ name: orgName, plan: 'standard', owner_id: options.ownerUserId }),
  });

  if (!orgResp.ok) {
    const text = await orgResp.text();
    throw new Error(`[createFreshOrg] organizations INSERT 失敗 (${orgResp.status}): ${text.substring(0, 300)}`);
  }

  const orgs = (await orgResp.json()) as Array<{ id: string }>;
  const orgId = orgs[0]?.id;
  if (!orgId) throw new Error('[createFreshOrg] org id が返却されませんでした');

  // user_profiles UPSERT: owner として設定
  const profileResp = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      id: options.ownerUserId,
      nickname: 'E2E Org Owner',
      age_group: '30s',
      gender: 'unspecified',
      roles: ['org_admin'],
      organization_id: orgId,
      org_role: 'owner',
      onboarding_completed_at: new Date().toISOString(),
    }),
  });

  if (!profileResp.ok) {
    const text = await profileResp.text();
    throw new Error(`[createFreshOrg] user_profiles UPSERT 失敗 (${profileResp.status}): ${text.substring(0, 300)}`);
  }

  return orgId;
}

// ─────────────────────────────────────────────────────────────────────────────
// createOrgInviteAsAdmin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * org admin として招待を発行し、invite token を返す。
 * Next.js API Route (POST /api/org/invites) を通じて発行することで
 * RPC と同じパスを検証する。
 */
export async function createOrgInviteAsAdmin(options: {
  orgId: string;
  ownerPage: Page;
  email: string;
  role?: 'member' | 'admin';
  customMessage?: string;
  baseURL?: string;
}): Promise<{ token: string; inviteUrl: string }> {
  const { orgId: _orgId, ownerPage, email, role = 'member', customMessage, baseURL } = options;
  const base = baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

  const res = await ownerPage.request.post(`${base}/api/org/invites`, {
    data: {
      email,
      role,
      ...(customMessage ? { custom_message: customMessage } : {}),
    },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`[createOrgInviteAsAdmin] POST /api/org/invites 失敗 (${res.status()}): ${body.substring(0, 300)}`);
  }

  const json = await res.json() as { ok: boolean; invite: { token?: string; invite_url?: string } };
  if (!json.invite?.invite_url) {
    throw new Error(`[createOrgInviteAsAdmin] invite_url が返却されませんでした: ${JSON.stringify(json)}`);
  }

  // invite_url から token を抽出
  const token = json.invite?.invite_url?.split('/invite/')[1] ?? '';
  return { token, inviteUrl: json.invite.invite_url };
}

// ─────────────────────────────────────────────────────────────────────────────
// createOrgInviteDirectly (service_role 経由で直接 RPC 呼び出し)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role admin クライアントで直接 create_org_invite RPC を呼び出す。
 * ownerPage が使えない場合 (未ログイン状態テストなど) に使用。
 */
export async function createOrgInviteDirectly(options: {
  orgId: string;
  callerUserId: string;
  email: string;
  role?: 'member' | 'admin';
  customMessage?: string;
}): Promise<{ token: string; inviteUrl: string }> {
  const { supabaseUrl, serviceRoleKey } = getEnv();
  const { orgId, callerUserId: _callerUserId, email, role = 'member', customMessage } = options;

  // service_role で RPC 呼び出し
  const adminClient = getAdminClient();

  const { data, error } = await adminClient.rpc('create_org_invite', {
    p_organization_id: orgId,
    p_email: email.toLowerCase(),
    p_role: role,
    p_custom_message: customMessage ?? null,
  });

  if (error || !data) {
    throw new Error(`[createOrgInviteDirectly] RPC 失敗: ${error?.message ?? 'no data'}`);
  }

  const invite = data as { id: string; token: string; email: string; invited_role: string; status: string; expires_at: string };
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const inviteUrl = `${baseUrl}/invite/${invite.token}`;

  return { token: invite.token, inviteUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// acceptOrgInvite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 招待先ユーザーのページから POST /api/org/invites/{token}/accept を呼ぶ。
 * レスポンスが ok: true であることを確認して organization_id を返す。
 */
export async function acceptOrgInvite(options: {
  token: string;
  userPage: Page;
  baseURL?: string;
}): Promise<{ organization_id: string }> {
  const { token, userPage, baseURL } = options;
  const base = baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

  const res = await userPage.request.post(`${base}/api/org/invites/${token}/accept`);

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`[acceptOrgInvite] POST /api/org/invites/${token}/accept 失敗 (${res.status()}): ${body.substring(0, 300)}`);
  }

  const json = await res.json() as { ok: boolean; organization_id: string };
  return { organization_id: json.organization_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// getUserProfile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role で user_profiles を取得して organization_id / org_role を返す。
 */
export async function getUserProfile(userId: string): Promise<{
  organization_id: string | null;
  org_role: string | null;
}> {
  const { supabaseUrl, serviceRoleKey } = getEnv();

  const resp = await fetch(`${supabaseUrl}/rest/v1/user_profiles?id=eq.${userId}&select=organization_id,org_role`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`[getUserProfile] 取得失敗 (${resp.status})`);
  }

  const rows = (await resp.json()) as Array<{ organization_id: string | null; org_role: string | null }>;
  return rows[0] ?? { organization_id: null, org_role: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// setUserOrgRole
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role で user_profiles の org_role と organization_id を直接設定する。
 * テスト用プリコンディション設定に使用。
 */
export async function setUserOrgRole(options: {
  userId: string;
  orgId: string | null;
  orgRole: 'owner' | 'admin' | 'member' | null;
}): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = getEnv();

  const resp = await fetch(`${supabaseUrl}/rest/v1/user_profiles?id=eq.${options.userId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      organization_id: options.orgId,
      org_role: options.orgRole,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[setUserOrgRole] PATCH user_profiles 失敗 (${resp.status}): ${text.substring(0, 300)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// expireOrgInvite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role で org invite の expires_at を過去日時に更新して強制期限切れにする。
 */
export async function expireOrgInvite(token: string): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = getEnv();

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/organization_invites?token=eq.${token}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ expires_at: '2020-01-01T00:00:00Z' }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[expireOrgInvite] PATCH 失敗 (${resp.status}): ${text.substring(0, 300)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// revokeOrgInvite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role で org invite の status を 'revoked' に変更する。
 */
export async function revokeOrgInvite(token: string): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = getEnv();

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/organization_invites?token=eq.${token}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: 'revoked' }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[revokeOrgInvite] PATCH 失敗 (${resp.status}): ${text.substring(0, 300)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// cleanup
// ─────────────────────────────────────────────────────────────────────────────

/** 後片付けの失敗の報告に添える、応答の本文の先頭の文字数 (長い HTML のエラーページでログを埋めない) */
const CLEANUP_ERROR_BODY_PREVIEW_CHARS = 200;

/**
 * テスト後のクリーンアップ。組織 → ユーザーの順に消す。
 *
 * 1. 消す組織に所属している利用者 (user_profiles.organization_id が消す組織) の organization_id / org_role を NULL に戻す。
 *    組織の DELETE は user_profiles.organization_id を ON DELETE SET NULL で外すが、org_role は残るので、
 *    所属者が 1 人でも残っていると CHECK user_profiles_org_consistency (両方 NULL か両方あり) に反して組織の DELETE が失敗する。
 * 2. 組織を消す (CASCADE で organization_invites なども消える)。
 * 3. ユーザーを消す (CASCADE で user_profiles も消える)。organizations.owner_id → auth.users は ON DELETE RESTRICT
 *    (#1103 項目 10 で owner_id は NOT NULL) なので、持ち主のユーザーは組織を消した後でないと消せない。
 *
 * 1・2 のどれかが失敗したら、ユーザーを消さずに例外にする (組織が残ったまま持ち主を消そうとしても RESTRICT で失敗し、
 * 本当の原因が隠れるため)。3 の失敗もまとめて例外にする (黙ってゴミを残さない)。
 */
export async function cleanup(options: {
  orgIds?: string[];
  userIds?: string[];
}): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = getEnv();
  const adminClient = getAdminClient();
  const orgIds = options.orgIds ?? [];
  const orgFailures: string[] = [];

  // 1. 所属を外す (組織の DELETE が CHECK user_profiles_org_consistency に反しないように)
  if (orgIds.length > 0) {
    try {
      const resp = await fetch(
        `${supabaseUrl}/rest/v1/user_profiles?organization_id=in.(${orgIds.join(',')})`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ organization_id: null, org_role: null }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        orgFailures.push(
          `user_profiles の所属の解除に失敗 (orgIds: ${orgIds.join(',')}, status: ${resp.status}): ${text.substring(0, CLEANUP_ERROR_BODY_PREVIEW_CHARS)}`,
        );
      }
    } catch (err) {
      orgFailures.push(`user_profiles の所属の解除で例外 (orgIds: ${orgIds.join(',')}): ${String(err)}`);
    }
  }

  // 2. 組織を消す (所属の解除に失敗していたら、DELETE も CHECK で失敗するので試さない)
  if (orgFailures.length === 0) {
    for (const orgId of orgIds) {
      try {
        const resp = await fetch(`${supabaseUrl}/rest/v1/organizations?id=eq.${orgId}`, {
          method: 'DELETE',
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: 'return=minimal',
          },
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          orgFailures.push(
            `org DELETE 失敗 (orgId: ${orgId}, status: ${resp.status}): ${text.substring(0, CLEANUP_ERROR_BODY_PREVIEW_CHARS)}`,
          );
        }
      } catch (err) {
        orgFailures.push(`org DELETE 例外 (orgId: ${orgId}): ${String(err)}`);
      }
    }
  }

  // 組織が残っていれば、持ち主のユーザーは RESTRICT で消せない。ユーザーを消す前に止める
  if (orgFailures.length > 0) {
    throw new Error(`[cleanup] 組織の後片付けに失敗 (ユーザーは消していない): ${orgFailures.join(' / ')}`);
  }

  // 3. ユーザーを消す (組織を消した後)。deleteUser は失敗を例外ではなく error で返す
  const userFailures: string[] = [];
  for (const userId of options.userIds ?? []) {
    try {
      const { error } = await adminClient.auth.admin.deleteUser(userId);
      if (error) userFailures.push(`deleteUser 失敗 (userId: ${userId}): ${error.message}`);
    } catch (err) {
      userFailures.push(`deleteUser 例外 (userId: ${userId}): ${String(err)}`);
    }
  }
  if (userFailures.length > 0) {
    throw new Error(`[cleanup] ユーザーの後片付けに失敗: ${userFailures.join(' / ')}`);
  }
}
