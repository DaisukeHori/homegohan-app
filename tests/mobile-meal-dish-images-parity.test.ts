// @vitest-environment node
/**
 * #1487 の整合ゲート: 端末が直に保存する写真・商品の料理の画像の項目 (apps/mobile/src/lib/meal-dish-images.ts) が、
 * サーバーの組み立て (写真: buildPhotoDishList、商品: catalogDishImageFields) と同じ形であること。
 * 形がずれると、サーバーで保存し直したとき (完了の切り替えを含む) に写真・商品の画像を AI の画像で置き換えてしまう
 */
import { describe, expect, it } from 'vitest';

import * as mobile from '../apps/mobile/src/lib/meal-dish-images';
import { buildPhotoDishList, isPreservedDishImage } from '../supabase/functions/_shared/meal-image';
import { catalogDishImageFields } from '../lib/catalog-products';

const PHOTO_URL = 'https://example.com/storage/meal-photos/user-1/photo.jpg';
const withoutTime = <T extends Record<string, unknown>>(dishes: T[]) => dishes.map(({ image_generated_at: _ignored, ...rest }) => rest);

describe('端末の写真・商品の料理の画像の項目 (#1487)', () => {
  it.each([
    ['料理 1 つ・写真あり', [{ name: '親子丼', role: 'main' }], PHOTO_URL],
    ['料理 1 つ・写真なし', [{ name: '親子丼', role: 'main' }], null],
    ['料理が複数', [{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL],
  ])('写真の料理 (%s): サーバーの buildPhotoDishList と同じ形で、AI の画像で置き換えない料理になる', (_label, dishes, url) => {
    const fromMobile = mobile.buildPhotoDishList(dishes, url);
    expect(withoutTime(fromMobile)).toEqual(withoutTime(buildPhotoDishList(dishes, url)));
    expect(fromMobile.every((dish) => isPreservedDishImage(dish))).toBe(true);
    expect(fromMobile.every((dish) => !('image_subject_hash' in dish))).toBe(true);
  });

  it.each([['https://example.com/catalog/bento.jpg'], [null]])('商品の料理 (画像 %s): サーバーの catalogDishImageFields と同じ形', (url) => {
    expect(mobile.catalogDishImageFields(url)).toEqual(catalogDishImageFields(url));
    expect(isPreservedDishImage(mobile.catalogDishImageFields(url))).toBe(true);
  });
});
