// src/__tests__/schemas/membership-types.test.ts
// (設計書 01-data-model.md §6)
//
// このファイルは migration (20260511000100-000130) を local Supabase に apply し、
// npm run types:supabase を実行した後に database.types.ts が更新されることで
// 完全に pass する型整合性テストです。
//
// 現在の database.types.ts は membership migration 適用前のため、
// 一部の型アサインは migration 適用後に正しく機能します。

import type { Database } from '@/types/database.types';
import {
  OrgInviteSchema,
  CreateOrgInviteRequestBodySchema,
  AddOrgMemberRequestBodySchema,
} from '@/schemas/membership/organization-invite';
import { FamilyGroupSchema } from '@/schemas/membership/family-group';
import { FamilyInviteSchema } from '@/schemas/membership/family-invite';
import { z } from 'zod';
import { describe, it, expect } from 'vitest';

// ===== organization_invites 型整合テスト =====
// migration: 20260511000102_membership_org_invites.sql で新カラム追加後に有効

type DbOrgInvite = Database['public']['Tables']['organization_invites']['Row'];
type ZodOrgInvite = z.infer<typeof OrgInviteSchema>;

// このアサインが通れば schema と DB 型は互換
// NOTE: migration 適用・型生成後に有効になる (現在は DbOrgInvite に新カラムなし)
// const _typecheck: DbOrgInvite = {} as ZodOrgInvite;
// const _reverse: ZodOrgInvite = {} as DbOrgInvite;

// ===== family_groups 型整合テスト =====

type DbFamilyGroup = Database['public']['Tables']['family_groups']['Row'];
type ZodFamilyGroup = z.infer<typeof FamilyGroupSchema>;

// const _familyGroupCheck: DbFamilyGroup = {} as ZodFamilyGroup;
// const _familyGroupReverse: ZodFamilyGroup = {} as DbFamilyGroup;

// ===== family_invites 型整合テスト =====
// migration: 20260511000112_membership_family_invites.sql (新規テーブル)

// type DbFamilyInvite = Database['public']['Tables']['family_invites']['Row'];
// type ZodFamilyInvite = z.infer<typeof FamilyInviteSchema>;
// const _familyInviteCheck: DbFamilyInvite = {} as ZodFamilyInvite;

// ===== スキーマ構文テスト (migration 依存なし) =====
// スキーマのランタイム解析が正しく動くことを確認

describe('membership Zod schema 構文チェック', () => {
  it('OrgInviteSchema が有効な Zod スキーマである', () => {
    // スキーマ定義自体のサニティチェック
    // Zod v4 は RFC 4122 準拠 UUID (variant bits [89ab]) を要求する
    const result = OrgInviteSchema.safeParse({
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      organization_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      email: 'test@example.com',
      token: 'abcdef0123456789',
      invited_role: 'member',
      custom_message: null,
      status: 'pending',
      expires_at: '2026-12-31T00:00:00.000Z',
      created_at: '2026-05-11T00:00:00.000Z',
      invited_by: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
      accepted_at: null,
      accepted_by: null,
      rejected_at: null,
      revoked_at: null,
      revoked_by: null,
    });
    if (!result.success) {
      throw new Error(`OrgInviteSchema parse failed: ${JSON.stringify(result.error.issues)}`);
    }
  });

  it('FamilyGroupSchema が有効な Zod スキーマである', () => {
    const result = FamilyGroupSchema.safeParse({
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      name: 'テスト家族',
      representative_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      plan_key: 'free',
      member_limit: 4,
      status: 'active',
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T00:00:00.000Z',
      dissolved_at: null,
    });
    if (!result.success) {
      throw new Error(`FamilyGroupSchema parse failed: ${JSON.stringify(result.error.issues)}`);
    }
  });

  it('FamilyInviteSchema が有効な Zod スキーマである', () => {
    const result = FamilyInviteSchema.safeParse({
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      family_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      email: 'test@example.com',
      token: 'abcdef0123456789',
      invited_role: 'adult',
      custom_message: null,
      status: 'pending',
      expires_at: '2026-12-31T00:00:00.000Z',
      created_at: '2026-05-11T00:00:00.000Z',
      invited_by: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
      accepted_by: null,
      accepted_at: null,
      rejected_at: null,
      revoked_at: null,
      revoked_by: null,
    });
    if (!result.success) {
      throw new Error(`FamilyInviteSchema parse failed: ${JSON.stringify(result.error.issues)}`);
    }
  });
});

// ===== 組織招待 API のリクエストボディ (#1163) =====
// POST /api/org/invites (CreateOrgInviteRequestBodySchema) と POST /api/org/members (AddOrgMemberRequestBodySchema)

describe('CreateOrgInviteRequestBodySchema (POST /api/org/invites)', () => {
  it('email は前後の空白を除いて小文字にする', () => {
    const result = CreateOrgInviteRequestBodySchema.safeParse({ email: '  Foo@Example.COM \n' });

    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('foo@example.com');
  });

  it('role を省略すると member、admin と member は指定できる', () => {
    expect(CreateOrgInviteRequestBodySchema.parse({ email: 'a@example.com' }).role).toBe('member');
    expect(CreateOrgInviteRequestBodySchema.parse({ email: 'a@example.com', role: 'admin' }).role).toBe('admin');
    expect(CreateOrgInviteRequestBodySchema.parse({ email: 'a@example.com', role: 'member' }).role).toBe('member');
  });

  it.each(['owner', 'superuser', '', null, 1])('role に %j は指定できない (招待で owner は付与できない)', (role) => {
    expect(CreateOrgInviteRequestBodySchema.safeParse({ email: 'a@example.com', role }).success).toBe(false);
  });

  it.each([
    ['形式が不正', 'not-an-email'],
    ['空文字', ''],
    ['空白のみ', '   '],
    ['@ が 2 つ', 'a@b@example.com'],
    ['ドメインなし', 'a@'],
    ['254 文字を超える', `${'a'.repeat(250)}@example.com`],
    ['数値', 12345],
    ['null', null],
    ['配列', ['a@example.com']],
  ])('email が不正 (%s) なら失敗する', (_label, email) => {
    const result = CreateOrgInviteRequestBodySchema.safeParse({ email });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['email']);
  });

  it('email は 254 文字ちょうどまで通す', () => {
    const email = `${'a'.repeat(242)}@example.com`;
    expect(email).toHaveLength(254);

    expect(CreateOrgInviteRequestBodySchema.safeParse({ email }).success).toBe(true);
  });

  it('email が無ければ失敗する', () => {
    expect(CreateOrgInviteRequestBodySchema.safeParse({}).success).toBe(false);
    expect(CreateOrgInviteRequestBodySchema.safeParse({ role: 'admin' }).success).toBe(false);
  });

  it('custom_message は 500 文字まで。501 文字は失敗する', () => {
    expect(
      CreateOrgInviteRequestBodySchema.safeParse({ email: 'a@example.com', custom_message: 'あ'.repeat(500) }).success,
    ).toBe(true);

    const tooLong = CreateOrgInviteRequestBodySchema.safeParse({
      email: 'a@example.com',
      custom_message: 'あ'.repeat(501),
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0].path).toEqual(['custom_message']);
  });

  it('custom_message は省略・null でもよい (以前の実装と同じく「メッセージなし」)', () => {
    expect(CreateOrgInviteRequestBodySchema.safeParse({ email: 'a@example.com' }).success).toBe(true);
    expect(CreateOrgInviteRequestBodySchema.safeParse({ email: 'a@example.com', custom_message: null }).success).toBe(true);
    expect(CreateOrgInviteRequestBodySchema.safeParse({ email: 'a@example.com', custom_message: 123 }).success).toBe(false);
  });

  it('未知のキー (organization_id, password など) は取り除かれる', () => {
    const result = CreateOrgInviteRequestBodySchema.parse({
      email: 'a@example.com',
      organization_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      password: 'secret',
      is_admin: true,
    });

    expect(Object.keys(result).sort()).toEqual(['email', 'role']);
  });

  it('本文がオブジェクトでなければ失敗する', () => {
    for (const body of [null, undefined, 'text', 123, []]) {
      expect(CreateOrgInviteRequestBodySchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('AddOrgMemberRequestBodySchema (POST /api/org/members)', () => {
  it('email は前後の空白を除いて小文字にする', () => {
    const result = AddOrgMemberRequestBodySchema.safeParse({ email: ' Hanako@Example.com ' });

    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('hanako@example.com');
  });

  it('nickname は前後の空白を除く。空文字・空白のみは空文字になる (宛名なし扱い)', () => {
    expect(AddOrgMemberRequestBodySchema.parse({ email: 'a@example.com', nickname: '  花子  ' }).nickname).toBe('花子');
    expect(AddOrgMemberRequestBodySchema.parse({ email: 'a@example.com', nickname: '' }).nickname).toBe('');
    expect(AddOrgMemberRequestBodySchema.parse({ email: 'a@example.com', nickname: '   ' }).nickname).toBe('');
  });

  it('nickname は 50 文字まで。51 文字は失敗する', () => {
    expect(AddOrgMemberRequestBodySchema.safeParse({ email: 'a@example.com', nickname: 'あ'.repeat(50) }).success).toBe(true);

    const tooLong = AddOrgMemberRequestBodySchema.safeParse({ email: 'a@example.com', nickname: 'あ'.repeat(51) });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0].path).toEqual(['nickname']);
  });

  it('nickname は省略・null でもよく、文字列以外は失敗する', () => {
    expect(AddOrgMemberRequestBodySchema.safeParse({ email: 'a@example.com' }).success).toBe(true);
    expect(AddOrgMemberRequestBodySchema.safeParse({ email: 'a@example.com', nickname: null }).success).toBe(true);
    expect(AddOrgMemberRequestBodySchema.safeParse({ email: 'a@example.com', nickname: 5 }).success).toBe(false);
  });

  it.each([
    ['未指定', {}],
    ['形式が不正', { email: 'not-an-email' }],
    ['254 文字を超える', { email: `${'a'.repeat(250)}@example.com` }],
  ])('email が不正 (%s) なら失敗する', (_label, body) => {
    expect(AddOrgMemberRequestBodySchema.safeParse(body).success).toBe(false);
  });

  it('未知のキー (password, role など) は取り除かれる', () => {
    const result = AddOrgMemberRequestBodySchema.parse({
      email: 'a@example.com',
      password: 'legacy-admin-chosen-pass',
      role: 'owner',
    });

    expect(Object.keys(result)).toEqual(['email']);
    expect(JSON.stringify(result)).not.toContain('legacy-admin-chosen-pass');
  });
});
