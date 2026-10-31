/**
 * 運営の詳細の画面 (クーポン・機能パッケージ) で、状態の変更のあと (409 のあと・通信の reject のあと) に行を読み直す (#2064・#2073・#2080)。
 *
 * 読み直しの結果を 3 つに分ける (プランの詳細の fetchPlan・A/B テストの詳細の loadExperiment・一覧の loadExperiments も
 * rereadUnavailableMessage で同じ分け方にする。#2086 V4):
 *   - loaded     : 読み直せた (今の行)
 *   - failed     : 読み直せなかった (500・通信の reject・本文が読めない)。読み込み直せば変わりうるので、画面は「再試行」を出す
 *   - unavailable: 404 (読み直しの間に行が消えた)・403 (権限が外れた・二段階認証の確認が要るようになった)・
 *                  401 (ログインが切れた。#2086 V4)。読み込み直しても変わらないので、画面は理由の文 (message) を出し、
 *                  「再試行」は出さない (#2080 U8)
 * 403 の文は forbiddenMessageForScreen で決める (理由の文はそのまま、それ以外は「権限がありません」。英字の内部の文を出さない)。
 * 401 の文は固定の「ログインし直してください」(手動のプラン付与の読み直しの 401 と同じ文。#2086 V4)。
 */
import { UNAUTHENTICATED_SCREEN_MESSAGE, forbiddenMessageForScreen } from '@/lib/admin/api-error-message';

export type DetailRereadOutcome<T> =
  | { kind: 'loaded'; row: T }
  | { kind: 'failed' }
  | { kind: 'unavailable'; message: string };

/** 読み直しが、読み込み直しても変わらない理由で断られたかを見分ける HTTP ステータス */
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/**
 * 読み直しの失敗の応答が、読み込み直しても変わらない理由 (unavailable) かを決め、画面に出す理由の文を返す。
 * unavailable でない (500 など。「再試行」で変わりうる) ときは null。
 *   - 401: 「ログインし直してください」
 *   - 403: forbiddenMessageForScreen (理由の文 (二段階認証の確認が要る など) はそのまま、それ以外は「権限がありません」)
 *   - 404: notFoundMessage (一覧の読み直しのように 404 が行の消えたことを意味しない読み直しは null を渡し、404 も failed にする)
 * body は失敗の応答の本文 (JSON として読めなければ null)
 */
export function rereadUnavailableMessage(status: number, body: unknown, notFoundMessage: string | null): string | null {
  if (status === HTTP_UNAUTHORIZED) return UNAUTHENTICATED_SCREEN_MESSAGE;
  if (status === HTTP_FORBIDDEN) return forbiddenMessageForScreen(body);
  if (status === HTTP_NOT_FOUND) return notFoundMessage;
  return null;
}

/**
 * 詳細の行を読み直す (GET url の本文 { data: 行 })。投げない。
 * notFoundMessage は 404 のときに画面に出す文 (「<もの>が見つかりません。一覧に戻って確かめてください」)。
 * null なら 404 も failed にする (価格の変更の読み直しのように、404 を読み込み直しても変わらない理由として扱わない読み直し。#2101 integrity-1030c)
 */
export async function rereadDetailRow<T>(url: string, notFoundMessage: string | null): Promise<DetailRereadOutcome<T>> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // 本文が JSON として読めなくても (プロキシの HTML など) 理由の文を決められるよう、読めない本文は null にする
      const body: unknown = await res.json().catch(() => null);
      const message = rereadUnavailableMessage(res.status, body, notFoundMessage);
      return message === null ? { kind: 'failed' } : { kind: 'unavailable', message };
    }
    const body: unknown = await res.json();
    const row = (body as { data?: T | null } | null)?.data;
    return row === undefined || row === null ? { kind: 'failed' } : { kind: 'loaded', row };
  } catch {
    return { kind: 'failed' };
  }
}
