// ホームの呼びかけに出す名前を決める。
// プロフィールの名前が「名前が無い」かどうかは src/lib/profile-name.ts の判定 1 つを使う (#1611。家族の画面と同じ)。
// 以前はここだけ 'guest' (大小無視)・'ゲスト'・'guest user'・'ゲストユーザー' も仮置き扱いにしていたが、アプリと RPC が
// 入れる仮置きは 'Guest' だけで、それ以外は本人が付けた名前なので、そのまま出す。
import { normalizeProfileName } from '@/lib/profile-name';

function extractEmailName(email: string | null | undefined): string | null {
  if (!email?.includes('@')) return null;
  const localPart = email.split('@')[0]?.trim();
  return localPart || null;
}

export function resolveDisplayName(input: {
  nickname?: string | null;
  email?: string | null;
  userMetadata?: Record<string, unknown> | null;
}): string | null {
  const nickname = normalizeProfileName(input.nickname);
  if (nickname) {
    return nickname;
  }

  const metadataNameCandidates = [
    input.userMetadata?.nickname,
    input.userMetadata?.full_name,
    input.userMetadata?.name,
    input.userMetadata?.display_name,
  ];

  for (const candidate of metadataNameCandidates) {
    const normalized = normalizeProfileName(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return extractEmailName(input.email) ?? null;
}
