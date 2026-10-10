/**
 * T15 (#1154) アプリ: AI の API に「同意が必要です」(403 AI_CONSENT_REQUIRED) で止められたときに、同意画面へ案内する
 *
 *   - getApi() が投げるエラー ("HTTP 403 Forbidden: {...}") と、fetch を直接使う画面のエラー ("HTTP 403: {...}") の両方を見分ける
 *   - ほかの 403・503 (判定に失敗)・通信エラーは見分けない (それぞれの画面のエラー表示に任せる)
 *   - 案内は「同意画面を開く」で /settings/ai-consent へ移る。短い間に何度呼ばれても 1 回だけ出す
 *   - beforeOpenConsentScreen を渡すと、「同意画面を開く」を押したときに、移る前に呼ぶ (下に開いたままのモーダルを閉じるため)。
 *     handleAiConsentRequiredError にも同じものを渡せる (modal で開く画面が、自分を閉じてから移るため)
 */
import { Alert } from "react-native";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));

import {
  AI_CONSENT_SCREEN_PATH,
  handleAiConsentRequiredError,
  handleStoredAiConsentFailure,
  isAiConsentRequiredError,
  isAiConsentRequiredResponse,
  promptAiConsentRequired,
  resetAiConsentPromptForTests,
} from "../../src/lib/ai-consent";
import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_MESSAGE,
} from "../../../../supabase/functions/_shared/ai-consent";

const body = JSON.stringify({ error: "AI 機能を使うには同意が必要です", code: "AI_CONSENT_REQUIRED" });

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsentPromptForTests();
});

describe("isAiConsentRequiredError", () => {
  it("getApi() のエラーと、fetch を直接使う画面のエラーの両方を見分ける", () => {
    expect(isAiConsentRequiredError(new Error(`HTTP 403 Forbidden: ${body}`))).toBe(true);
    expect(isAiConsentRequiredError(new Error(`HTTP 403 : ${body}`))).toBe(true);
    expect(isAiConsentRequiredError(new Error(`HTTP 403: ${body}`))).toBe(true);
  });

  it("ほかの 403・503・通信エラー・エラーでない値は見分けない", () => {
    expect(isAiConsentRequiredError(new Error('HTTP 403 Forbidden: {"error":"Forbidden"}'))).toBe(false);
    expect(
      isAiConsentRequiredError(new Error('HTTP 503 Service Unavailable: {"error":"x","code":"AI_CONSENT_CHECK_FAILED"}')),
    ).toBe(false);
    expect(isAiConsentRequiredError(new Error(`HTTP 500 Internal Server Error: ${body}`))).toBe(false);
    expect(isAiConsentRequiredError(new Error("HTTP 403 Forbidden: not json"))).toBe(false);
    expect(isAiConsentRequiredError(new Error("通信できません"))).toBe(false);
    expect(isAiConsentRequiredError(null)).toBe(false);
    expect(isAiConsentRequiredError("HTTP 403")).toBe(false);
  });
});

describe("isAiConsentRequiredResponse", () => {
  it("403 + AI_CONSENT_REQUIRED だけを見分け、本文はあとで読める", async () => {
    const res = new Response(body, { status: 403 });
    await expect(isAiConsentRequiredResponse(res)).resolves.toBe(true);
    await expect(res.json()).resolves.toMatchObject({ code: "AI_CONSENT_REQUIRED" });
    await expect(isAiConsentRequiredResponse(new Response('{"error":"x"}', { status: 403 }))).resolves.toBe(false);
    await expect(isAiConsentRequiredResponse(new Response(body, { status: 200 }))).resolves.toBe(false);
  });
});

describe("handleAiConsentRequiredError / promptAiConsentRequired", () => {
  it("同意が必要なら案内を出して true。「同意画面を開く」で /settings/ai-consent へ移る", () => {
    expect(handleAiConsentRequiredError(new Error(`HTTP 403 Forbidden: ${body}`))).toBe(true);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0] as [
      string,
      string,
      Array<{ text: string; onPress?: () => void }>,
    ];
    expect(title).toBe("同意が必要です");
    const open = buttons.find((b) => b.text === "同意画面を開く");
    expect(open).toBeDefined();
    open!.onPress!();
    expect(mockPush).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
    expect(AI_CONSENT_SCREEN_PATH).toBe("/settings/ai-consent");
  });

  it("同意が必要でなければ何もしないで false (画面のエラー表示に任せる)", () => {
    expect(handleAiConsentRequiredError(new Error("通信できません"))).toBe(false);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("短い間に何度呼ばれても、案内は 1 回だけ", () => {
    promptAiConsentRequired();
    promptAiConsentRequired();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it("beforeOpenConsentScreen は「同意画面を開く」を押したときに、同意画面へ移る前に呼ぶ。「閉じる」では呼ばない (編集中のモーダルを閉じない)", () => {
    const beforeOpenConsentScreen = jest.fn();
    promptAiConsentRequired({ beforeOpenConsentScreen });
    // 案内を出しただけでは呼ばない (案内の下のモーダルは、まだ開いたまま)
    expect(beforeOpenConsentScreen).not.toHaveBeenCalled();
    const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0] as [
      string,
      string,
      Array<{ text: string; style?: string; onPress?: () => void }>,
    ];
    // 「閉じる」は何もしない (モーダルを閉じない・同意画面へ移らない)
    const close = buttons.find((b) => b.text === "閉じる");
    expect(close?.style).toBe("cancel");
    close?.onPress?.();
    expect(beforeOpenConsentScreen).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();

    buttons.find((b) => b.text === "同意画面を開く")!.onPress!();
    expect(beforeOpenConsentScreen).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
    // モーダルを閉じてから移る (移ってから閉じると、移る瞬間に同意画面がモーダルの下に入る)
    expect(beforeOpenConsentScreen.mock.invocationCallOrder[0]).toBeLessThan(mockPush.mock.invocationCallOrder[0]);
  });

  it("handleAiConsentRequiredError も案内の出し方 (beforeOpenConsentScreen) を受け取り、「同意画面を開く」で移る前に呼ぶ (modal で開く画面 meals/new のため)", () => {
    const beforeOpenConsentScreen = jest.fn();
    expect(handleAiConsentRequiredError(new Error(`HTTP 403 Forbidden: ${body}`), { beforeOpenConsentScreen })).toBe(true);
    expect(beforeOpenConsentScreen).not.toHaveBeenCalled();
    const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0] as [
      string,
      string,
      Array<{ text: string; onPress?: () => void }>,
    ];
    buttons.find((b) => b.text === "同意画面を開く")!.onPress!();
    expect(beforeOpenConsentScreen).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
    expect(beforeOpenConsentScreen.mock.invocationCallOrder[0]).toBeLessThan(mockPush.mock.invocationCallOrder[0]);
    // 同意が必要でない失敗では、案内も出さず、渡した関数も呼ばない
    jest.clearAllMocks();
    resetAiConsentPromptForTests();
    expect(handleAiConsentRequiredError(new Error("通信できません"), { beforeOpenConsentScreen })).toBe(false);
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(beforeOpenConsentScreen).not.toHaveBeenCalled();
  });
});

describe("handleStoredAiConsentFailure (受け付けたあとの失敗に保存された文。T15 / #1154)", () => {
  it("サーバーが同意の判定で止めた文なら、案内を出して true (画面は自分のエラー表示を出さない)", () => {
    expect(handleStoredAiConsentFailure(AI_CONSENT_REQUIRED_MESSAGE)).toBe(true);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith("同意が必要です", AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array));
  });

  it("案内の出し方を渡せば、それを呼ぶ (モーダルを閉じてから案内を出す画面のため)", () => {
    const prompt = jest.fn();
    expect(handleStoredAiConsentFailure(AI_CONSENT_REQUIRED_MESSAGE, prompt)).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("同意の状況を読めなかった文 (一時的)・ほかの失敗・コードそのもの・空は false で、何も出さない", () => {
    for (const stored of [
      AI_CONSENT_CHECK_FAILED_MESSAGE,
      "stale_request_timeout",
      AI_CONSENT_REQUIRED_CODE,
      AI_CONSENT_CHECK_FAILED_CODE,
      null,
      undefined,
      "",
    ]) {
      expect(handleStoredAiConsentFailure(stored)).toBe(false);
    }
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
