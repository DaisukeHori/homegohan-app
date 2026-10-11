/**
 * classify-photo-failure.test.ts
 * #1487 写真の「オート」の判別が「判別できなかった」(422) ときの本文の読み取り (src/lib/classify-photo-failure.ts)
 *
 * 判別は AI へ送ったあとなので数え済みで、422 の本文に「数え済みの印」(aiUsageGrant) が入る。
 * 画面はこの印を拾って、種類を手で選んだ解析に入れる (2 回目として数えない。Web と同じ)。
 */
import { CLASSIFY_PHOTO_UNKNOWN_TYPE_STATUS, classifyPhotoFailureOf } from "../../src/lib/classify-photo-failure";

const GRANT = "g1.1760000000.0f8fad5b-d9cb-469f-a165-70867728950e." + "a".repeat(64);

const httpError = (status: string, body: unknown) =>
  new Error(`HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);

describe("classifyPhotoFailureOf (#1487)", () => {
  it("判別できなかった状態は 422", () => {
    expect(CLASSIFY_PHOTO_UNKNOWN_TYPE_STATUS).toBe(422);
  });

  it("422 の本文から、印・種類・確からしさ・候補を読む", () => {
    const failure = classifyPhotoFailureOf(
      httpError("422 Unprocessable Entity", {
        error: "unknown_type",
        type: "unknown",
        confidence: 0.12,
        candidates: [{ type: "fridge", confidence: 0.2 }, { type: 42 }, null, { type: "meal" }],
        aiUsageGrant: GRANT,
      }),
    );
    expect(failure).toEqual({
      aiUsageGrant: GRANT,
      type: "unknown",
      confidence: 0.12,
      candidates: [
        { type: "fridge", confidence: 0.2 },
        { type: "meal", confidence: 0 },
      ],
    });
  });

  it("HTTP/2 で状態の文が空 (HTTP 422 : ...) でも読む。印が無ければ null", () => {
    expect(classifyPhotoFailureOf(httpError("422 ", { error: "unknown_type" }))).toEqual({
      aiUsageGrant: null,
      type: "unknown",
      confidence: 0,
      candidates: [],
    });
  });

  it.each([
    ["422 以外の状態", httpError("500 Internal Server Error", { aiUsageGrant: GRANT })],
    ["上限 (429)", httpError("429 Too Many Requests", { code: "AI_DAILY_LIMIT", limit: 10 })],
    ["JSON でない本文", httpError("422 Unprocessable Entity", "<html>")],
    ["配列の本文", httpError("422 Unprocessable Entity", [GRANT])],
    ["HTTP の形でない例外", new Error("Network request failed")],
    ["Error でない値", "HTTP 422 : {}"],
    ["null", null],
  ])("%s は null (今までどおり失敗として扱う)", (_label, error) => {
    expect(classifyPhotoFailureOf(error)).toBeNull();
  });
});
