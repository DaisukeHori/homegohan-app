/**
 * 端末から直に保存する料理の画像の項目 (#1487)。サーバーの組み立てと同じ形にする
 * (写真: supabase/functions/_shared/meal-image.ts の buildPhotoDishList、商品: lib/catalog-products.ts の catalogDishImageFields。
 *  サーバー側のコードは端末へ持ち込めないので写す。同じ形であることは tests/mobile-meal-dish-images-parity.test.ts が確かめる)。
 *
 * image_source が meal_photo / catalog の料理は、サーバーで保存し直しても (完了の切り替えを含む)、料理の中身を変えても、
 * AI の画像で置き換えない (reconcileDishImages の isPreservedDishImage)。image_subject_hash は付けない
 * (画像の処理は subject_hash が同じ料理にだけ書くので、付けなければ AI の画像が上書きしない)
 */

export type MobileDishImageSource = "meal_photo" | "catalog";
export type MobileDishImageStatus = "ready" | "stale";

export interface MobileMealImageDish {
  name?: string | null;
  image_url?: string | null;
  image_source?: MobileDishImageSource | null;
  image_status?: MobileDishImageStatus | null;
  image_generated_at?: string | null;
  [key: string]: unknown;
}

/** 写真で記録した料理。料理が 1 つなら写真をその料理の画像にし、複数なら料理ごとの画像は付けない ('stale') */
export function buildPhotoDishList<TDish extends Record<string, unknown>>(
  dishes: TDish[],
  imageUrl: string | null,
): Array<TDish & MobileMealImageDish> {
  const isSingle = dishes.length <= 1;
  const generatedAt = new Date().toISOString();
  return dishes.map((dish) => ({
    ...dish,
    image_url: isSingle && imageUrl ? imageUrl : null,
    image_source: "meal_photo" as const,
    image_status: isSingle ? ("ready" as const) : ("stale" as const),
    image_generated_at: generatedAt,
  }));
}

/** 商品の料理の画像の項目。画像は商品の画像。画像が無いときは状態を付けない (画面に「生成中」「失敗」を出さない) */
export function catalogDishImageFields(imageUrl: string | null): {
  image_url: string | null;
  image_source: "catalog";
  image_status: "ready" | null;
} {
  return {
    image_url: imageUrl,
    image_source: "catalog",
    image_status: imageUrl ? "ready" : null,
  };
}
