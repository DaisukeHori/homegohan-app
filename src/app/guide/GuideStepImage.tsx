"use client";

import { useState } from "react";
import Image from "next/image";
import { GUIDE_IMAGE_DISPLAY_MAX_HEIGHT_PX, GUIDE_IMAGE_SIZE, type GuideImagePath } from "./guide-content";

/**
 * 使い方ガイドの手順の画面の画像 (#1852)。
 * 画像を読めなかったとき (ファイルが無い・通信の失敗) は、壊れた画像の枠を出さずに枠ごと隠す。
 * 呼び出し側は src ごとに key を変えること (別の手順に切り替えたとき、前の失敗の状態を持ち越さないため)。
 */
export function GuideStepImage({ src, alt }: { src: GuideImagePath; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  return (
    <div className="flex justify-center rounded-xl py-4" data-testid="guide-step-image" style={{ background: "#F5F3EF" }}>
      <Image
        src={src}
        alt={alt}
        width={GUIDE_IMAGE_SIZE.width}
        height={GUIDE_IMAGE_SIZE.height}
        onError={() => setFailed(true)}
        className="h-auto w-auto max-w-full rounded-2xl border shadow-sm"
        style={{ maxHeight: GUIDE_IMAGE_DISPLAY_MAX_HEIGHT_PX, borderColor: "#E8E8E8" }}
      />
    </div>
  );
}
