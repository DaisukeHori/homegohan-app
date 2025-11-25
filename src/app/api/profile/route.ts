import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = createClient(cookies())
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createClient(cookies())
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    
    // マッピング
    const updates: any = {
      id: user.id,
      updated_at: new Date().toISOString(),
    };

    if (body.nickname) updates.nickname = body.nickname;
    if (body.gender) updates.gender = body.gender;
    if (body.lifestyle) updates.lifestyle = body.lifestyle; // JSONとして保存
    if (body.goal) updates.goal_text = body.goal;
    
    // 追加項目
    if (body.age) updates.age = parseInt(body.age);
    if (body.age) updates.age_group = `${Math.floor(parseInt(body.age) / 10) * 10}s`; // 年代も自動計算
    if (body.occupation) updates.occupation = body.occupation;
    if (body.height) updates.height = parseFloat(body.height);
    if (body.weight) updates.weight = parseFloat(body.weight);

    // デフォルト値の補完（必須カラムエラー回避）
    if (!updates.nickname) updates.nickname = 'Guest'; 
    if (!updates.age_group && !updates.age) updates.age_group = 'unspecified';
    if (!updates.gender) updates.gender = 'unspecified';

    const { data, error } = await supabase
      .from('user_profiles')
      .upsert(updates) // upsertを使用
      .select()
      .single()

    if (error) {
      console.error('Profile update error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error: any) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = createClient(cookies())
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    
    // キャメルケース(App) -> スネークケース(DB)へのマッピング
    const updates: any = {};
    if (body.nickname !== undefined) updates.nickname = body.nickname;
    if (body.age !== undefined) updates.age = body.age;
    if (body.occupation !== undefined) updates.occupation = body.occupation;
    if (body.height !== undefined) updates.height = body.height;
    if (body.weight !== undefined) updates.weight = body.weight;
    if (body.ageGroup !== undefined) updates.age_group = body.ageGroup;
    if (body.gender !== undefined) updates.gender = body.gender;
    if (body.goalText !== undefined) updates.goal_text = body.goalText;
    if (body.performanceModes !== undefined) updates.perf_modes = body.performanceModes;
    if (body.lifestyle !== undefined) updates.lifestyle = body.lifestyle;
    if (body.dietFlags !== undefined) updates.diet_flags = body.dietFlags;
    
    // 年齢から年代を自動計算
    if (body.age && !body.ageGroup) {
      const age = typeof body.age === 'number' ? body.age : parseInt(body.age);
      if (!isNaN(age)) {
        updates.age_group = `${Math.floor(age / 10) * 10}s`;
      }
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error: any) {
    console.error("API Error (PUT /api/profile):", error);
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
