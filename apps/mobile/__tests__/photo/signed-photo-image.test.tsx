/**
 * 写真を署名付き URL で表示する部品 (src/components/photo/SignedPhotoImage.tsx) のテスト (#1365 段 1)
 * - 食事写真・冷蔵庫写真のバケットの URL は、保存された公開 URL を表示せず、サーバーが署名した URL を表示する
 * - サーバーが署名しなかった (他人の写真など)・問い合わせに失敗したときは、公開 URL にも戻さず表示しない
 * - それ以外の URL は問い合わせずにそのまま表示する
 */
import React from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';

const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: mockPost }),
}));

import { SignedPhotoImage } from '../../src/components/photo/SignedPhotoImage';

const BASE = 'https://proj.supabase.co/storage/v1/object';

describe('SignedPhotoImage', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('署名付き URL が来たら、それを表示する (公開 URL は一度も表示しない)', async () => {
    const publicUrl = `${BASE}/public/fridge-images/user-1/a.jpg`;
    const signedUrl = `${BASE}/sign/fridge-images/user-1/a.jpg?token=abc`;
    mockPost.mockResolvedValue({ signedUrls: { [publicUrl]: signedUrl }, expiresInSeconds: 3600 });

    const { queryByTestId, findByTestId } = render(<SignedPhotoImage testID="photo" uri={publicUrl} />);
    expect(queryByTestId('photo')).toBeNull();
    const image = await findByTestId('photo');
    expect(image.props.source).toEqual({ uri: signedUrl });
    expect(mockPost).toHaveBeenCalledWith('/api/storage/signed-urls', { urls: [publicUrl] });
  });

  it('サーバーが署名しなかった写真 (null) は表示せず、fallback を出す', async () => {
    const publicUrl = `${BASE}/public/meal_photos/other-user/b.jpg`;
    mockPost.mockResolvedValue({ signedUrls: { [publicUrl]: null }, expiresInSeconds: 3600 });

    const { queryByTestId, findByText } = render(
      <SignedPhotoImage testID="photo" uri={publicUrl} fallback={<Text>no-photo</Text>} />,
    );
    expect(await findByText('no-photo')).toBeTruthy();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(queryByTestId('photo')).toBeNull();
  });

  it('問い合わせに失敗したときも、公開 URL に戻さず表示しない', async () => {
    const publicUrl = `${BASE}/public/fridge-images/user-1/c.jpg`;
    mockPost.mockRejectedValue(new Error('network'));

    const { queryByTestId } = render(<SignedPhotoImage testID="photo" uri={publicUrl} />);
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(queryByTestId('photo')).toBeNull();
  });

  it('写真のバケットの URL でなければ、問い合わせずにそのまま表示する', () => {
    const externalUrl = 'https://images.example.com/dish.jpg';
    const { getByTestId } = render(<SignedPhotoImage testID="photo" uri={externalUrl} />);
    expect(getByTestId('photo').props.source).toEqual({ uri: externalUrl });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
