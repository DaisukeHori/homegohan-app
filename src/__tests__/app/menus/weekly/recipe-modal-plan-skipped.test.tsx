/**
 * 料理の画面 (RecipeModal) の料理画像の枠の文 (billing/03 §8.8・§10.3。§14.1 のテスト 99・154)。
 *   - image_error が skipped_plan (ご利用中のプランでは自動の料理画像を作らない) なら有料プランの案内
 *   - skipped_ai_limit / skipped_rate_limit の文は今までどおり
 *   - 画像も状態も無い料理 (主菜でない料理。Q-16) には画像の枠を出さない
 * JSX を使わず createElement で描く (vitest の変換と tsconfig の jsx: preserve の組み合わせを避けるため)。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecipeModal } from '@/app/(main)/menus/weekly/_components/modals/RecipeModal';
import { stripAllTags } from '../../../../../tests/helpers/strip-tags';

vi.mock('@/components/photo/SignedPhotoImage', () => ({
  SignedPhotoImage: (props: { src: string; alt: string }) => createElement('img', { src: props.src, alt: props.alt }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
});

function render(selectedRecipeData: Record<string, unknown>): string {
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(RecipeModal, {
        selectedRecipe: '鮭の塩焼き',
        selectedRecipeData: { name: '鮭の塩焼き', role: 'main', dishes: [], ...selectedRecipeData },
        isFavorite: false,
        isFavoriteLoading: false,
        onClose: () => undefined,
        onToggleFavorite: () => undefined,
        onAddToShoppingList: () => undefined,
      }),
    );
  });
  return stripAllTags(container.innerHTML, ' ');
}

describe('billing/03 §8.8 RecipeModal の料理画像の枠', () => {
  it('RecipeModal shows the paid-plan wording for skipped_plan and keeps the existing wording for skipped_ai_limit / skipped_rate_limit', () => {
    const plan = render({ image_status: 'failed', image_error: 'skipped_plan', imageUrl: null });
    expect(plan).toContain('料理画像の作成は有料プランでお使いいただけます');
    expect(plan).toContain('料理画像の作成は有料プランでお使いいただけます。有料プランにすると、料理を保存し直したときに画像を作ります。');
    expect(plan).not.toContain('料理画像は作っていません');
    expect(plan).not.toContain('今日は料理画像を作れる回数を超えた');
    act(() => root?.unmount());
    root = undefined;

    for (const error of ['skipped_ai_limit', 'skipped_rate_limit']) {
      const text = render({ image_status: 'failed', image_error: error, imageUrl: null });
      expect(text, error).toContain('料理画像は作っていません');
      expect(text, error).toContain('今日は料理画像を作れる回数を超えたため、画像を作りませんでした。あとで料理を保存し直すと作ります。');
      expect(text, error).not.toContain('有料プラン');
      act(() => root?.unmount());
      root = undefined;
    }
    // 見送りでない失敗は今までどおり
    const failed = render({ image_status: 'failed', image_error: 'generation_error', imageUrl: null });
    expect(failed).toContain('料理画像の生成に失敗しました');
    expect(failed).not.toContain('有料プラン');
  });

  it('RecipeModal shows no image frame for a dish without imageUrl and image_status (a non-main dish under billing/03 Q-16)', () => {
    const text = render({ role: 'side', imageUrl: null, image_status: null, image_error: null });
    for (const wording of ['料理画像を生成中です', '再生成待ち', '料理画像は作っていません', '料理画像の生成に失敗しました', '有料プラン']) {
      expect(text, wording).not.toContain(wording);
    }
    expect(container.querySelector('img')).toBeNull();
  });
});
