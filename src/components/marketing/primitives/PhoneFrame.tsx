// 端末の枠 (docs/design/marketing/01-landing-site.md §5.4・§8.3 の PhoneFrame)。
// 角丸 --lp-radius-phone・縁 0.5rem (下地 --lp-ink)・影・aspect-ratio 540 / 1080 は marketing.css の .lp-phone が持つ。
// 中身 (next/image) は呼ぶ側が渡し、幅も呼ぶ側が決める。枠は飾りで、役割を持たない。
import type { ReactNode } from 'react';

/** 実際の画面 (public/guide/*.png) の大きさ。next/image の width / height に渡す (src/app/guide/guide-content.ts の GUIDE_IMAGE_SIZE と同じ) */
export const GUIDE_SCREEN_WIDTH_PX = 540;
export const GUIDE_SCREEN_HEIGHT_PX = 1080;

export function PhoneFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={['lp-phone', className ?? ''].filter(Boolean).join(' ')}>
      <div className="lp-phone-screen">{children}</div>
    </div>
  );
}
