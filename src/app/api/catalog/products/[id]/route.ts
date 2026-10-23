import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCatalogProductById } from "@/lib/catalog-products";
import { internalError } from '@/lib/api/errors';
import { API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

/** 400: 商品の ID が UUID の形でない */
const PRODUCT_ID_INVALID_MESSAGE = '商品の指定が正しくありません';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: PRODUCT_ID_INVALID_MESSAGE }, { status: 400 });
  }

  const supabase = await createClient();

  try {
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    const product = await getCatalogProductById(supabase, params.id);
    if (!product) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    return NextResponse.json({ product });
  } catch (error: any) {
    return internalError('GET /api/catalog/products/[id]', error);
  }
}
