// テスト用 Supabase Edge Function
// GitHub Actions 自動デプロイのテスト用です
// テスト完了後に削除予定

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { action, data } = await req.json()

    let result: unknown

    switch (action) {
      case 'create':
        result = {
          id: crypto.randomUUID(),
          message: 'Created successfully',
          data,
          timestamp: new Date().toISOString()
        }
        break

      case 'read':
        result = {
          message: 'Read successfully',
          data: { sample: 'test data', requestedId: data?.id },
          timestamp: new Date().toISOString()
        }
        break

      case 'update':
        result = {
          message: 'Updated successfully',
          data,
          timestamp: new Date().toISOString()
        }
        break

      case 'delete':
        result = {
          message: 'Deleted successfully',
          deletedId: data?.id,
          timestamp: new Date().toISOString()
        }
        break

      default:
        result = {
          message: 'GitHub Actions auto-deploy test function',
          availableActions: ['create', 'read', 'update', 'delete'],
          deployedAt: '2026-01-13T00:00:00Z',
          version: '1.1.0'
        }
    }

    return new Response(
      JSON.stringify({ success: true, result }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        hint: 'Send JSON with { action: "create" | "read" | "update" | "delete", data?: any }'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      }
    )
  }
})
