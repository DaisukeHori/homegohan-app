// 章の画面の一部の拡大 (ズーム。docs/design/marketing/01-landing-site.md §5.3・§5.4 の「拡大」・§8.2・§8.3 の ScreenZoom・M-17)。Server Component。
// 根は figure 1 つ。上から: 箱 (data-zoom-lens。縦横比は拡大の画像の大きさ) と札 (figcaption。ZoomIn + zoom.label)。
// 箱の中の画像は、段 0 に隣の端末の画面と同じ撮影の回の同じ画面から切り出した別の画像 (landing-screens.ts の LANDING_ZOOMS)。箱の幅いっぱいに出す。
// 大きさ (箱の縦横比) は landingZoomBySrc で引く (同じ値を 2 か所に書かない)。
// 箱の立ち上がり (M-17) は CSS で、きっかけは ChapterSection が包む Reveal の is-in。隠す (縮みと透明) のは no-preference の中で、
// 包む Reveal に JS の印 (data-js) があって is-in が無い間だけ。動きを減らす設定・JS 無しでは最初から元の大きさで不透明。
import { ZoomIn } from 'lucide-react';
import Image from 'next/image';
import { LANDING_IMAGE_SIZES, type ChapterZoom } from '../landing-copy';
import { landingZoomBySrc } from '../landing-screens';

export function ScreenZoom({ zoom }: { zoom: ChapterZoom }) {
  const image = landingZoomBySrc(zoom.image.src);
  return (
    <figure className="lp-zoom">
      <div className="lp-zoom-lens" data-zoom-lens="1" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
        <Image src={zoom.image.src} alt={zoom.image.alt} width={image.width} height={image.height} sizes={LANDING_IMAGE_SIZES.zoom} />
      </div>
      <figcaption className="lp-zoom-label">
        <ZoomIn className="lp-zoom-icon" aria-hidden="true" />
        {zoom.label}
      </figcaption>
    </figure>
  );
}
