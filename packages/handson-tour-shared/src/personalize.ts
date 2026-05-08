// placeholder 置換 helper
// Canonical: docs/design/family/09-onboarding-handson-tour/14-mocks-i18n.md §2.5 §3.2
//
// 対応 placeholder:
//   {nickname}               - 30 文字超の場合は truncate + … フォールバック
//   {target_kcal}
//   {percent}
//   {exclude_list}
//   {cooking_experience_text}
//   {current}
//   {total}
//
// 残った {…} は後続テストで検出するためそのまま保持する。

const NICKNAME_MAX_LENGTH = 30;

/**
 * template 文字列の {key} を vars の値で置換する。
 * nickname が 30 文字超の場合は truncate + "…" に正規化する。
 * 置換されなかった {key} はそのまま残す。
 */
export function personalize(
  template: string,
  vars: Record<string, string | number>,
): string {
  const resolved = { ...vars };

  // nickname の truncate (§14 §3.2)
  if (typeof resolved['nickname'] === 'string') {
    const nick = resolved['nickname'];
    if (nick.length > NICKNAME_MAX_LENGTH) {
      resolved['nickname'] = nick.slice(0, NICKNAME_MAX_LENGTH) + '…';
    }
  }

  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    if (key in resolved) {
      return String(resolved[key]);
    }
    return match;
  });
}
