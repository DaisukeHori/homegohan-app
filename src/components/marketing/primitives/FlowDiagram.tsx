// 流れの図 (docs/design/marketing/01-landing-site.md §5.7・§8.2・§8.3 の FlowDiagram・M-12)。Server Component。仕組みの区切りの下に置く。
// 5 つの節 (ul。アイコンの輪 + 札) と、節の輪の中心を通る SVG の path 1 本 (pathLength="1"・aria-hidden)。下に注記。
// 768 px 以上は横 1 行、未満は縦 1 列 (線は同じ path を CSS で縦に向ける)。文字は HTML の要素で、SVG は線だけ。
// 線の描かれ方 (M-12) は CSS: 図を包む Reveal に JS の印 (data-js) があって「画面に入った」の印 (is-in) が無い間だけ stroke-dashoffset: 1 で隠し、
// is-in で 0 へ描く (no-preference の中だけ)。動きを減らす設定・JS 無しでは最初から描かれている。
import { Camera, ChefHat, MessageCircleHeart, ScanSearch, ShoppingCart, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { FlowNodeId } from '../landing-copy';

/** 節ごとのアイコン (§5.5 の流れの図) */
const FLOW_ICONS: Record<FlowNodeId, LucideIcon> = {
  photo: Camera,
  analyze: ScanSearch,
  record: MessageCircleHeart,
  menu: ChefHat,
  shopping: ShoppingCart,
};

type FlowDiagramProps = {
  nodes: ReadonlyArray<{ id: FlowNodeId; label: string }>;
  note: string;
};

export function FlowDiagram({ nodes, note }: FlowDiagramProps) {
  return (
    <div className="lp-flow">
      <div className="lp-flow-track" style={{ '--lp-flow-count': nodes.length } as CSSProperties}>
        {/* 線は 1 本。SVG の箱は線の長さ × 太さ (2 px) で、viewBox (0〜1 の正方形) を preserveAspectRatio="none" で箱に伸ばし、
            太さ 1 の線を箱いっぱいに引く (non-scaling-stroke を使わない理由は marketing.css の .lp-flow-line) */}
        <svg className="lp-flow-line" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d="M 0 0.5 H 1" pathLength={1} />
        </svg>
        <ul className="lp-flow-nodes">
          {nodes.map((node, index) => {
            const Icon = FLOW_ICONS[node.id];
            return (
              <li key={node.id} className="lp-flow-node" style={{ '--lp-i': index } as CSSProperties}>
                <span className="lp-flow-ring" aria-hidden="true">
                  <Icon />
                </span>
                <span className="lp-flow-label">{node.label}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="lp-note lp-flow-note">{note}</p>
    </div>
  );
}
