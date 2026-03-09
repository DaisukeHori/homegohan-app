const PLACEHOLDER_NAMES = new Set([
  '',
  'guest',
  'ゲスト',
  'guest user',
  'ゲストユーザー',
]);

function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function isPlaceholderName(value: string | null | undefined): boolean {
  const normalized = normalizeName(value);
  if (!normalized) return true;
  return PLACEHOLDER_NAMES.has(normalized.toLowerCase());
}

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
  const nickname = normalizeName(input.nickname);
  if (nickname && !isPlaceholderName(nickname)) {
    return nickname;
  }

  const metadataNameCandidates = [
    input.userMetadata?.nickname,
    input.userMetadata?.full_name,
    input.userMetadata?.name,
    input.userMetadata?.display_name,
  ];

  for (const candidate of metadataNameCandidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeName(candidate);
    if (normalized && !isPlaceholderName(normalized)) {
      return normalized;
    }
  }

  return extractEmailName(input.email) ?? null;
}
