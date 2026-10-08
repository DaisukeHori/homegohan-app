import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_URL_LENGTH,
  validateAnalyzeFridgeRequest,
} from "../supabase/functions/analyze-fridge/validate-request.ts";

// #1227: analyze-fridge Edge Function の imageUrl は、型も形式も確かめずに外部の Vision API へ渡っていた。
// 数値などが来ると imageUrl.slice(0, 80) で TypeError になって 500 を返し、文字列ならスキームを問わず上流に渡った。
// 検証を純粋関数に切り出したので、ここでは入力ごとの判定を確かめる (入口の配線は analyze-fridge-handler.test.ts)。

const PUBLIC_URL = "https://flmeolcfutuwwbjmzyoz.supabase.co/storage/v1/object/public/fridge-images/u1/fridge.jpg";

function check(imageUrl: unknown) {
  return validateAnalyzeFridgeRequest({ imageUrl });
}

/** 通れば "ok"、弾かれたら理由 */
function outcome(imageUrl: unknown): string {
  const result = check(imageUrl);
  return result.ok ? "ok" : result.reason;
}

describe("validateAnalyzeFridgeRequest: 通す入力 (#1227)", () => {
  it("AV-1: Supabase Storage の公開 URL はそのまま通る", () => {
    expect(check(PUBLIC_URL)).toEqual({
      ok: true,
      imageUrl: PUBLIC_URL,
      host: "flmeolcfutuwwbjmzyoz.supabase.co",
    });
  });

  it("AV-2: token つきの長い署名付き URL も通る (token はそのまま保たれる)", () => {
    const signed = `https://flmeolcfutuwwbjmzyoz.supabase.co/storage/v1/object/sign/fridge-images/u1/fridge.jpg?token=${"a".repeat(800)}`;
    const result = check(signed);
    expect(result).toEqual({ ok: true, imageUrl: signed, host: "flmeolcfutuwwbjmzyoz.supabase.co" });
  });

  it("AV-3: URL パーサが正規化した値を返す (検証した値をそのまま上流に渡すため)", () => {
    expect(check("  HTTPS://Img.Example.COM:443/a b.jpg#top ")).toEqual({
      ok: true,
      imageUrl: "https://img.example.com/a%20b.jpg#top",
      host: "img.example.com",
    });
    // 改行やタブが紛れていても、パーサが取り除いた後の値になる
    expect(check("https://img.exam\nple.com/a.jpg")).toEqual({
      ok: true,
      imageUrl: "https://img.example.com/a.jpg",
      host: "img.example.com",
    });
  });

  it("AV-4: 日本語ドメインや標準以外のポートでも、https で名前の付いたホストなら通る", () => {
    expect(outcome("https://例え.jp/a.jpg")).toBe("ok");
    expect(outcome("https://img.example.com:8443/a.jpg")).toBe("ok");
  });

  it("AV-5: 長さの上限ちょうどは通り、1 文字超えると弾く", () => {
    const prefix = "https://example.com/";
    const atLimit = prefix + "a".repeat(MAX_IMAGE_URL_LENGTH - prefix.length);
    expect(atLimit).toHaveLength(MAX_IMAGE_URL_LENGTH);
    expect(outcome(atLimit)).toBe("ok");
    expect(outcome(atLimit + "a")).toBe("too_long");
  });
});

describe("validateAnalyzeFridgeRequest: 弾く入力 (#1227)", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["空文字", ""],
    ["空白だけ", "   "],
    ["改行とタブだけ", "\n\t"],
  ])("AV-6: imageUrl が無い (%s) → missing", (_label, imageUrl) => {
    expect(outcome(imageUrl)).toBe("missing");
  });

  it("AV-7: imageUrl が無いときのメッセージは従来のまま", () => {
    expect(validateAnalyzeFridgeRequest({})).toMatchObject({ ok: false, message: "Image URL is required" });
  });

  it.each([
    ["数値", 12345],
    ["0", 0],
    ["true", true],
    ["false", false],
    ["配列", [PUBLIC_URL]],
    ["オブジェクト", { url: PUBLIC_URL }],
  ])("AV-8: imageUrl が文字列でない (%s) → not_string", (_label, imageUrl) => {
    expect(outcome(imageUrl)).toBe("not_string");
    expect(check(imageUrl)).toMatchObject({ ok: false, message: "Image URL must be a string" });
  });

  it.each([
    ["null", null],
    ["配列", []],
    ["文字列", PUBLIC_URL],
    ["数値", 12345],
    ["真偽値", true],
  ])("AV-9: 本文が JSON のオブジェクトでない (%s) → invalid_body", (_label, body) => {
    expect(validateAnalyzeFridgeRequest(body)).toMatchObject({
      ok: false,
      reason: "invalid_body",
      message: "Request body must be a JSON object",
    });
  });

  it.each([
    ["スキームなしのドメイン", "example.com/a.jpg"],
    ["スキーム相対", "//example.com/a.jpg"],
    ["パスだけ", "/storage/v1/object/public/fridge-images/u1/fridge.jpg"],
    ["文章", "not a url"],
    ["ホストなし", "https://"],
    ["ホストに空白", "https://exa mple.com/a.jpg"],
    ["範囲外のポート", "https://example.com:99999/a.jpg"],
    ["壊れた IPv6", "https://[::1/a.jpg"],
    ["範囲外の IPv4", "https://999.999.999.999/a.jpg"],
  ])("AV-10: URL として解釈できない (%s) → invalid_url", (_label, imageUrl) => {
    expect(outcome(imageUrl)).toBe("invalid_url");
  });

  it.each([
    ["http", "http://example.com/a.jpg"],
    ["大文字の HTTP", "HTTP://EXAMPLE.COM/a.jpg"],
    ["ftp", "ftp://example.com/a.jpg"],
    ["file", "file:///etc/passwd"],
    ["data URI", "data:image/png;base64,iVBORw0KGgo="],
    ["javascript", "javascript:alert(1)"],
    ["blob", "blob:https://example.com/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["ws", "ws://example.com/a.jpg"],
    ["wss", "wss://example.com/a.jpg"],
    ["mailto", "mailto:someone@example.com"],
    ["about", "about:blank"],
  ])("AV-11: https 以外のスキーム (%s) → not_https", (_label, imageUrl) => {
    expect(outcome(imageUrl)).toBe("not_https");
    expect(check(imageUrl)).toMatchObject({ ok: false, message: "Image URL must use HTTPS" });
  });

  it.each([
    ["ユーザー名とパスワード", "https://user:pass@example.com/a.jpg"],
    ["ユーザー名だけ", "https://user@example.com/a.jpg"],
    ["パスワードだけ", "https://:pass@example.com/a.jpg"],
    ["信頼できるホストに見せかける", "https://flmeolcfutuwwbjmzyoz.supabase.co@evil.example.com/a.jpg"],
  ])("AV-12: 認証情報を含む (%s) → has_credentials", (_label, imageUrl) => {
    expect(outcome(imageUrl)).toBe("has_credentials");
  });

  it.each([
    ["localhost", "https://localhost/a.jpg"],
    ["localhost とポート", "https://localhost:8443/a.jpg"],
    ["ループバック", "https://127.0.0.1/a.jpg"],
    ["プライベート 10.x", "https://10.0.0.5/a.jpg"],
    ["プライベート 192.168.x", "https://192.168.0.1/a.jpg"],
    ["プライベート 172.16.x", "https://172.16.0.1/a.jpg"],
    ["メタデータ用のリンクローカル", "https://169.254.169.254/latest/meta-data/"],
    ["0.0.0.0", "https://0.0.0.0/a.jpg"],
    ["公開 IP の直指定", "https://8.8.8.8/a.jpg"],
    ["IPv6 ループバック", "https://[::1]/a.jpg"],
    ["IPv4 射影の IPv6", "https://[::ffff:127.0.0.1]/a.jpg"],
    ["10 進数の IPv4", "https://2130706433/a.jpg"],
    ["16 進数の IPv4", "https://0x7f.1/a.jpg"],
    ["8 進数の IPv4", "https://0177.0.0.1/a.jpg"],
    ["ドットのない名前", "https://intranet/a.jpg"],
    ["*.localhost", "https://foo.localhost/a.jpg"],
    ["*.local", "https://printer.local/a.jpg"],
    ["*.internal", "https://metadata.google.internal/computeMetadata/v1/"],
    ["末尾にドットのある *.internal", "https://metadata.google.internal./computeMetadata/v1/"],
  ])("AV-13: 画像の配信元に使えないホスト (%s) → host_not_allowed", (_label, imageUrl) => {
    expect(outcome(imageUrl)).toBe("host_not_allowed");
  });

  it("AV-14: 名前に local / internal を含むだけの普通のドメインは弾かない", () => {
    for (const imageUrl of [
      "https://localstorage.example.com/a.jpg",
      "https://internal-cdn.example.com/a.jpg",
      "https://example.local.jp/a.jpg",
    ]) {
      expect(outcome(imageUrl)).toBe("ok");
    }
  });
});

describe("validateAnalyzeFridgeRequest: ログ用の補足 (#1227)", () => {
  it("AV-15: 弾いたときの meta に、入力された URL (token や認証情報) を含めない", () => {
    for (const imageUrl of [
      "http://example.com/a.jpg?token=SECRET",
      "https://user:SECRET@example.com/a.jpg",
      "https://127.0.0.1/a.jpg?token=SECRET",
      'javascript:alert("SECRET")',
      "not a url SECRET",
      `https://example.com/${"SECRET".repeat(500)}`,
    ]) {
      const result = check(imageUrl);
      expect(result.ok, imageUrl).toBe(false);
      if (!result.ok) {
        expect(JSON.stringify(result.meta), imageUrl).not.toContain("SECRET");
        expect(result.message, imageUrl).not.toContain("SECRET");
      }
    }
  });

  it("AV-16: 弾いた理由に応じて、ログに役立つ最小限の情報だけを返す", () => {
    expect(check(12345)).toMatchObject({ reason: "not_string", meta: { valueType: "number" } });
    expect(check([PUBLIC_URL])).toMatchObject({ reason: "not_string", meta: { valueType: "array" } });
    expect(check("http://example.com/a.jpg")).toMatchObject({ reason: "not_https", meta: { protocol: "http:" } });
    expect(check("https://127.0.0.1/a.jpg")).toMatchObject({ reason: "host_not_allowed", meta: { host: "127.0.0.1" } });
    expect(check("x".repeat(MAX_IMAGE_URL_LENGTH + 1))).toMatchObject({
      reason: "too_long",
      meta: { length: MAX_IMAGE_URL_LENGTH + 1, maxLength: MAX_IMAGE_URL_LENGTH },
    });
  });

  it("AV-17: ログに入れる値は長さを切り詰める (入力で app_logs を膨らませない)", () => {
    const longScheme = `${"a".repeat(1000)}:foo`;
    const result = check(longScheme);
    expect(result).toMatchObject({ ok: false, reason: "not_https" });
    if (!result.ok) {
      expect(String(result.meta.protocol).length).toBeLessThanOrEqual(32);
    }
  });
});
