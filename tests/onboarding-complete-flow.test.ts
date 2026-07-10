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
  type FinalizeResponseLike,
} from "../src/app/onboarding/questions/complete-flow";

function makeResponse(ok: boolean, body: unknown = {}): FinalizeResponseLike {
  return {
    ok,
    json: async () => body,
  };
}

describe("finalizeOnboarding — fail-closed 動作", () => {
  it("progress 保存が 400 を返した場合、complete は呼ばれず success:false を返す (回答喪失+偽の完了成功を防ぐ)", async () => {
    const saveProgress = vi.fn().mockResolvedValue(
      makeResponse(false, { error: "Invalid answers" }),
    );
    const completeOnboarding = vi.fn().mockResolvedValue(makeResponse(true, { next_route: "/home" }));

    const result = await finalizeOnboarding({ saveProgress, completeOnboarding });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.stage).toBe("progress");
      expect(result.message).toBe("Invalid answers");
    }
    // #1045 round-2: progress が失敗した時点で complete を呼んではいけない
    // (呼んでしまうと profile 不在時にデフォルト値で upsert され、回答が失われる)
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("progress は成功したが complete が失敗した場合、success:false を返し画面遷移させない", async () => {
    const saveProgress = vi.fn().mockResolvedValue(makeResponse(true, { success: true }));
    const completeOnboarding = vi.fn().mockResolvedValue(
      makeResponse(false, { error: "Internal error" }),
    );

    const result = await finalizeOnboarding({ saveProgress, completeOnboarding });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.stage).toBe("complete");
      expect(result.message).toBe("Internal error");
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
  it("error フィールドがある場合はそのメッセージを返す", async () => {
    const res = makeResponse(false, { error: "Invalid answers" });
    await expect(parseErrorMessage(res)).resolves.toBe("Invalid answers");
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
});
