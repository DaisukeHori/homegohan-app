import { describe, expect, it } from 'vitest';

import {
  buildDishImagePrompt,
  buildDishImageSubjectHash,
  deriveMealCoverImage,
  reconcileDishImages,
} from '../supabase/functions/_shared/meal-image';

describe('meal image utils', () => {
  it('buildDishImagePrompt includes dish name, role, and ingredients', () => {
    const prompt = buildDishImagePrompt({
      name: '親子丼',
      role: 'main',
      ingredients: ['鶏もも肉', '卵', '玉ねぎ'],
    });

    expect(prompt).toContain('親子丼');
    expect(prompt).toContain('main');
    expect(prompt).toContain('鶏もも肉');
  });

  it('buildDishImageSubjectHash changes when identity fields change', async () => {
    const base = await buildDishImageSubjectHash(
      { name: '親子丼', role: 'main', ingredients: ['鶏もも肉', '卵'] },
      0,
    );
    const differentName = await buildDishImageSubjectHash(
      { name: 'カツ丼', role: 'main', ingredients: ['豚肉', '卵'] },
      0,
    );
    const differentOrder = await buildDishImageSubjectHash(
      { name: '親子丼', role: 'main', ingredients: ['鶏もも肉', '卵'] },
      1,
    );

    expect(base).not.toBe(differentName);
    expect(base).not.toBe(differentOrder);
  });

  it('reconcileDishImages enqueues new dishes and sets pending state', async () => {
    const result = await reconcileDishImages({
      previousDishes: [],
      nextDishes: [{ name: '親子丼', role: 'main', ingredients: ['鶏もも肉', '卵'] }],
      triggerSource: 'generate-menu-v4',
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.dishes[0].image_status).toBe('pending');
    expect(result.dishes[0].image_url).toBeNull();
    expect(result.mealCoverImageUrl).toBeNull();
  });

  it('reconcileDishImages keeps existing ready image when subject is unchanged', async () => {
    const previous = await reconcileDishImages({
      previousDishes: [],
      nextDishes: [{ name: '親子丼', role: 'main', ingredients: ['鶏もも肉', '卵'] }],
      triggerSource: 'generate-menu-v4',
    });
    const hydrated = [{
      ...previous.dishes[0],
      image_url: 'https://example.com/oyakodon.png',
      image_source: 'generated_ai' as const,
      image_status: 'ready' as const,
      image_generated_at: '2026-03-17T00:00:00.000Z',
    }];

    const result = await reconcileDishImages({
      previousDishes: hydrated,
      nextDishes: [{ name: '親子丼', role: 'main', ingredients: ['鶏もも肉', '卵'] }],
      triggerSource: 'manual-edit',
    });

    expect(result.jobs).toHaveLength(0);
    expect(result.dishes[0].image_url).toBe('https://example.com/oyakodon.png');
    expect(result.dishes[0].image_status).toBe('ready');
    expect(result.mealCoverImageUrl).toBe('https://example.com/oyakodon.png');
  });

  it('reconcileDishImages marks changed generated image as stale and enqueues a job', async () => {
    const previous = [{
      name: '親子丼',
      role: 'main',
      ingredients: ['鶏もも肉', '卵'],
      image_url: 'https://example.com/old.png',
      image_source: 'generated_ai' as const,
      image_status: 'ready' as const,
      image_subject_hash: await buildDishImageSubjectHash(
        { name: '親子丼', role: 'main', ingredients: ['鶏もも肉', '卵'] },
        0,
      ),
    }];

    const result = await reconcileDishImages({
      previousDishes: previous,
      nextDishes: [{ name: 'カツ丼', role: 'main', ingredients: ['豚肉', '卵'] }],
      triggerSource: 'manual-edit',
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.dishes[0].image_status).toBe('stale');
    expect(result.dishes[0].image_url).toBeNull();
  });

  it('reconcileDishImages keeps stale manual override without enqueue', async () => {
    const previous = [{
      name: '親子丼',
      role: 'main',
      ingredients: ['鶏もも肉', '卵'],
      image_url: 'https://example.com/manual.png',
      image_source: 'manual_override' as const,
      image_status: 'ready' as const,
      image_subject_hash: await buildDishImageSubjectHash(
        { name: '親子丼', role: 'main', ingredients: ['鶏もも肉', '卵'] },
        0,
      ),
    }];

    const result = await reconcileDishImages({
      previousDishes: previous,
      nextDishes: [{ name: 'カツ丼', role: 'main', ingredients: ['豚肉', '卵'] }],
      triggerSource: 'manual-edit',
    });

    expect(result.jobs).toHaveLength(0);
    expect(result.dishes[0].image_status).toBe('stale');
    expect(result.dishes[0].image_source).toBe('manual_override');
    expect(result.dishes[0].image_url).toBe('https://example.com/manual.png');
  });

  it('deriveMealCoverImage ignores stale dishes and falls back to first ready image', () => {
    const cover = deriveMealCoverImage({
      dishes: [
        {
          name: '主菜',
          image_url: 'https://example.com/stale.png',
          image_source: 'generated_ai',
          image_status: 'stale',
        },
        {
          name: '副菜',
          image_url: 'https://example.com/ready.png',
          image_source: 'generated_ai',
          image_status: 'ready',
        },
      ],
    });

    expect(cover).toBe('https://example.com/ready.png');
  });
});
