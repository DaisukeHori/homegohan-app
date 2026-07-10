// オンボーディング最終回答の確定処理 (OB-API-01/02) を JSX を含まない
// 純粋なモジュールとして切り出したもの。
//
// #1045 round-2 (Sonnet Warning): 完了直前の progress 保存 (/api/onboarding/progress)
// と完了API (/api/onboarding/complete) の呼び出しが res.ok を確認していなかったため、
// スキーマ違反等で progress が 400 を返しても気づかずに complete を呼んでしまっていた。
// complete は user_profiles 行が無い場合「プロフィール不在→デフォルト値 (Guest/unspecified)
// で upsert」する分岐に入るため、入力した全回答が失われたまま完了扱いになる
// (偽の完了成功) 事故につながっていた。
//
// このモジュールは fetch の実行を呼び出し側 (questions/page.tsx) の deps に委譲することで、
// 「progress 保存 → complete の順で呼び、どちらかが失敗したら打ち切る」という
// fail-closed な状態遷移だけを DOM 非依存で単体テストできるようにする。
// (question-flow.ts の pruneStaleAnswers と同じ設計方針)

export interface FinalizeResponseLike {
  ok: boolean;
  json: () => Promise<any>;
}

export interface FinalizeOnboardingDeps {
  saveProgress: () => Promise<FinalizeResponseLike>;
  completeOnboarding: () => Promise<FinalizeResponseLike>;
}

export type FinalizeOnboardingResult =
  | { success: true; nextRoute?: string }
  | { success: false; stage: 'progress' | 'complete' | 'network'; message: string };

export const GENERIC_SAVE_ERROR_MESSAGE =
  '保存に失敗しました。通信環境をご確認のうえ、もう一度お試しください。';

/**
 * API のエラーレスポンス (`{ error: string }`) からユーザー向けメッセージを取り出す。
 * JSON が壊れている・error フィールドが無い場合は汎用メッセージにフォールバックする。
 */
export async function parseErrorMessage(res: FinalizeResponseLike): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string' && data.error.trim().length > 0) {
      return data.error;
    }
  } catch {
    // JSON parse 失敗時は汎用メッセージにフォールバック
  }
  return GENERIC_SAVE_ERROR_MESSAGE;
}

/**
 * #1045 round-2 (Sonnet Warning): progress 保存 → complete の順で呼び出し、
 * どちらかが失敗 (res.ok===false または例外/ネットワークエラー) した時点で処理を打ち切る。
 * 両方成功した場合のみ success:true を返す。呼び出し側はそこで初めて
 * 完了画面への遷移や sessionStorage への next_route 保存を行ってよい
 * (= complete が呼ばれていないので回答は失われず、progress 保存済みの状態が保持される)。
 */
export async function finalizeOnboarding(
  deps: FinalizeOnboardingDeps,
): Promise<FinalizeOnboardingResult> {
  let progressRes: FinalizeResponseLike;
  try {
    progressRes = await deps.saveProgress();
  } catch {
    return { success: false, stage: 'network', message: GENERIC_SAVE_ERROR_MESSAGE };
  }
  if (!progressRes.ok) {
    return { success: false, stage: 'progress', message: await parseErrorMessage(progressRes) };
  }

  let completeRes: FinalizeResponseLike;
  try {
    completeRes = await deps.completeOnboarding();
  } catch {
    return { success: false, stage: 'network', message: GENERIC_SAVE_ERROR_MESSAGE };
  }
  if (!completeRes.ok) {
    return { success: false, stage: 'complete', message: await parseErrorMessage(completeRes) };
  }

  const data = await completeRes.json().catch(() => ({}));
  const nextRoute = typeof data?.next_route === 'string' ? data.next_route : undefined;
  return { success: true, nextRoute };
}
