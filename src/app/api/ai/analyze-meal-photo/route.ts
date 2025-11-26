import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const formData = await request.formData();
    const image = formData.get('image') as File;
    const mealId = formData.get('mealId') as string;
    const mealType = formData.get('mealType') as string;

    if (!image || !mealId) {
      return NextResponse.json({ error: 'Image and mealId are required' }, { status: 400 });
    }

    // Convert image to base64
    const arrayBuffer = await image.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = image.type || 'image/jpeg';

    // Call Edge Function for async processing
    const { error: invokeError } = await supabase.functions.invoke('analyze-meal-photo', {
      body: {
        imageBase64: base64Image,
        mimeType,
        mealId,
        mealType,
        userId: user.id,
      },
    });

    if (invokeError) {
      throw new Error(`Edge Function invoke failed: ${invokeError.message}`);
    }

    return NextResponse.json({ 
      success: true,
      message: 'Photo analysis started in background',
      status: 'processing'
    });

  } catch (error: any) {
    console.error("Photo Analysis Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

