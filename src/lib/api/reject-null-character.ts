/**
 * API route の入口で、リクエストの本文 (JSON) の NULL 文字 (U+0000) を 400 で断る (#1657)
 *
 * Postgres の text は U+0000 を保存できず、jsonb も \u0000 を受け付けない (src/lib/api/null-character.ts)。
 * 本文の文字列 (メモ・名前・自由記述・AI への入力など) をそのまま insert / update / upsert / rpc に渡す route は、
 * 本文に NULL 文字があると DB が拒んで 500 になっていた (#1622 で POST /api/ai/menu/weekly/request だけ直した)。
 * 本文 (JSON / テキスト) を読む API route の handler は、だれが呼ぶ route でもこれを最初に呼ぶ。呼ばない handler と
 * その理由は src/__tests__/api/null-character-routes.test.ts の EXCLUDED に載せる (載っていない handler が本文を読むと、そのテストが赤になる)。
 *
 * 使い方 (route の handler の最初で、認証・DB に触れる前に):
 *   const nullCharacterRejection = await rejectNullCharacterBody(request);
 *   if (nullCharacterRejection) return nullCharacterRejection;
 *
 * 本文は request.clone() で読むので、route はこのあと今までどおり request.json() で本文を読める。
 * JSON として読めない本文 (空・壊れた JSON・JSON でない本文) はここでは断らず、null を返して route の既存の扱いに任せる。
 *
 * 本文の形 (shape。#1917 の続き): route がほかの 400 で返す本文と同じ形にする (docs/design/cross/04-api-conventions.md §5.2)。
 *   - 'flat' (既定): { error: '<文>', code: 'INVALID_CHARACTER' }。画面が `data.error` を文字列として出す一般の API 向け
 *   - 'nested': { error: { code: 'INVALID_CHARACTER', message: '<文>' } }。`error.message` を読む画面の API
 *     (運営の admin・super-admin・operator、家族、課金など) 向け。flat のままだと、そうした画面は `json.error?.message` が
 *     undefined になり、既定の文 (「リード作成に失敗しました」など) を出して理由が分からなかった
 *   どの route がどちらの形かは src/__tests__/api/null-character-routes.test.ts の表が決め、route の他の本文の形と食い違わないかも確かめる。
 *   nested の route は `await rejectNullCharacterBody(request, { shape: 'nested' })` と書く
 */
import { NextResponse } from 'next/server';
import { containsNullCharacter, NULL_CHARACTER_ERROR_CODE, NULL_CHARACTER_ERROR_MESSAGE } from './null-character';

/** NULL 文字で断るときの状態コード */
const NULL_CHARACTER_STATUS = 400;

/** 400 の本文の形 (上のコメント参照) */
export type NullCharacterRejectionShape = 'flat' | 'nested';

export interface NullCharacterRejectionOptions {
  /** 本文の形。既定は 'flat' */
  shape?: NullCharacterRejectionShape;
}

export interface NullCharacterRejectionFlatBody {
  error: typeof NULL_CHARACTER_ERROR_MESSAGE;
  code: typeof NULL_CHARACTER_ERROR_CODE;
}

export interface NullCharacterRejectionNestedBody {
  error: { code: typeof NULL_CHARACTER_ERROR_CODE; message: typeof NULL_CHARACTER_ERROR_MESSAGE };
}

/** NULL 文字で断るときの本文 (shape ごと) */
export function nullCharacterRejectionBody(
  shape: NullCharacterRejectionShape = 'flat',
): NullCharacterRejectionFlatBody | NullCharacterRejectionNestedBody {
  return shape === 'nested'
    ? { error: { code: NULL_CHARACTER_ERROR_CODE, message: NULL_CHARACTER_ERROR_MESSAGE } }
    : { error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE };
}

/** 本文のどこかの文字列 (キーを含む) に NULL 文字があれば 400 (INVALID_CHARACTER) の応答を、無ければ null を返す */
export async function rejectNullCharacterBody(
  request: Request,
  options: NullCharacterRejectionOptions = {},
): Promise<NextResponse | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  if (!containsNullCharacter(body)) return null;
  return NextResponse.json(nullCharacterRejectionBody(options.shape), { status: NULL_CHARACTER_STATUS });
}
