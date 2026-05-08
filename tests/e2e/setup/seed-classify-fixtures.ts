/**
 * seed-classify-fixtures.ts
 *
 * /tmp/classify-test/ に JPEG ファイルを生成する。
 * ImageMagick 等の外部依存なしに Node.js Buffer だけで有効な JPEG を作成する。
 *
 * 生成ファイル:
 *   meal-1.jpg, meal-2.jpg
 *   fridge-1.jpg, fridge-2.jpg
 *   health-1.jpg, health-2.jpg
 *   weight-1.jpg, weight-2.jpg
 *   unknown-blank.jpg
 *
 * 注意: これらはテスト用プレースホルダ画像です。
 * classify-photo API の MIN_IMAGE_BYTES (1000 bytes) チェックを通過するよう
 * JPEG コメントセグメント (0xFF 0xFE) でパディングしています。
 * AI による分類精度は保証しません (テストは任意の結果を受け入れます)。
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CLASSIFY_TEST_DIR = "/tmp/classify-test";

/**
 * 1x1 ピクセルの最小有効 JPEG バイナリ (Base64 エンコード済み)
 * SOI + APP0(JFIF) + DQT + SOF0 + DHT + SOS + EOI の完全な構造を持つ
 * Node.js で生成・検証済み (SOI=FF D8, EOI=FF D9)
 */
const MINIMAL_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALChAYKDM9DAwOExo6PDcODRAYKDlFOA4R" +
  "Fh0zV1A+EhYlOERtZ00YIzdAUWhxXDFATldneXhlSFxfYnBkZ2P/wAALCAABAAEBAREA" +
  "/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AH///9k=";

/**
 * classify-photo API の MIN_IMAGE_BYTES 閾値 (1000 bytes) を超える有効な JPEG を生成する。
 * JPEG コメントセグメント (marker: 0xFF 0xFE) を SOI 直後に挿入してパディングする。
 * コメントには分類カテゴリのラベルを埋め込む (デバッグ用)。
 */
function makePaddedJpeg(label: string, targetBytes = 1200): Buffer {
  const base = Buffer.from(MINIMAL_JPEG_BASE64, "base64");

  // SOI (2 bytes) の直後に JPEG コメントセグメントを挿入
  // コメントセグメント構造: 0xFF 0xFE + 2-byte length (length 値は length フィールド自体を含む) + comment data
  const headerSize = 4; // marker (2) + length (2)
  const minCommentLen = Math.max(2, targetBytes - base.length - headerSize + 2);
  // コメントデータ: label + パディング
  const labelBytes = Buffer.from(`[e2e-fixture:${label}] `, "utf8");
  const padNeeded = Math.max(0, minCommentLen - 2 - labelBytes.length);
  const commentData = Buffer.concat([labelBytes, Buffer.alloc(padNeeded, 0x20)]); // 0x20 = space
  const commentLen = commentData.length + 2; // length フィールドは自身を含む

  const marker = Buffer.from([0xff, 0xfe]);
  const lenBuf = Buffer.allocUnsafe(2);
  lenBuf.writeUInt16BE(commentLen);

  // SOI(2) | comment segment | rest of JPEG
  const soi = base.slice(0, 2);
  const rest = base.slice(2);
  return Buffer.concat([soi, marker, lenBuf, commentData, rest]);
}

/**
 * classify-test ディレクトリと必要な JPEG ファイルを生成する。
 * 既存ファイルはサイズが MIN_IMAGE_BYTES (1000 bytes) 未満の場合に上書きする。
 */
export function seedClassifyFixtures(): void {
  if (!fs.existsSync(CLASSIFY_TEST_DIR)) {
    fs.mkdirSync(CLASSIFY_TEST_DIR, { recursive: true });
    console.log(`[seed-classify-fixtures] ディレクトリ作成: ${CLASSIFY_TEST_DIR}`);
  }

  const files: Array<{ name: string; label: string }> = [
    { name: "meal-1.jpg",    label: "meal" },
    { name: "meal-2.jpg",    label: "meal" },
    { name: "fridge-1.jpg",  label: "fridge" },
    { name: "fridge-2.jpg",  label: "fridge" },
    { name: "health-1.jpg",  label: "health_checkup" },
    { name: "health-2.jpg",  label: "health_checkup" },
    { name: "weight-1.jpg",  label: "weight_scale" },
    { name: "weight-2.jpg",  label: "weight_scale" },
    { name: "unknown-blank.jpg", label: "unknown" },
  ];

  const MIN_BYTES = 1000;

  for (const { name, label } of files) {
    const filePath = path.join(CLASSIFY_TEST_DIR, name);
    const existingSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

    if (existingSize >= MIN_BYTES) {
      console.log(`[seed-classify-fixtures] スキップ (既存・十分なサイズ): ${filePath} (${existingSize} bytes)`);
      continue;
    }

    const jpegBuf = makePaddedJpeg(label);
    fs.writeFileSync(filePath, jpegBuf);
    const action = existingSize > 0 ? "上書き (サイズ不足)" : "生成";
    console.log(`[seed-classify-fixtures] ${action}: ${filePath} (${jpegBuf.length} bytes)`);
  }
}

// スクリプトとして直接実行された場合
if (require.main === module) {
  seedClassifyFixtures();
  console.log("[seed-classify-fixtures] 完了");
}
