import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { toSportPreset } from '@/lib/converter'

/**
 * GET /api/performance/sports
 *
 * スポーツプリセット一覧を取得
 * Query params:
 *   - category: カテゴリでフィルタ
 *   - search: 名前で検索
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    // 認証不要（公開データ）

    const { searchParams } = new URL(request.url)
    const category = searchParams.get('category')
    const search = searchParams.get('search')

    let query = supabase
      .from('sport_presets')
      .select('*')
      .order('category')
      .order('name_ja')

    if (category) {
      query = query.eq('category', category)
    }

    if (search) {
      query = query.or(`name_ja.ilike.%${search}%,name_en.ilike.%${search}%`)
    }

    const { data, error } = await query

    if (error) {
      console.error('Sports fetch error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      sports: data.map(toSportPreset),
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * GET /api/performance/sports/categories
 *
 * スポーツカテゴリ一覧を取得
 */
export async function OPTIONS(request: NextRequest) {
  // カテゴリ一覧を返す
  const categories = [
    { id: 'ball', nameJa: '球技', nameEn: 'Ball Sports' },
    { id: 'combat', nameJa: '格闘技', nameEn: 'Combat Sports' },
    { id: 'running', nameJa: '陸上競技', nameEn: 'Track & Field' },
    { id: 'swimming', nameJa: '水泳', nameEn: 'Swimming' },
    { id: 'cycling', nameJa: '自転車', nameEn: 'Cycling' },
    { id: 'winter', nameJa: 'ウィンタースポーツ', nameEn: 'Winter Sports' },
    { id: 'gym', nameJa: 'ジム・フィットネス', nameEn: 'Gym & Fitness' },
    { id: 'racket', nameJa: 'ラケットスポーツ', nameEn: 'Racket Sports' },
    { id: 'outdoor', nameJa: 'アウトドア', nameEn: 'Outdoor' },
    { id: 'dance', nameJa: 'ダンス', nameEn: 'Dance' },
    { id: 'esports', nameJa: 'eスポーツ', nameEn: 'E-Sports' },
    { id: 'other', nameJa: 'その他', nameEn: 'Other' },
  ]

  return NextResponse.json({ categories })
}
