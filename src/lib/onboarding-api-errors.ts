/**
 * オンボーディングの API (/api/onboarding/progress・/api/onboarding/complete) が返す失敗の本文の文 (#1917)
 *
 * 画面 (src/app/onboarding/questions/complete-flow.ts の parseErrorMessage) は、この文を鍵にして
 * 画面向けの言い回しに置き換える (未知の文は汎用の文にする)。画面のバンドルにも入るので、
 * このファイルはサーバーの部品 (next/server など) を import しない。
 *
 * 401 と JSON が読めない 400 は全 API の共通の文 (src/lib/api/error-responses.ts の API_UNAUTHENTICATED_MESSAGE・
 * API_INVALID_JSON_MESSAGE)。画面の対応表は、その 2 つの文も鍵に持つ (tests/onboarding-complete-flow.test.ts が同じ文であることを確かめる)。
 */

/** 400: 本文の currentStep / answers / totalQuestions の形が違う */
export const ONBOARDING_INVALID_REQUEST_BODY_MESSAGE = '送信内容が正しくありません';
/** 400: 回答 (answers) が OnboardingAnswersSchema に合わない */
export const ONBOARDING_INVALID_ANSWERS_MESSAGE = '入力内容に誤りがあります';
/** 401 (API_UNAUTHENTICATED_MESSAGE と同じ文。画面の対応表の鍵) */
export const ONBOARDING_UNAUTHENTICATED_MESSAGE = 'ログインが必要です';
/** 400: 本文が JSON として読めない (API_INVALID_JSON_MESSAGE と同じ文。画面の対応表の鍵) */
export const ONBOARDING_INVALID_JSON_MESSAGE = 'リクエストボディが不正です';
