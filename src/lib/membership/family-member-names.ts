// src/lib/membership/family-member-names.ts
// 家族の画面に出すメンバーの名前を決める (#1584)。
//
// 以前は、招待を承諾して入ったメンバーの family_members.display_name が NULL のままで、家族の画面に「名前未設定」と出ていた。
// 承諾のときは、本人のプロフィールの名前を display_name に写す (supabase/migrations/20261015170000_accept_copies_profile_name.sql。
// 仮置きの 'Guest'・空白だけは写さない)。それより前に承諾した人や、承諾のときに名前が無かった人は NULL のままなので、
// 画面に出す名前は次の順で決める (写した名前は 1 に入るので、後でプロフィールの名前を変えても家族の画面は写した名前のまま):
//   1. family_members.display_name (子供のメンバーや、家族の中での呼び名)
//   2. 本人のプロフィールの今の名前 (user_profiles.nickname。アカウントを持つメンバーだけ)。
//      ただしアプリが「名前が無い」ときに入れる仮置き (PROFILE_NAME_PLACEHOLDER = 'Guest') は名前とみなさない
//      (判定は src/lib/profile-name.ts。ホームの呼びかけ (src/lib/user-display.ts) と同じ。#1611)
//   3. 両方無ければ null (画面は従来どおり「名前未設定」と出す)
//
// 他の家族の user_profiles は RLS で読めないので、2 はサーバー (GET /api/family/members/names) が service_role で
// 名前の列だけを引いて補う。この解決を API の 1 か所にまとめ、画面ごとには書かない。
// 画面 (ブラウザ) は fetchFamilyMemberNames で解決済みの名前を受け取り、applyFamilyMemberNames で自分の一覧に当てる。
//
// このファイルはブラウザからも読むので、サーバー専用のもの (service_role のクライアント・next/headers) を import しない。
import { z } from 'zod';
import { FamilyMemberNamesDataSchema, type FamilyMemberName } from '@/schemas/membership/family-member';
import { PROFILE_NAME_PLACEHOLDER, normalizeName, normalizeProfileName } from '@/lib/profile-name';

/** 名前を返す API の経路 */
export const FAMILY_MEMBER_NAMES_API_PATH = '/api/family/members/names';

/**
 * 名前が決まらないメンバー (display_name もプロフィールの名前も無い) に出す語。家族の 4 画面のリテラルと同じ語
 * (4 画面のリテラルは寄せていない。docs/design/family/10-family-menu-view.md Q-6)。
 * 週間献立の家族の表示の切り替え (FamilyViewSwitcher) と家族の献立の行・注記 (FamilyMenuRows) が使う (同 §12・§16)
 */
export const FAMILY_MEMBER_NAME_FALLBACK = '名前未設定';

/** 名前を返す API の応答 ({ data: { members } }) */
const FamilyMemberNamesResponseSchema = z.object({ data: FamilyMemberNamesDataSchema });

/** 名前を決めるのに使う family_members の列 */
export interface FamilyMemberNameSource {
  id: string;
  user_id: string | null;
  display_name: string | null;
}

/**
 * プロフィールの名前が無いことを表す仮置き ('Guest')。判定は src/lib/profile-name.ts に 1 つにまとめた (#1611。ホームの呼びかけと同じ)。
 * 前後の空白を除いたうえでの厳密一致で、src/app/api/onboarding/status/route.ts も同じ関数 (@homegohan/shared の normalizeProfileName) で判定する (#1635)。
 */
export { PROFILE_NAME_PLACEHOLDER };

/** display_name が無いので、プロフィールの名前を引く必要がある user_id (重複なし。アカウントを持たない子供は除く) */
export function userIdsNeedingProfileName(rows: readonly FamilyMemberNameSource[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (normalizeName(row.display_name) === null && typeof row.user_id === 'string' && row.user_id.length > 0) {
      ids.add(row.user_id);
    }
  }
  return [...ids];
}

/**
 * メンバーごとに画面に出す名前を決める。返すのは id と名前だけ (ほかの列は返さない)。
 * profileNames は user_id → プロフィールの名前 (user_profiles.nickname)。引けなかった人は入っていなくてよい。
 * プロフィールの名前が仮置き ('Guest') の人は、名前が無い人と同じく null にする。
 * display_name の側は仮置きを見ない: display_name にプロフィールの名前を写す RPC は、どれも仮置き・空白だけの名前を写さない
 * (家族の作成 create_family_group は supabase/migrations/20261016200000_rpc_profile_name_placeholder.sql (#1678)、
 *  招待・昇格の承諾は supabase/migrations/20261015170000_accept_copies_profile_name.sql (#1584)。判定は normalizeProfileName と同じ)。
 * 本番の family_members に display_name が 'Guest' の行は無い (2026-10-15 時点。#1678 で数えた) ので、既存の行も書き換えていない。
 */
export function buildFamilyMemberNames(
  rows: readonly FamilyMemberNameSource[],
  profileNames: ReadonlyMap<string, string>,
): FamilyMemberName[] {
  return rows.map((row) => ({
    id: row.id,
    name:
      normalizeName(row.display_name) ??
      (row.user_id ? normalizeProfileName(profileNames.get(row.user_id)) : null),
  }));
}

/** 名前の API の読み取りの結果。ok: false は読めなかった (通信の失敗・非 2xx・JSON でない・形が違う) */
export type FamilyMemberNamesResult =
  | { ok: true; names: Map<string, string> }
  | { ok: false };

/**
 * 解決済みの名前を受け取る (ブラウザから呼ぶ)。読めたときは member id → 名前 (名前が決まった人だけ)。
 * 読めなかったこと (ok: false) を区別する (#2201 U1。取り直しのときは、読めなかったら前の名前を残すため)。例外は投げない
 */
export async function fetchFamilyMemberNamesResult(
  fetchImpl: typeof fetch = fetch,
): Promise<FamilyMemberNamesResult> {
  try {
    const res = await fetchImpl(FAMILY_MEMBER_NAMES_API_PATH, { cache: 'no-store' });
    if (!res.ok) return { ok: false };
    const body: unknown = await res.json();
    const parsed = FamilyMemberNamesResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false };
    const names = new Map<string, string>();
    for (const member of parsed.data.data.members) {
      if (member.name !== null) names.set(member.id, member.name);
    }
    return { ok: true, names };
  } catch {
    // 通信の失敗・JSON でない応答
    return { ok: false };
  }
}

/**
 * 解決済みの名前を受け取る (ブラウザから呼ぶ)。戻り値は member id → 名前 (名前が決まった人だけ)。
 * 名前の補完は表示の改善なので、取得に失敗しても例外を投げず空の Map を返す (画面は display_name のまま出す)。
 * 取り直しで、読めなかったときに前の名前を残すときは fetchFamilyMemberNamesResult と keepShownFamilyMemberNames を使う
 */
export async function fetchFamilyMemberNames(
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const result = await fetchFamilyMemberNamesResult(fetchImpl);
  return result.ok ? result.names : new Map<string, string>();
}

/**
 * 取り直しで名前の API を読めなかったときに当てる名前 (#2201 U1): 読み直した行のうち display_name の無い人に、
 * いま画面に出している名前 (shown。前に名前の API が当てた名前を含む) を当てる。
 * display_name のある人は読み直した display_name のまま (名前の API も display_name を先に使う。buildFamilyMemberNames)。
 * 以前は読めないと空の Map になり、出ていた名前が「名前未設定」に落ちていた
 */
export function keepShownFamilyMemberNames(
  rows: readonly { id: string; display_name: string | null }[],
  shown: readonly { id: string; display_name: string | null }[],
): Map<string, string> {
  const shownNames = new Map<string, string>();
  for (const member of shown) {
    if (member.display_name !== null) shownNames.set(member.id, member.display_name);
  }
  const names = new Map<string, string>();
  for (const row of rows) {
    if (normalizeName(row.display_name) !== null) continue;
    const name = shownNames.get(row.id);
    if (name !== undefined) names.set(row.id, name);
  }
  return names;
}

/** 画面の一覧に、解決済みの名前を当てる (名前が決まっていない人は display_name のまま) */
export function applyFamilyMemberNames<T extends { id: string; display_name: string | null }>(
  members: readonly T[],
  names: ReadonlyMap<string, string>,
): T[] {
  return members.map((member) => {
    const name = names.get(member.id);
    return name === undefined ? member : { ...member, display_name: name };
  });
}
