import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const { mealPlanId, itemName, category, quantity } = json;

    const { data, error } = await supabase
      .from('shopping_list_items')
      .insert({
        meal_plan_id: mealPlanId,
        item_name: itemName,
        category: category || 'その他',
        quantity: quantity,
        is_checked: false
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ 
      item: {
        id: data.id,
        mealPlanId: data.meal_plan_id,
        itemName: data.item_name,
        category: data.category,
        quantity: data.quantity,
        isChecked: data.is_checked,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}



