// src/app/api/family/members/names/route.ts
// GET /api/family/members/names — 家族の画面に出す、自分の家族のメンバーの名前 (#1584)
//
// 以前は、招待を承諾したメンバーの family_members.display_name が NULL のままで、家族の画面に「名前未設定」と出ていた。
// 承諾のときは、本人のプロフィールの名前を display_name に写す (supabase/migrations/20261015170000_accept_copies_profile_name.sql。
// 仮置きの 'Guest'・空白だけは写さない)。それより前に承諾した人や、承諾のときに名前が無かった人は NULL のままなので、
// ここで display_name → 本人のプロフィールの今の名前 (user_profiles.nickname。仮置きの 'Guest' は名前とみなさない) → null の順に
// 決めて返す (決め方は src/lib/membership/family-member-names.ts。写した名前は 1 に入るので、後でプロフィールの名前を変えても写した名前のまま)。
//
// 認可: 家族のメンバーの行は、ログイン中の利用者のクライアント (RLS: family_members_select_self_or_family) で読む。
// 他の家族の user_profiles は RLS で読めないので、名前だけは service_role で引く。引くのは、RLS で読めた行のうち
// 状態が active で display_name が無いメンバーの user_id の分だけで、列は nickname だけ。返すのは member id と名前だけ。
import { NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';
import {
  buildFamilyMemberNames,
  userIdsNeedingProfileName,
  type FamilyMemberNameSource,
} from '@/lib/membership/family-member-names';
import type { FamilyMemberNamesData } from '@/schemas/membership/family-member';

/** 名前を返すメンバーの状態。脱退・除外されたメンバーの、その後のプロフィールの名前は返さない */
const LISTED_MEMBER_STATUS = 'active';

export async function GET() {
  const logger = createLogger('GET /api/family/members/names', generateRequestId());
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }
  const log = logger.withUser(user.id);

  // 自分の家族 (家族の画面と同じく user_profiles.family_id)。自分の行は RLS で読める
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('family_id')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) {
    log.error('家族のメンバーの名前: プロフィールの取得に失敗', profileError);
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: 'メンバーの名前の取得に失敗しました' } },
      { status: 500 },
    );
  }

  const familyId = profile?.family_id ?? null;
  if (!familyId) {
    const empty: FamilyMemberNamesData = { members: [] };
    return NextResponse.json({ data: empty }, { status: 200 });
  }

  // メンバーの行は利用者のクライアントで読む (RLS で、読める行 = 自分が見てよいメンバーに限られる)
  const { data: memberRows, error: membersError } = await supabase
    .from('family_members')
    .select('id, user_id, display_name')
    .eq('family_id', familyId)
    .eq('status', LISTED_MEMBER_STATUS);
  if (membersError) {
    log.error('家族のメンバーの名前: メンバーの取得に失敗', membersError, { familyId });
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: 'メンバーの名前の取得に失敗しました' } },
      { status: 500 },
    );
  }

  const rows: FamilyMemberNameSource[] = memberRows ?? [];
  const profileNames = new Map<string, string>();
  const userIds = userIdsNeedingProfileName(rows);
  if (userIds.length > 0) {
    // 名前の補完は表示の改善なので、引けなくても 200 で返す (その人の名前は null = 画面は「名前未設定」)。
    // 仮置きの 'Guest' はここでは除かず、buildFamilyMemberNames が null にする (決め方を 1 か所にまとめる)
    try {
      const { data: profiles, error: profilesError } = await getSupabaseAdmin()
        .from('user_profiles')
        .select('id, nickname')
        .in('id', userIds);
      if (profilesError) {
        log.warn('家族のメンバーの名前: プロフィールの名前を引けませんでした', {
          familyId,
          requested: userIds.length,
          error_code: profilesError.code,
        });
      } else {
        for (const row of profiles ?? []) {
          if (typeof row.nickname === 'string') profileNames.set(row.id, row.nickname);
        }
      }
    } catch (err) {
      log.warn('家族のメンバーの名前: プロフィールの名前を引けませんでした', {
        familyId,
        requested: userIds.length,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  const data: FamilyMemberNamesData = { members: buildFamilyMemberNames(rows, profileNames) };
  return NextResponse.json({ data }, { status: 200 });
}
