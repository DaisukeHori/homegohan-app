// #291: 管理者向けカタログ手動インポート trigger API
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

const SOURCE_TO_FUNCTION: Record<string, string> = {
  seven_eleven_jp:  'import-seven-eleven-catalog',
  familymart_jp:    'import-familymart-catalog',
  lawson_jp:        'import-lawson-catalog',
  natural_lawson_jp:'import-natural-lawson-catalog',
  ministop_jp:      'import-ministop-catalog',
};

export async function POST(request: Request) {
  const supabase = await createClient();

  // 認証確認
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 管理者ロール確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .maybeSingle();

  const isAdmin = profile?.roles?.some((r: string) =>
    ['admin', 'super_admin'].includes(r)
  );
  if (!isAdmin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // リクエスト body 検証
  let body: { sourceCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const sourceCode = body.sourceCode;
  if (!sourceCode || typeof sourceCode !== 'string') {
    return NextResponse.json(
      { error: 'invalid_source', validSources: Object.keys(SOURCE_TO_FUNCTION) },
      { status: 400 }
    );
  }

  const functionName = SOURCE_TO_FUNCTION[sourceCode];
  if (!functionName) {
    return NextResponse.json(
      { error: 'invalid_source', validSources: Object.keys(SOURCE_TO_FUNCTION) },
      { status: 400 }
    );
  }

  // Edge Function を手動 trigger
  const { data, error } = await supabase.functions.invoke(functionName, { body: {} });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sourceCode, functionName, result: data });
}
