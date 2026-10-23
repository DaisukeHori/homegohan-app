/**
 * tests/onboarding-complete-flow.test.ts
 *
 * Issue #1045 round-2 (Sonnet Warning): questions/page.tsx の最終確定処理が
 * progress 保存 / complete API の res.ok を確認せず、失敗時も無言で完了扱いに
 * していたため、スキーマ違反等で progress が 400 を返すと
 *   (a) 回答が user_profiles に保存されない
 *   (b) complete が「プロフィール不在→デフォルト値 (Guest/unspecified) で upsert」
 *       分岐に入り、入力した全回答が失われる
 *   (c) それでも画面は完了成功として遷移する (偽の完了成功)
 * という事故になっていた。
 *
 * src/app/onboarding/questions/complete-flow.ts の finalizeOnboarding() が
 * fail-closed (どちらかが失敗したら complete 側を呼ばない/成功扱いにしない) に
 * なっていることを検証する。
 */

import { describe, expect, it, vi } from "vitest";
import {
  finalizeOnboarding,
  parseErrorMessage,
  GENERIC_SAVE_ERROR_MESSAGE,
  KNOWN_CLIENT_ERROR_MESSAGES,
  type FinalizeResponseLike,
} from "../src/app/onboarding/questions/complete-flow";
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from "../src/lib/api/error-responses";
import {
  ONBOARDING_INVALID_ANSWERS_MESSAGE,
  ONBOARDING_INVALID_JSON_MESSAGE,
  ONBOARDING_INVALID_REQUEST_BODY_MESSAGE,
  ONBOARDING_UNAUTHENTICATED_MESSAGE,
} from "../src/lib/onboarding-api-errors";

// #1045 round-4: 許可リストのコードは日本語メッセージにマッピングされるため、
// 期待値は KNOWN_CLIENT_ERROR_MESSAGES から取得し、マッピング内容の変更と
// テスト側のハードコードがズレないようにする。
function mappedMessage(code: string): string {
  const message = KNOWN_CLIENT_ERROR_MESSAGES.get(code);
  if (!message) throw new Error(`test setup error: unmapped code "${code}"`);
  return message;
}

function makeResponse(ok: boolean, body: unknown = {}): FinalizeResponseLike {
  return {
    ok,
    json: async () => body,
  };
}

describe("finalizeOnboarding — fail-closed 動作", () => {
  it("progress 保存が 400 を返した場合、complete は呼ばれず success:false を返す (回答喪失+偽の完了成功を防ぐ)", async () => {
    const saveProgress = vi.fn().mockResolvedValue(
      makeResponse(false, { error: ONBOARDING_INVALID_ANSWERS_MESSAGE }),
    );
    const completeOnboarding = vi.fn().mockResolvedValue(makeResponse(true, { next_route: "/home" }));

    const result = await finalizeOnboarding({ saveProgress, completeOnboarding });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.stage).toBe("progress");
      // #1045 round-4: 許可リストのコードは日本語メッセージにマッピングされて返る
      expect(result.message).toBe(mappedMessage(ONBOARDING_INVALID_ANSWERS_MESSAGE));
    }
    // #1045 round-2: progress が失敗した時点で complete を呼んではいけない
    // (呼んでしまうと profile 不在時にデフォルト値で upsert され、回答が失われる)
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("progress は成功したが complete が失敗した場合、success:false を返し画面遷移させない", async () => {
    const saveProgress = vi.fn().mockResolvedValue(makeResponse(true, { success: true }));
    // #1045 round-3 (Fable Suggestion): "Internal error" は API (route.ts) が実際に
    // 返すことのある固定コードではなく (実際は Supabase の生エラーメッセージ等)、
    // parseErrorMessage の許可リスト外なので汎用メッセージにフォールバックされる。
    const completeOnboarding = vi.fn().mockResolvedValue(
      makeResponse(false, { error: "Internal error" }),
    );

    const result = await finalizeOnboarding({ saveProgress, completeOnboarding });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.stage).toBe("complete");
      expect(result.message).toBe(GENERIC_SAVE_ERROR_MESSAGE);
    }
    expect(saveProgress).toHaveBeenCalledOnce();
    expect(completeOnboarding).toHaveBeenCalledOnce();
  });

  it("progress / complete が両方成功した場合のみ success:true を返し、next_route を伝播する", async () => {
    const saveProgress = vi.fn().mockResolvedValue(makeResponse(true, { success: true }));
    const completeOnboarding = vi.fn().mockResolvedValue(
      makeResponse(true, { success: true, next_route: "/handson-tour" }),
    );

    const result = await finalizeOnboarding({ saveProgress, completeOnboarding });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.nextRoute).toBe("/handson-tour");
    }
  });

  it("progress の fetch 自体が例外を投げた場合 (ネットワークエラー) も complete は呼ばれず success:false", async () => {
    const saveProgress = vi.fn().mockRejectedValue(new Error("network down"));
    const completeOnboarding = vi.fn();

    const result = await finalizeOnboarding({ saveProgress, completeOnboarding });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.stage).toBe("network");
      expect(result.message).toBe(GENERIC_SAVE_ERROR_MESSAGE);
    }
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("complete の json() が next_route を含まない場合は nextRoute が undefined になる", async () => {
    const saveProgress = vi.fn().mockResolvedValue(makeResponse(true, {}));
    const completeOnboarding = vi.fn().mockResolvedValue(makeResponse(true, { success: true }));

    const result = await finalizeOnboarding({ saveProgress, completeOnboarding });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.nextRoute).toBeUndefined();
    }
  });
});

describe("parseErrorMessage", () => {
  // #1045 round-4 (Fable Suggestion): 許可リストの文は対応する画面向けの日本語メッセージにマッピングされる
  // (progress/route.ts が返す 4 種)。#1917: API は英語の固定コードをやめ、日本語の固定の文を返す
  // (src/lib/onboarding-api-errors.ts と src/lib/api/error-responses.ts)。鍵はその文。
  it("error フィールドが既知の文 (API が意図的に返すもの) の場合は対応する日本語メッセージを返す", async () => {
    const res = makeResponse(false, { error: ONBOARDING_INVALID_ANSWERS_MESSAGE });
    await expect(parseErrorMessage(res)).resolves.toBe(mappedMessage(ONBOARDING_INVALID_ANSWERS_MESSAGE));
    expect(mappedMessage(ONBOARDING_INVALID_ANSWERS_MESSAGE)).toBe("入力内容に誤りがあります。ご確認のうえもう一度お試しください。");
  });

  it("対応表の鍵は、progress/route.ts が返す 4 種の文と同じ (401・JSON は全 API の共通の文)", () => {
    expect(ONBOARDING_UNAUTHENTICATED_MESSAGE).toBe(API_UNAUTHENTICATED_MESSAGE);
    expect(ONBOARDING_INVALID_JSON_MESSAGE).toBe(API_INVALID_JSON_MESSAGE);
    expect([...KNOWN_CLIENT_ERROR_MESSAGES.keys()].sort()).toEqual(
      [
        API_UNAUTHENTICATED_MESSAGE,
        API_INVALID_JSON_MESSAGE,
        ONBOARDING_INVALID_REQUEST_BODY_MESSAGE,
        ONBOARDING_INVALID_ANSWERS_MESSAGE,
      ].sort(),
    );
  });

  it("以前の英語の固定コードは、もう鍵ではない (API が返さないので汎用メッセージ)", async () => {
    for (const code of ["Unauthorized", "Invalid JSON", "Invalid request body", "Invalid answers", "Failed to initialize profile"]) {
      await expect(parseErrorMessage(makeResponse(false, { error: code }))).resolves.toBe(GENERIC_SAVE_ERROR_MESSAGE);
    }
  });

  it("既知の文 4 種すべてが画面向けの日本語メッセージにマッピングされている", async () => {
    for (const code of [
      API_UNAUTHENTICATED_MESSAGE,
      API_INVALID_JSON_MESSAGE,
      ONBOARDING_INVALID_REQUEST_BODY_MESSAGE,
      ONBOARDING_INVALID_ANSWERS_MESSAGE,
    ]) {
      const res = makeResponse(false, { error: code });
      const message = await parseErrorMessage(res);
      expect(message).toBe(mappedMessage(code));
      // 英語コードそのものが画面に出ないことを保証する
      expect(message).not.toBe(code);
    }
  });

  it("JSON parse に失敗した場合は汎用メッセージにフォールバックする", async () => {
    const res: FinalizeResponseLike = {
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    };
    await expect(parseErrorMessage(res)).resolves.toBe(GENERIC_SAVE_ERROR_MESSAGE);
  });

  it("error フィールドが空文字の場合も汎用メッセージにフォールバックする", async () => {
    const res = makeResponse(false, { error: "" });
    await expect(parseErrorMessage(res)).resolves.toBe(GENERIC_SAVE_ERROR_MESSAGE);
  });

  // #1045 round-3 (Fable Suggestion): 許可リスト外の error (Supabase の生エラー
  // メッセージや想定外の例外メッセージ) は、内部実装の詳細をそのままユーザーに
  // 見せないよう汎用日本語メッセージにフォールバックする。
  it("許可リスト外の error (Supabase の生メッセージ相当) は汎用メッセージにフォールバックする", async () => {
    const res = makeResponse(false, {
      error: 'duplicate key value violates unique constraint "user_profiles_pkey"',
    });
    await expect(parseErrorMessage(res)).resolves.toBe(GENERIC_SAVE_ERROR_MESSAGE);
  });

  it("許可リスト外の英語例外メッセージも汎用メッセージにフォールバックする", async () => {
    const res = makeResponse(false, { error: "Cannot read properties of undefined (reading 'id')" });
    await expect(parseErrorMessage(res)).resolves.toBe(GENERIC_SAVE_ERROR_MESSAGE);
  });
});
