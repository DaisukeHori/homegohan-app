// T15 (#1154): 生成の失敗のうち、サーバーが同意の判定で止めたものを、失敗パネルではなく同意画面で案内する
import { handleStoredAiConsentFailure } from '@/lib/ai/consent-required';
import type { AiGenerationAction } from './reducers/aiGenerationReducer';

/**
 * 生成の失敗 (GEN_FAIL) を reducer に渡す前に通す。
 * 失敗の文が「同意が無くてサーバーが止めた」もの (weekly_menu_requests.error_message に書かれた AI_CONSENT_REQUIRED_MESSAGE) なら、
 * 同意画面 (AiConsentRequiredHost) を出し、失敗パネル (generationFailedError) には出さない形 (error: null) に変える
 * (同期の 403 と同じく、同意の案内を出したら自分のエラー表示は出さない)。生成中の表示を消すのは GEN_FAIL のまま行う。
 * GEN_FAIL 以外と、それ以外の失敗の文はそのまま返す。
 */
export function routeAiConsentGenerationFailure(action: AiGenerationAction): AiGenerationAction {
  if (action.type !== 'GEN_FAIL' || !handleStoredAiConsentFailure(action.payload.error)) return action;
  return { type: 'GEN_FAIL', payload: { error: null, requestId: null } };
}
