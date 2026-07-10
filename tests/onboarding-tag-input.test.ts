/**
 * tests/onboarding-tag-input.test.ts
 *
 * Issue #1045 round-2 (Sonnet Warning): questions/page.tsx のタグ入力
 * (アレルギー/苦手な食材/好きな食材/趣味) にクライアント側の文字数・件数上限が
 * 無かったため、スキーマ側 (src/schemas/onboarding.ts の freeTagList: 30文字/件・最大30件)
 * だけが 400 で弾き、回答喪失+偽の完了成功 (#1045 round-2 Sonnet Warning) につながっていた。
 *
 * addTagsFromInput() が
 *   - 「、」「,」「，」区切りの入力を複数タグに分割する (1タグ=1食材)
 *   - 1件あたり TAG_MAX_LENGTH (30) 文字で切り詰める
 *   - 合計件数が TAG_MAX_COUNT (30) を超えないようにする
 *   - 重複タグを追加しない
 * ことを検証する。
 */

import { describe, expect, it } from "vitest";
import { addTagsFromInput } from "../src/app/onboarding/questions/tag-input";
import { TAG_MAX_LENGTH, TAG_MAX_COUNT } from "../src/schemas/onboarding";

describe("addTagsFromInput", () => {
  it("単一のタグを追加できる", () => {
    expect(addTagsFromInput([], "卵")).toEqual(["卵"]);
  });

  it("「、」区切りの入力は複数タグに分割される (プレースホルダのカンマ区切り誘因対策)", () => {
    expect(addTagsFromInput([], "卵、エビ、小麦")).toEqual(["卵", "エビ", "小麦"]);
  });

  it("半角カンマ・全角カンマ区切りも分割される", () => {
    expect(addTagsFromInput([], "卵,エビ，小麦")).toEqual(["卵", "エビ", "小麦"]);
  });

  it("前後の空白は trim される", () => {
    expect(addTagsFromInput([], " 卵 、 エビ ")).toEqual(["卵", "エビ"]);
  });

  it("空文字・空白のみの候補は無視される", () => {
    expect(addTagsFromInput([], "卵、、エビ")).toEqual(["卵", "エビ"]);
    expect(addTagsFromInput([], "   ")).toEqual([]);
  });

  it(`1件あたり ${TAG_MAX_LENGTH} 文字を超える入力は切り詰められる (スキーマ freeTagList と一致)`, () => {
    const longTag = "あ".repeat(50);
    const result = addTagsFromInput([], longTag);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(TAG_MAX_LENGTH);
    expect(result[0]).toBe("あ".repeat(TAG_MAX_LENGTH));
  });

  it("既存タグと重複する候補は追加されない", () => {
    expect(addTagsFromInput(["卵"], "卵、エビ")).toEqual(["卵", "エビ"]);
  });

  it(`件数が ${TAG_MAX_COUNT} 件に達したらそれ以上は追加しない (スキーマ freeTagList.max と一致)`, () => {
    const current = Array.from({ length: TAG_MAX_COUNT }, (_, i) => `tag${i}`);
    const result = addTagsFromInput(current, "新しい食材");
    expect(result).toHaveLength(TAG_MAX_COUNT);
    expect(result).not.toContain("新しい食材");
  });

  it("件数上限直前で複数候補を一括投入した場合、上限を超える分だけ切り捨てられる", () => {
    const current = Array.from({ length: TAG_MAX_COUNT - 2 }, (_, i) => `tag${i}`);
    const result = addTagsFromInput(current, "卵、エビ、小麦");
    expect(result).toHaveLength(TAG_MAX_COUNT);
    expect(result).toContain("卵");
    expect(result).toContain("エビ");
    expect(result).not.toContain("小麦");
  });

  it("既存タグ配列は変更されない (イミュータブル)", () => {
    const current = ["卵"];
    const result = addTagsFromInput(current, "エビ");
    expect(current).toEqual(["卵"]);
    expect(result).toEqual(["卵", "エビ"]);
  });
});
