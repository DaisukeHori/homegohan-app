/**
 * Edge Function の catch で、応答の本文に入れてよい例外の文を選ぶ (#1444 CodeQL js/stack-trace-exposure)。
 *
 * 利用者の JWT で直接呼べる関数 (generate-menu-v4 / generate-menu-v5 など) は、catch した例外の message を
 * そのまま本文に返すと、DB・上流の AI の API・内部の処理の文が呼び出した人に見える。
 * 本文に出してよいのは、入力の誤りとして投げた PublicRequestError の文と、変数名を含まない固定の文の
 * MissingEnvError (_shared/missing-env.ts。#1467) だけにし、それ以外は固定の文にする (中身はログにだけ残す)。
 *
 * このファイルは missing-env.ts しか import しない (Deno と vitest の両方から読む)。
 */
import { isMissingEnvError } from "./missing-env.ts";

/** 内部のエラーのときに本文に入れる固定の文 */
export const INTERNAL_ERROR_PUBLIC_MESSAGE = "Internal server error";

/**
 * 呼び出し元に文をそのまま返してよい例外 (入力の誤り・必須の値が無い など)。
 * message には利用者が送った値や内部の情報を入れず、固定の文だけにする。
 */
export class PublicRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicRequestError";
  }
}

/** 応答の本文に入れる文。PublicRequestError・MissingEnvError はその文、それ以外は INTERNAL_ERROR_PUBLIC_MESSAGE */
export function publicErrorMessage(error: unknown): string {
  if (error instanceof PublicRequestError || isMissingEnvError(error)) return error.message;
  return INTERNAL_ERROR_PUBLIC_MESSAGE;
}
