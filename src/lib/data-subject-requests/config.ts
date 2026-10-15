// src/lib/data-subject-requests/config.ts
import { resolveDsrResponseDueDays } from '@/lib/data-subject-requests/core';

/** 応答期限 (日)。環境変数 DSR_RESPONSE_DUE_DAYS、不正・未設定なら既定 30 (core.ts の resolveDsrResponseDueDays) */
export function getDsrResponseDueDays(): number {
  return resolveDsrResponseDueDays(process.env.DSR_RESPONSE_DUE_DAYS);
}
