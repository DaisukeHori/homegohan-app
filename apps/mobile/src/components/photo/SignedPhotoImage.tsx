/**
 * 保存された写真の URL を、署名付き URL に替えてから表示する Image (#1365 段 1)。
 * 食事写真・冷蔵庫写真 (meal_photos / fridge-images) の URL は、DB に入っている公開 URL をそのまま
 * <Image source={{ uri }}> に渡さず、これを使う。
 * 署名付き URL が来るまで・表示できない (本人の写真でない・問い合わせに失敗した) ときは fallback を出す (既定は何も出さない)。
 */
import type { ReactNode } from "react";
import { Image, type ImageProps } from "react-native";

import { useSignedPhotoUrl } from "../../hooks/useSignedPhotoUrl";

export type SignedPhotoImageProps = Omit<ImageProps, "source"> & {
  /** 保存された写真の URL (食事写真・冷蔵庫写真のバケットの URL 以外はそのまま表示する) */
  uri: string;
  /** 表示する URL が無いあいだに出すもの */
  fallback?: ReactNode;
};

export function SignedPhotoImage({ uri, fallback = null, ...rest }: SignedPhotoImageProps) {
  const displayUrl = useSignedPhotoUrl(uri);
  if (!displayUrl) return <>{fallback}</>;
  return <Image source={{ uri: displayUrl }} {...rest} />;
}
