/**
 * e2e で本物の AI を呼ぶ手順 (AI 相談の送信・食事写真の解析) を流してよいか (#1909 の後片付け)
 *
 * .github/workflows/e2e.yml は PR のたびに本番の URL へ MVP スイート (01〜05) を流す。以前は 03-ai-advisor が毎回
 * 本番の AI 相談へ「こんにちは」を送り、本番の AI の回数と原価を PR の数だけ消費していた (10/07 の #1265 で
 * 本番向けのジョブがログインまで通るようになってから)。
 * AI を呼ぶ手順は、この変数が '1' のときだけ流す。e2e.yml は手動の実行 (workflow_dispatch) のときだけ '1' にする。
 * PR の実行とローカルの既定では、AI を呼ばない確認 (画面が開き入力できるところまで) にとどめる。
 */
export const E2E_ALLOW_AI_CALLS_ENV = "E2E_ALLOW_AI_CALLS";

/** 本物の AI を呼ぶ手順を流してよい値 (これ以外の値・未設定は流さない) */
const ALLOW_VALUE = "1";

export function isAiCallAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env[E2E_ALLOW_AI_CALLS_ENV] === ALLOW_VALUE;
}

/** AI を呼ぶ手順を流さないときの理由 (skip の注記に使う) */
export const AI_CALLS_DISABLED_REASON = `${E2E_ALLOW_AI_CALLS_ENV}=1 のときだけ本物の AI を呼ぶ (PR の実行では本番の AI を消費しない。#1909)`;
