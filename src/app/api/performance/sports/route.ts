import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { toSportPreset } from '@/lib/converter'
import { internalError } from '@/lib/api/errors'
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order'

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

    // 分類の順 → 名前の順。同じ名前は id の順 (#2139 T1)
    let query = orderListBy(supabase.from('sport_presets').select('*'), LIST_ORDERS.performanceSports)

    if (category) {
      query = query.eq('category', category)
    }

    if (search) {
      query = query.or(`name_ja.ilike.%${search}%,name_en.ilike.%${search}%`)
    }

    const { data, error } = await query

    if (error) {
      return internalError('GET /api/performance/sports', error)
    }

    return NextResponse.json({
      sports: data.map(toSportPreset),
    })
  } catch (error: any) {
    return internalError('GET /api/performance/sports', error)
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
