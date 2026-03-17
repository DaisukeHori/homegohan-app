import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/catalog-products', () => ({
  searchCatalogProducts: vi.fn(),
  getCatalogProductById: vi.fn(),
}));

const mockGetUser = vi.fn();
const supabaseClient = { auth: { getUser: mockGetUser } };
vi.mock('@/lib/supabase/server', () => ({ createClient: () => supabaseClient }));

import { searchCatalogProducts, getCatalogProductById } from '@/lib/catalog-products';
import { GET as catalogSearchGET } from '../src/app/api/catalog/products/route';
import { GET as catalogDetailGET } from '../src/app/api/catalog/products/[id]/route';
import type { CatalogProductSummary } from '../types/catalog';

const sampleProduct: CatalogProductSummary = {
  id: 'prod-1',
  sourceId: 'src',
  sourceCode: 'SRC',
  brandName: 'Brand',
  name: 'Product',
  categoryCode: 'category',
  description: 'desc',
  imageUrl: 'https://example.com/image.png',
  canonicalUrl: 'https://example.com/product',
  priceYen: 350,
  caloriesKcal: 210,
  proteinG: 10,
  fatG: 5,
  carbsG: 30,
  sodiumG: 0.7,
  fiberG: 2,
  sugarG: 3,
  availabilityStatus: 'active',
};

const ensureAuthorized = () => {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
};

describe('catalog product routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ensureAuthorized();
  });

  it('search returns 401 without auth', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await catalogSearchGET(new Request('http://localhost/api/catalog/products?q=abc'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('search returns empty array for queries shorter than two characters', async () => {
    ensureAuthorized();
    const response = await catalogSearchGET(new Request('http://localhost/api/catalog/products?q=a'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ products: [] });
    expect(searchCatalogProducts).not.toHaveBeenCalled();
  });

  it('search returns catalog products for valid queries', async () => {
    ensureAuthorized();
    searchCatalogProducts.mockResolvedValue([sampleProduct]);
    const response = await catalogSearchGET(new Request('http://localhost/api/catalog/products?q=test&limit=5'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ products: [sampleProduct] });
    expect(searchCatalogProducts).toHaveBeenCalledWith(supabaseClient, 'test', { limit: 5 });
  });

  it('detail returns 401 without auth', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await catalogDetailGET(new Request('http://localhost/api/catalog/products/prod-1'), {
      params: { id: 'prod-1' },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('detail returns 404 when product is missing', async () => {
    ensureAuthorized();
    getCatalogProductById.mockResolvedValue(null);
    const response = await catalogDetailGET(new Request('http://localhost/api/catalog/products/prod-missing'), {
      params: { id: 'prod-missing' },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('detail returns product data when found', async () => {
    ensureAuthorized();
    getCatalogProductById.mockResolvedValue(sampleProduct);
    const response = await catalogDetailGET(new Request('http://localhost/api/catalog/products/prod-1'), {
      params: { id: 'prod-1' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ product: sampleProduct });
    expect(getCatalogProductById).toHaveBeenCalledWith(supabaseClient, 'prod-1');
  });
});
