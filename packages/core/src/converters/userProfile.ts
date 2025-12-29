import type { DbUserProfileLite, UserProfileLite } from "../types/userProfile";

export function toUserProfileLite(db: DbUserProfileLite): UserProfileLite {
  return {
    id: db.id,
    nickname: db.nickname,
    age: db.age,
    gender: db.gender,
    height: db.height,
    weight: db.weight,
  };
}



