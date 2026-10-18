# デモの食事の写真の出どころ (docs/design/marketing/01-landing-site.md §7.2)

紹介ページ (`/`) のデモ (`DemoSection`) が使う食事の写真 3 枚。実行時に外部から読まず、このディレクトリのファイルだけを使う。

調達の順は設計書 §7.2 のとおり (1. 権利が自社にある写真 → 2. それまでの間に合わせの Unsplash License の写真)。
**いまは 2 の間に合わせ**。権利が自社にある写真が届いたら差し替え、設計書 §24 の Q-1 の既定に従って
`src/components/marketing/landing-copy.ts` の見本の名前・alt・料理の名前・推定の値も写真に合わせて直す
(スコアと記録コメントは `demoScore`・`demoPraiseComment` が作り直す。`tests/landing-page-1867.test.ts` の U-21 の期待値も同じ PR で直す)。

| ファイル | 元 (Unsplash の ID) | License | 作者 | 写っているもの (目で見て確かめた。2026-10-18) |
|---|---|---|---|---|
| `salad-bowl.webp` | `photo-1512621776951-a57141f2eefd` | Unsplash License (商用利用可・帰属不要) | 取得時に確認できなかった (Unsplash のページが自動取得を断るため。ID だけ記録) | 葉野菜・アボカド・ミニトマト・ひよこ豆・さつまいも・紫キャベツ・黄パプリカ・薄切りの赤い大根のサラダボウル (真上から) |
| `salmon-plate.webp` | `photo-1547592180-85f173990554` | Unsplash License (商用利用可・帰属不要) | 同上 | 焼いたサーモン・いんげん・ミニトマト・穀物 (カリフラワーライスか雑穀) のプレート。横にミニトマトの小鉢 (真上から) |
| `pesto-pasta.webp` | `photo-1473093295043-cdd812d0e601` | Unsplash License (商用利用可・帰属不要) | 同上 | バジルソースのファルファッレ・ミニトマト・葉野菜 (上から。白い器の一部) |

## 作り方

- 元の取得: `https://images.unsplash.com/<ID>?w=800&h=800&fit=crop&fm=webp&q=75` を 1 回だけファイルに落とした (800×800)。
- そのままでは 1 枚の重さの上限 (120 KB。`tests/landing-page-1867.test.ts` の U-4) を超える写真があったので、
  Pillow で WebP の品質 75・method 6 に作り直して置いた (大きさは 800×800 のまま)。
- 紹介ページは `images.unsplash.com` を実行時に読まない (外部の要求ゼロ)。

## 確認が残っていること

- 作者の名前: Unsplash License は帰属を求めないが、記録のために作者の名前を引き直して、この表に足す。
- 設計書 §24 の Q-1: オーナーの写真が使えるか。
