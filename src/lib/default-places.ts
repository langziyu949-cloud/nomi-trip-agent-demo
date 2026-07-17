import type { FavoritePlaceKey, PlaceDraft, ResolvedPlace } from "@/lib/types";

export const DEFAULT_PLACES: Record<FavoritePlaceKey, ResolvedPlace> = {
  home: {
    id: "favorite-home-xujiahui",
    name: "家",
    address: "徐家汇公园附近",
    district: "徐汇区",
    adcode: "310104",
    location: { lng: 121.43838, lat: 31.1951 },
    source: "FAVORITE",
  },
  school: {
    id: "favorite-school-xuhui",
    name: "儿子学校",
    address: "上海市徐汇中学附近",
    district: "徐汇区",
    adcode: "310104",
    location: { lng: 121.44181, lat: 31.19132 },
    source: "FAVORITE",
  },
  company: {
    id: "favorite-company-lujiazui",
    name: "我的公司",
    address: "上海中心大厦附近",
    district: "浦东新区",
    adcode: "310115",
    location: { lng: 121.50565, lat: 31.2335 },
    source: "FAVORITE",
  },
  wifeCompany: {
    id: "favorite-wife-company-jingan",
    name: "老婆公司",
    address: "静安寺附近",
    district: "静安区",
    adcode: "310106",
    location: { lng: 121.44829, lat: 31.22372 },
    source: "FAVORITE",
  },
};

export function favoriteDraft(key: keyof typeof DEFAULT_PLACES): PlaceDraft {
  const place = DEFAULT_PLACES[key];
  return {
    key,
    label: place.name,
    query: place.name,
    resolved: place,
  };
}

export function unresolvedDraft(query: string, index: number): PlaceDraft {
  return {
    key: `custom-${index}-${query}`,
    label: query,
    query,
    resolved: null,
  };
}
