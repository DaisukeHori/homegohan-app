/**
 * 運営の詳細の画面 (クーポン・機能パッケージ) で、状態の変更のあと (409 のあと・通信の reject のあと) に行を読み直す (#2064・#2073・#2080)。
 *
 * 読み直しの結果を 3 つに分ける (プランの詳細の fetchPlan・A/B テストの詳細の loadExperiment と同じ分け方):
 *   - loaded     : 読み直せた (今の行)
 *   - failed     : 読み直せなかった (500・通信の reject・本文が読めない)。読み込み直せば変わりうるので、画面は「再試行」を出す
 *   - unavailable: 404 (読み直しの間に行が消えた) か 403 (権限が外れた・二段階認証の確認が要るようになった)。
 *                  読み込み直しても変わらないので、画面は理由の文 (message) を出し、「再試行」は出さない (#2080 U8)
 * 403 の文は forbiddenMessageOfResponse で決める (理由の文はそのまま、それ以外は「権限がありません」。英字の内部の文を出さない)。
 */
import { forbiddenMessageOfResponse } from '@/lib/admin/api-error-message';

export type DetailRereadOutcome<T> =
  | { kind: 'loaded'; row: T }
  | { kind: 'failed' }
  | { kind: 'unavailable'; message: string };

/** 読み直しが、読み込み直しても変わらない理由で断られたかを見分ける HTTP ステータス */
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;

/**
 * 詳細の行を読み直す (GET url の本文 { data: 行 })。投げない。
 * notFoundMessage は 404 のときに画面に出す文 (「<もの>が見つかりません。一覧に戻って確かめてください」)
 */
export async function rereadDetailRow<T>(url: string, notFoundMessage: string): Promise<DetailRereadOutcome<T>> {
  try {
    const res = await fetch(url);
    if (res.status === HTTP_NOT_FOUND) return { kind: 'unavailable', message: notFoundMessage };
    if (res.status === HTTP_FORBIDDEN) return { kind: 'unavailable', message: await forbiddenMessageOfResponse(res) };
    if (!res.ok) return { kind: 'failed' };
    const body: unknown = await res.json();
    const row = (body as { data?: T | null } | null)?.data;
    return row === undefined || row === null ? { kind: 'failed' } : { kind: 'loaded', row };
  } catch {
    return { kind: 'failed' };
  }
}
