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
import { OrgInviteSchema } from '@/schemas/membership/organization-invite';
import { FamilyGroupSchema } from '@/schemas/membership/family-group';
import { FamilyInviteSchema } from '@/schemas/membership/family-invite';
import { z } from 'zod';
import { describe, it } from 'vitest';

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
