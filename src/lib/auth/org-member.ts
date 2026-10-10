// src/lib/auth/org-member.ts
// 組織のメンバー (どの役割でも、いずれかの組織に所属している人) だけを通す認可ヘルパー (#1132)。
//
// 組織の管理者だけを通す requireOrgAdmin() (src/lib/auth/helpers.ts) と対になる。
// 組織のメンバー向けの API (/api/org/my-challenges・/api/org/challenges/[id]・/api/org/challenges/[id]/join) は、
// 入口でこの関数を呼ぶ。route ごとに getUser() → user_profiles の取得 → 所属の判定を手書きしない (#1161)。
//
// 戻り値の organization_id は、呼び出した本人のプロフィールで確認した値。リクエストの body / URL の組織 ID は信用せず、
// 組織の絞り込みには必ずこの値を使う (他組織の行を触らせない)。
// 本人以外の行 (user_profiles など RLS で本人の行しか見えないもの) を読むときは、この関数を通したあとに
// getSupabaseAdmin() (service_role) を使い、対象を絞る条件 (組織 ID・チャレンジ ID) を必ず付ける。
//
// 凍結中のアカウントは、ミドルウェア (lib/supabase/middleware.ts) が API 全体で 403 にするため、ここでは見ない。

import { type User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from './errors';

export interface OrgMemberContext {
  user: User;
  profile: {
    organization_id: string;
    /** 所属している部署。部署を限定したチャレンジに参加できるかの判定に使う。未所属なら null */
    department_id: string | null;
  };
}

/**
 * ログイン中のユーザーが、いずれかの組織に所属していることを確認する。
 *
 * @returns 認証済みユーザーと、その所属組織・部署
 * @throws AuthError      (401 相当) - 未認証の場合
 * @throws ForbiddenError (403 相当) - 組織に所属していない場合 (プロフィールが無い場合を含む)
 * @throws Error                     - プロフィールを読めなかった場合 (DB の障害。呼び出し側の catch で 500 にして記録する)
 */
export async function requireOrgMember(): Promise<OrgMemberContext> {
  const supabase = createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    throw new AuthError('AUTH_UNAUTHENTICATED');
  }

  const { data, error } = await supabase
    .from('user_profiles')
    .select('organization_id, department_id')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    // 所属していない (403) と取り違えない。読めなかったことは、そのまま失敗として伝える
    throw new Error(`user_profiles の取得に失敗しました: ${error.message}`);
  }

  const profile = data as { organization_id?: string | null; department_id?: string | null } | null;
  if (!profile?.organization_id) {
    throw new ForbiddenError('PERM_NOT_ORG_MEMBER', '組織に所属していません');
  }

  return {
    user,
    profile: {
      organization_id: profile.organization_id,
      department_id: profile.department_id ?? null,
    },
  };
}
