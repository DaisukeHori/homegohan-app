import { describe, expect, it } from 'vitest';
import type { CatalogProductSummary } from '../types/catalog';
import {
  clearCatalogSelectionMetadata,
  extractCatalogProductFromMetadata,
  mergeCatalogSelectionMetadata,
} from '../lib/catalog-products';

const sampleProduct: CatalogProductSummary = {
  id: 'prod-123',
  sourceId: 'source-1',
  sourceCode: 'SRC1',
  brandName: 'Sample Brand',
  name: 'Sample Food',
  categoryCode: 'rcp',
  description: 'Delicious sample food',
  imageUrl: 'https://example.com/sample.png',
  canonicalUrl: 'https://example.com/sample',
  priceYen: 480,
  caloriesKcal: 320,
  proteinG: 12,
  fatG: 15,
  carbsG: 28,
  sodiumG: 0.8,
  fiberG: 3,
  sugarG: 5,
  availabilityStatus: 'active',
};

describe('catalog product metadata helpers', () => {
  it('mergeCatalogSelectionMetadata keeps existing metadata and adds catalog details', () => {
    const existingMetadata = { origin: 'ai', catalog_selection: { active: false } };
    const result = mergeCatalogSelectionMetadata(existingMetadata, sampleProduct, 'manual_search');
    expect(result.origin).toBe('ai');
    expect(result.catalog_selection).toMatchObject({
      active: true,
      productId: sampleProduct.id,
      selectedFrom: 'manual_search',
      brandName: sampleProduct.brandName,
      name: sampleProduct.name,
      caloriesKcal: sampleProduct.caloriesKcal,
    });
    expect(typeof result.catalog_selection.selectedAt).toBe('string');
  });

  it('extractCatalogProductFromMetadata returns summary when selection is active', () => {
    const metadata = mergeCatalogSelectionMetadata(null, sampleProduct, 'photo_match');
    const extracted = extractCatalogProductFromMetadata(metadata);
    expect(extracted).not.toBeNull();
    expect(extracted?.id).toBe(sampleProduct.id);
    expect(extracted?.caloriesKcal).toBe(sampleProduct.caloriesKcal);
    expect(extracted?.availabilityStatus).toBe(sampleProduct.availabilityStatus);
  });

  it('clearCatalogSelectionMetadata marks selection as inactive with reason', () => {
    const metadata = mergeCatalogSelectionMetadata(null, sampleProduct, 'manual_search');
    const cleared = clearCatalogSelectionMetadata(metadata, 'manual_override');
    expect(cleared.catalog_selection).toMatchObject({
      active: false,
      clearReason: 'manual_override',
    });
    expect(typeof cleared.catalog_selection.clearedAt).toBe('string');
  });
});
