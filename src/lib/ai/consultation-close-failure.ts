/**
 * Web の AI 相談 (src/components/AIChatBubble.tsx) の『相談を終了』(POST /api/ai/consultation/sessions/[sessionId]/close) が
 * 失敗の応答 (ok でない) を返したときに、チャットに出す文を決める (#2245 K1)。
 *
 * 以前の Web は res.ok の分岐だけで、失敗の応答では何も知らせなかった (利用者には何も起きなかったように見えた)。
 * 出し分けはモバイルの AIAdvisorSheet の archiveSession と同じ:
 *   - 400 (この相談はすでに終了している): 呼び出し側が一覧を読み直し、『既に終了済み』の文を出す
 *   - 403 の規約・プライバシーポリシーへの同意が必要 (LEGAL_CONSENT_REQUIRED。#1442): 同意の固定の文
 *   - 503 (AI 相談の緊急停止・メンテナンス中。#1148 / #1457): code から決めた固定の文
 *   - それ以外: 固定の失敗の文 (本文の文字列はそのまま出さない)
 * 通信の失敗・応答が読めなかったときも、呼び出し側が固定の失敗の文を出す。
 */
import {
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  LEGAL_CONSENT_REQUIRED_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  serviceUnavailableMessageOfBody,
} from '@homegohan/shared';
import { AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';

/** 閉じる route が「この相談はすでに終了しています」で返す状態コード (src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts) */
export const CONSULTATION_ALREADY_CLOSED_STATUS = 400;

/** 閉じる (/close) が失敗したとき (下の出し分けに当たらない失敗の応答・通信の失敗) にチャットに出す固定の文 */
export const CONSULTATION_CLOSE_FAILED_MESSAGE = '相談を終了できませんでした。しばらくしてから、もう一度お試しください。';

export type ConsultationCloseFailure =
  /** すでに終了していた: 呼び出し側は相談の一覧を読み直してから文を出す */
  | { kind: 'already-closed'; message: string }
  /** そのほかの失敗: 文を出すだけ */
  | { kind: 'failed'; message: string };

function codeOf(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined;
  return (body as { code?: unknown }).code;
}

/**
 * 閉じる (/close) の失敗の応答の状態コード (status) と本文 (body。JSON を読んだもの。読めなければ null) から、チャットに出す文を決める。
 * 例外は投げない
 */
export function consultationCloseFailureOf(status: number, body: unknown): ConsultationCloseFailure {
  if (status === CONSULTATION_ALREADY_CLOSED_STATUS) {
    return { kind: 'already-closed', message: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE };
  }
  if (status === LEGAL_CONSENT_REQUIRED_STATUS && codeOf(body) === LEGAL_CONSENT_REQUIRED_CODE) {
    return { kind: 'failed', message: LEGAL_CONSENT_REQUIRED_MESSAGE };
  }
  if (status === SERVICE_UNAVAILABLE_STATUS) {
    const unavailableMessage = serviceUnavailableMessageOfBody(body);
    if (unavailableMessage) return { kind: 'failed', message: unavailableMessage };
  }
  return { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE };
}
