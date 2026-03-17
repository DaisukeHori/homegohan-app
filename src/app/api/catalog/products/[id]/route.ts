import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCatalogProductById } from "@/lib/catalog-products";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();

  try {
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const product = await getCatalogProductById(supabase, params.id);
    if (!product) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ product });
  } catch (error: any) {
    console.error("Catalog product detail failed:", error);
    return NextResponse.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
}
