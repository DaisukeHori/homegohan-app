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

// #1045 round-3 (Fable Suggestion): parseErrorMessage が data.error を無条件に
// そのままユーザーへ表示していたため、/api/onboarding/progress や
// /api/onboarding/complete が 500 で返す Supabase の生エラーメッセージ
// (テーブル名・カラム名等を含み得る) や、想定外の英語のみの例外メッセージまで
// 画面に露出してしまっていた。API 側が意図的に返す既知のエラーコードのみ
// 許可リストで通し、それ以外 (内部実装依存の文字列) は汎用日本語メッセージに
// フォールバックする。
//
// #1045 round-4 (Fable Suggestion): 上記の許可リストは既知コードを「英語のまま」
// 素通ししていたため、resume/page.tsx 等 API を意識しないユーザー向け画面にまで
// 英語のエラーコードがそのまま表示され得た。既知コード→日本語メッセージの
// マッピング方式に変更し、progress/route.ts (Unauthorized / Invalid JSON /
// Invalid request body / Invalid answers) と complete/route.ts (Failed to
// initialize profile) が意図的に返す固定コードすべてを日本語化する。
// 未知の文字列 (Supabase の生エラー等) は従来どおり汎用メッセージにフォールバック。
export const KNOWN_CLIENT_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['Unauthorized', 'セッションが切れました。お手数ですが再度ログインしてください。'],
  ['Invalid JSON', '送信内容の読み込みに失敗しました。ページを再読み込みしてもう一度お試しください。'],
  ['Invalid request body', '送信内容が正しくありません。ページを再読み込みしてもう一度お試しください。'],
  ['Invalid answers', '入力内容に誤りがあります。ご確認のうえもう一度お試しください。'],
  ['Failed to initialize profile', 'プロフィールの初期化に失敗しました。もう一度お試しください。'],
]);

/**
 * API のエラーレスポンス (`{ error: string }`) からユーザー向けメッセージを取り出す。
 * JSON が壊れている・error フィールドが無い・許可リスト外の (内部実装依存の) 文字列の
 * 場合は汎用メッセージにフォールバックする。許可リスト内のコードは対応する
 * 日本語メッセージに変換して返す (英語コードをそのまま画面に出さない)。
 */
export async function parseErrorMessage(res: FinalizeResponseLike): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') {
      const mapped = KNOWN_CLIENT_ERROR_MESSAGES.get(data.error);
      if (mapped) {
        return mapped;
      }
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
