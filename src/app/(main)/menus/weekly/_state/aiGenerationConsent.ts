// T15 (#1154): 生成の失敗のうち、サーバーが同意の判定で止めたものを、失敗パネルではなく同意画面で案内する
import { useEffect, type Dispatch } from 'react';
import { aiConsentReasonOfStoredError } from '@/lib/ai/consent-config';
import { handleStoredAiConsentFailure } from '@/lib/ai/consent-required';
import type { AiGenerationAction } from './reducers/aiGenerationReducer';

/**
 * 失敗パネルに出す生成の失敗の文を返す (aiGeneration の generationFailedError を渡す)。
 * 失敗の文が「同意が無くてサーバーが止めた」もの (weekly_menu_requests.error_message に書かれた AI_CONSENT_REQUIRED_MESSAGE) なら、
 * 同意画面 (AiConsentRequiredHost) を出して失敗をクリアし (GEN_FAILED_CLEAR)、null を返す (失敗パネルを出さない)。
 * 同期の 403 と同じく、同意の案内を出したら自分のエラー表示は出さない。
 * 失敗を出す経路 (onError・復元・Realtime・ポーリング) はどれも GEN_FAIL で generationFailedError に入るので、ここ 1 か所で見分ける。
 */
export function useAiConsentGenerationFailure(
  generationFailedError: string | null,
  dispatch: Dispatch<AiGenerationAction>,
): string | null {
  useEffect(() => {
    if (handleStoredAiConsentFailure(generationFailedError)) dispatch({ type: 'GEN_FAILED_CLEAR' });
  }, [generationFailedError, dispatch]);
  return aiConsentReasonOfStoredError(generationFailedError) === 'consent_required' ? null : generationFailedError;
}
