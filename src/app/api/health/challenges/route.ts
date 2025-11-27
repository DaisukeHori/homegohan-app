import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// チャレンジ一覧の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'active';

  let query = supabase
    .from('health_challenges')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 利用可能なチャレンジテンプレートも返す
  const availableTemplates = getAvailableChallenges();

  return NextResponse.json({ 
    challenges: data,
    templates: availableTemplates,
  });
}

// チャレンジの作成
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { template_id, custom_target } = body;

  // テンプレートからチャレンジを生成
  const templates = getAvailableChallenges();
  const template = templates.find(t => t.id === template_id);

  if (!template) {
    return NextResponse.json({ error: 'Invalid template' }, { status: 400 });
  }

  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + template.duration_days);

  const { data, error } = await supabase
    .from('health_challenges')
    .insert({
      user_id: user.id,
      challenge_type: template.type,
      title: template.title,
      description: template.description,
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
      target_metric: template.metric,
      target_value: custom_target || template.default_target,
      target_unit: template.unit,
      current_value: 0,
      daily_progress: [],
      reward_points: template.reward_points,
      reward_badge: template.reward_badge,
      reward_description: template.reward_description,
      status: 'active',
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ challenge: data });
}

// チャレンジテンプレート
function getAvailableChallenges() {
  return [
    {
      id: 'weight_loss_week',
      type: 'weekly',
      title: '1週間で-0.5kg',
      description: '無理のないペースで体重を減らしましょう',
      metric: 'weight_loss',
      default_target: 0.5,
      unit: 'kg',
      duration_days: 7,
      reward_points: 100,
      reward_badge: 'weight_warrior',
      reward_description: '達成すると「ウェイトウォリアー」バッジを獲得！',
      difficulty: 'easy',
      emoji: '⚖️',
    },
    {
      id: 'daily_record_week',
      type: 'weekly',
      title: '7日連続記録',
      description: '1週間毎日健康記録をつけましょう',
      metric: 'record_streak',
      default_target: 7,
      unit: '日',
      duration_days: 7,
      reward_points: 150,
      reward_badge: 'recorder',
      reward_description: '達成すると「レコーダー」バッジを獲得！',
      difficulty: 'easy',
      emoji: '📝',
    },
    {
      id: 'steps_week',
      type: 'weekly',
      title: '週間5万歩',
      description: '1週間で合計5万歩歩きましょう',
      metric: 'total_steps',
      default_target: 50000,
      unit: '歩',
      duration_days: 7,
      reward_points: 200,
      reward_badge: 'walker',
      reward_description: '達成すると「ウォーカー」バッジを獲得！',
      difficulty: 'medium',
      emoji: '🚶',
    },
    {
      id: 'water_week',
      type: 'weekly',
      title: '毎日2L水分補給',
      description: '1週間毎日2L以上の水分を摂りましょう',
      metric: 'water_intake',
      default_target: 7,
      unit: '日',
      duration_days: 7,
      reward_points: 150,
      reward_badge: 'hydrator',
      reward_description: '達成すると「ハイドレーター」バッジを獲得！',
      difficulty: 'medium',
      emoji: '💧',
    },
    {
      id: 'sleep_week',
      type: 'weekly',
      title: '良質な睡眠週間',
      description: '1週間、睡眠の質を4以上にキープ',
      metric: 'good_sleep',
      default_target: 7,
      unit: '日',
      duration_days: 7,
      reward_points: 200,
      reward_badge: 'sleeper',
      reward_description: '達成すると「スリーパー」バッジを獲得！',
      difficulty: 'medium',
      emoji: '😴',
    },
    {
      id: 'weight_loss_month',
      type: 'monthly',
      title: '1ヶ月で-2kg',
      description: '健康的なペースで体重を減らしましょう',
      metric: 'weight_loss',
      default_target: 2,
      unit: 'kg',
      duration_days: 30,
      reward_points: 500,
      reward_badge: 'weight_master',
      reward_description: '達成すると「ウェイトマスター」バッジを獲得！',
      difficulty: 'hard',
      emoji: '🏆',
    },
  ];
}

