export const SINGLE_SERVING_PROMPT_GUIDANCE = [
  "- ingredients[].amount_g は必ず1人分の可食量にする（家族人数・作り置き分を掛けない。人数反映は買い物リスト側で行う）",
  "- 主食のご飯は炊飯後の重量で120〜180gを標準、大盛りでも220g以内を目安にする",
  "- 主菜の肉・魚の主材料は通常80〜150g/人、ステーキなど単品主菜でも100〜180g/人を目安にする",
].join("\n");

export function sanitizeGenerationPromptProfile<T extends Record<string, unknown> | null | undefined>(profile: T): T {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return (profile ?? null) as T;
  }

  const sanitized = { ...profile } as Record<string, unknown>;
  delete sanitized.family_size;
  delete sanitized.servings_config;

  return sanitized as T;
}

export function sanitizeGenerationPromptConstraints<T extends Record<string, unknown> | null | undefined>(constraints: T): T {
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
    return (constraints ?? null) as T;
  }

  const sanitized = { ...constraints } as Record<string, unknown>;
  delete sanitized.familySize;
  delete sanitized.family_size;

  return sanitized as T;
}
