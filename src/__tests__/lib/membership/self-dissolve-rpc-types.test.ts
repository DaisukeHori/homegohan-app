// #1917 (設計書 docs/design/family/11-self-dissolve.md §11.4・§21.1): 生成型 (database.types.ts) に解散の RPC 4 本と、
// NULL を受ける representative_id / owner_id があることを、型で確かめる。
// tests/ は tsc の対象外 (tsconfig.json の exclude) なので、型が掛かる src/__tests__ に置く (型が違えば tsc が赤になる)。
import { describe, expect, it } from 'vitest';
import type { Database, Json } from '@/types/database.types';
import { SelfDissolveRpcResultSchema } from '@/schemas/membership/self-dissolve';

type Fns = Database['public']['Functions'];
type Tables = Database['public']['Tables'];

/** 2 つの型が同じなら true (どちらの向きにも代入できる) */
type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const FAMILY_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const USER_ID = '00000000-0000-4000-8000-000000000003';

describe('#1917 生成型の解散の RPC と列の型', () => {
  it('生成型の Functions に dissolve_family_by_representative / dissolve_org_by_owner (Args { p_family_id } / { p_organization_id }・Returns Json) と family_dissolve_apply / org_dissolve_apply がある。Tables.family_groups.Row.representative_id と Tables.organizations.Row.owner_id は string | null', () => {
    const familyArgs: Fns['dissolve_family_by_representative']['Args'] = { p_family_id: FAMILY_ID };
    const orgArgs: Fns['dissolve_org_by_owner']['Args'] = { p_organization_id: ORG_ID };
    const familyArgsExact: IsExact<Fns['dissolve_family_by_representative']['Args'], { p_family_id: string }> = true;
    const orgArgsExact: IsExact<Fns['dissolve_org_by_owner']['Args'], { p_organization_id: string }> = true;
    const familyReturnsJson: IsExact<Fns['dissolve_family_by_representative']['Returns'], Json> = true;
    const orgReturnsJson: IsExact<Fns['dissolve_org_by_owner']['Returns'], Json> = true;
    const applyFamilyArgs: Fns['family_dissolve_apply']['Args'] = { p_family_id: FAMILY_ID };
    const applyOrgArgs: Fns['org_dissolve_apply']['Args'] = { p_organization_id: ORG_ID };
    const representativeNullable: IsExact<Tables['family_groups']['Row']['representative_id'], string | null> = true;
    const ownerNullable: IsExact<Tables['organizations']['Row']['owner_id'], string | null> = true;
    const applyFamilyReturnsNullRep: IsExact<Fns['family_dissolve_apply']['Returns']['representative_id'], string | null> = true;
    const applyOrgReturnsNullOwner: IsExact<Fns['org_dissolve_apply']['Returns']['owner_id'], string | null> = true;

    expect([
      familyArgsExact,
      orgArgsExact,
      familyReturnsJson,
      orgReturnsJson,
      representativeNullable,
      ownerNullable,
      applyFamilyReturnsNullRep,
      applyOrgReturnsNullOwner,
    ]).toEqual(Array(8).fill(true));
    expect(familyArgs).toEqual({ p_family_id: FAMILY_ID });
    expect(orgArgs).toEqual({ p_organization_id: ORG_ID });
    expect(applyFamilyArgs).toEqual({ p_family_id: FAMILY_ID });
    expect(applyOrgArgs).toEqual({ p_organization_id: ORG_ID });
  });

  it('生成型の Json (RPC の戻り値) は SelfDissolveRpcResultSchema の safeParse で読む (型の主張で通さない)', () => {
    const row = {
      scope_id: FAMILY_ID,
      scope_name: '山田家',
      dissolved_at: '2026-10-19T05:00:00.123456+00:00',
      member_user_ids: [USER_ID],
    };
    const returned: Fns['dissolve_family_by_representative']['Returns'] = row;
    const parsed = SelfDissolveRpcResultSchema.safeParse(returned);
    expect(parsed.success).toBe(true);
    const broken: Fns['dissolve_org_by_owner']['Returns'] = { ...row, member_user_ids: ['not-a-uuid'] };
    expect(SelfDissolveRpcResultSchema.safeParse(broken).success).toBe(false);
    expect(SelfDissolveRpcResultSchema.safeParse(null).success).toBe(false);
  });
});
