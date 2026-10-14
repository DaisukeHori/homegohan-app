/**
 * 写真の「オート」の判別 (POST /api/ai/classify-photo) が「判別できなかった」(422) ときの本文を読む (#1487。モバイル)
 *
 * サーバーは写真の種類を判別できないと 422 { error: 'unknown_type', message, type, confidence, candidates, aiUsageGrant? } を返す。
 * 判別は AI へ送ったあとなので 1 回数え済みで、その「数え済みの印」(aiUsageGrant) が本文に入る。
 * 画面は Web (src/app/(main)/meals/new/page.tsx の classifyPhoto) と同じく、印を拾って「判別できませんでした」の画面へ進み、
 * 種類を手で選んだ解析 (analyze-*) の本文に印を入れて送る (その解析を 2 回目として数えないため。#1149)。
 *
 * @homegohan/core の createHttpClient は HTTP のエラーを `HTTP 422 Unprocessable Entity: {...}` の Error にして投げるので、
 * その message から本文を取り出す (api-error.ts / ai-daily-limit.ts と同じ形)。
 */

/** 判別できなかったときの HTTP の状態 (Unprocessable Entity。src/app/api/ai/classify-photo/route.ts) */
export const CLASSIFY_PHOTO_UNKNOWN_TYPE_STATUS = 422;

// "HTTP 422 Unprocessable Entity: {...}" / HTTP/2 で statusText が空の "HTTP 422 : {...}" (api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

export interface ClassifyPhotoCandidate {
  type: string;
  confidence: number;
}

/** 判別できなかった (422) ときの本文から、画面が使うもの */
export interface ClassifyPhotoFailure {
  /** 数え済みの印 (返っていなければ null。数えていない・判定に失敗した) */
  aiUsageGrant: string | null;
  /** AI が出した種類 (無ければ 'unknown') */
  type: string;
  /** 確からしさ (無ければ 0) */
  confidence: number;
  /** 種類の候補 */
  candidates: ClassifyPhotoCandidate[];
}

function candidatesOf(value: unknown): ClassifyPhotoCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { type, confidence } = item as { type?: unknown; confidence?: unknown };
    if (typeof type !== "string") return [];
    return [{ type, confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0 }];
  });
}

/**
 * API クライアントが投げた Error が、判別の「判別できなかった」(422) なら、その本文から画面が使うものを返す。
 * それ以外 (ほかの状態・JSON でない本文・通信の失敗) は null (呼び出し側は今までどおり失敗として扱う)。
 */
export function classifyPhotoFailureOf(error: unknown): ClassifyPhotoFailure | null {
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string") return null;
  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (!match || Number(match[1]) !== CLASSIFY_PHOTO_UNKNOWN_TYPE_STATUS) return null;
  let body: unknown;
  try {
    body = JSON.parse(match[2]);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { aiUsageGrant, type, confidence, candidates } = body as {
    aiUsageGrant?: unknown;
    type?: unknown;
    confidence?: unknown;
    candidates?: unknown;
  };
  return {
    aiUsageGrant: typeof aiUsageGrant === "string" ? aiUsageGrant : null,
    type: typeof type === "string" ? type : "unknown",
    confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0,
    candidates: candidatesOf(candidates),
  };
}
