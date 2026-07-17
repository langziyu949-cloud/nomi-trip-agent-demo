import type { FavoritePlaceKey } from "@/lib/types";

const FAVORITE_ALIASES: Array<{ pattern: RegExp; key: FavoritePlaceKey }> = [
  { pattern: /^(家|家里|我家|住处|我的住处)$/, key: "home" },
  { pattern: /^(学校|儿子学校|孩子学校|乐乐学校|小学|幼儿园)$/, key: "school" },
  { pattern: /^(我的公司|我公司|公司|单位|办公室)$/, key: "company" },
  { pattern: /^(老婆公司|妻子公司|爱人公司)$/, key: "wifeCompany" },
];

export function favoriteKeyForQuery(query: string): FavoritePlaceKey | null {
  const normalized = query.replace(/\s+/g, "").trim();
  return FAVORITE_ALIASES.find(({ pattern }) => pattern.test(normalized))?.key ?? null;
}
