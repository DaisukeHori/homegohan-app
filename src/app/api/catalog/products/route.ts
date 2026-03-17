import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchCatalogProducts } from "@/lib/catalog-products";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export async function GET(request: Request) {
  const supabase = createClient();

  try {
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q")?.trim() ?? "";
    const rawLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(rawLimit)))
      : DEFAULT_LIMIT;

    if (query.length < 2) {
      return NextResponse.json({ products: [] });
    }

    const products = await searchCatalogProducts(supabase, query, { limit });
    return NextResponse.json({ products });
  } catch (error: any) {
    console.error("Catalog product search failed:", error);
    return NextResponse.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
}
