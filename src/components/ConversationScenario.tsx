"use client";

import { useState } from "react";

import { ArrowIcon, CloseIcon } from "@/components/icons";
import type {
  DemoSettings,
  FavoritePlaceKey,
  PlaceSearchResponse,
  ResolvedPlace,
} from "@/lib/types";

const FAVORITE_PLACE_LABELS: Record<FavoritePlaceKey, string> = {
  home: "家",
  company: "我的公司",
  school: "儿子学校",
  wifeCompany: "老婆公司",
};

const FAVORITE_PLACE_KEYS = Object.keys(FAVORITE_PLACE_LABELS) as FavoritePlaceKey[];

interface ConversationScenarioProps {
  value: DemoSettings;
  mode: "setup" | "view";
  onChange?: (value: DemoSettings) => void;
  onConfirm?: () => void;
  onClose?: () => void;
}

async function searchPlaces(query: string): Promise<ResolvedPlace[]> {
  const response = await fetch(
    `/api/places/search?q=${encodeURIComponent(query)}&city=${encodeURIComponent("上海市")}`,
  );
  const body = (await response.json()) as PlaceSearchResponse | { error?: string };
  if (!response.ok) {
    throw new Error("error" in body && body.error ? body.error : "地点搜索失败，请稍后重试。");
  }
  return (body as PlaceSearchResponse).candidates;
}

export function ConversationScenario({
  value,
  mode,
  onChange,
  onConfirm,
  onClose,
}: ConversationScenarioProps) {
  const editable = mode === "setup";
  const [editingPlace, setEditingPlace] = useState<FavoritePlaceKey | null>(null);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeCandidates, setPlaceCandidates] = useState<ResolvedPlace[]>([]);
  const [placeSearchState, setPlaceSearchState] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const [placeSearchError, setPlaceSearchError] = useState("");

  const update = (next: DemoSettings) => {
    if (editable) onChange?.(next);
  };

  const beginPlaceEdit = (key: FavoritePlaceKey) => {
    if (!editable) return;
    setEditingPlace(key);
    setPlaceQuery(value.favoritePlaces[key].address || value.favoritePlaces[key].name);
    setPlaceCandidates([]);
    setPlaceSearchError("");
    setPlaceSearchState("idle");
  };

  const runPlaceSearch = async () => {
    if (!placeQuery.trim()) return;
    setPlaceSearchState("loading");
    setPlaceCandidates([]);
    setPlaceSearchError("");
    try {
      const candidates = await searchPlaces(placeQuery.trim());
      setPlaceCandidates(candidates);
      setPlaceSearchState(candidates.length ? "idle" : "empty");
    } catch (error) {
      setPlaceSearchError(error instanceof Error ? error.message : "地点搜索失败，请稍后重试。");
      setPlaceSearchState("error");
    }
  };

  const chooseFavoritePlace = (place: ResolvedPlace) => {
    if (!editingPlace) return;
    update({
      ...value,
      favoritePlaces: { ...value.favoritePlaces, [editingPlace]: place },
    });
    setEditingPlace(null);
    setPlaceCandidates([]);
    setPlaceSearchState("idle");
  };

  return (
    <section className={`conversation-scenario ${editable ? "is-setup" : "is-readonly"}`}>
      <div className="scenario-heading">
        <div>
          <span className="eyebrow">{editable ? "NEW CONVERSATION" : "CONVERSATION SCENE"}</span>
          <h2>{editable ? "设置本次对话场景" : "本次对话的 Demo Lab"}</h2>
        </div>
        {!editable && onClose && (
          <button className="icon-button" onClick={onClose} aria-label="关闭场景详情">
            <CloseIcon />
          </button>
        )}
      </div>

      <p className="scenario-lock-note">
        {editable
          ? "确认后，本次对话会一直使用这些地点、天气和车况；如需另一组场景，请新建对话。"
          : "该场景已随对话锁定。回到这段对话时，路线规划和演示都会继续使用这些设置。"}
      </p>

      <div className="scenario-scroll-area">
        <section className="scenario-section">
          <div className="lab-section-title"><strong>主动服务</strong><small>本次对话固定</small></div>
          <label className={`toggle-row ${editable ? "" : "is-locked"}`}>
            <div><strong>允许 NOMI 根据天气主动备车</strong><small>按座舱温度判断预热或制冷</small></div>
            <input
              type="checkbox"
              checked={value.preconditionVehicle}
              disabled={!editable}
              onChange={(event) => update({ ...value, preconditionVehicle: event.target.checked })}
            />
            <span />
          </label>
        </section>

        <section className="scenario-section">
          <div className="lab-section-title"><strong>常用地点</strong><small>{editable ? "可在确认前修改" : "已锁定"}</small></div>
          <div className="favorite-place-list">
            {FAVORITE_PLACE_KEYS.map((key) => {
              const place = value.favoritePlaces[key];
              return (
                <div className="favorite-place-item" key={key}>
                  <div>
                    <span>{FAVORITE_PLACE_LABELS[key]}</span>
                    <strong>{place.name}</strong>
                    <small>{place.district} · {place.address}</small>
                  </div>
                  {editable && <button onClick={() => beginPlaceEdit(key)}>修改</button>}
                </div>
              );
            })}
          </div>

          {editable && editingPlace && (
            <div className="favorite-place-editor">
              <div className="place-search-row">
                <input
                  value={placeQuery}
                  onChange={(event) => setPlaceQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) void runPlaceSearch();
                  }}
                  placeholder={`搜索${FAVORITE_PLACE_LABELS[editingPlace]}的具体地址`}
                  autoFocus
                />
                <button onClick={() => void runPlaceSearch()} disabled={placeSearchState === "loading"}>
                  {placeSearchState === "loading" ? "搜索中" : "搜索"}
                </button>
              </div>
              {(placeSearchState === "empty" || placeSearchState === "error") && (
                <p className="place-search-error">
                  {placeSearchState === "empty" ? "没有找到匹配地点，请换个关键词。" : placeSearchError}
                </p>
              )}
              {placeCandidates.length > 0 && (
                <div className="favorite-place-candidates">
                  {placeCandidates.map((place) => (
                    <button key={place.id} onClick={() => chooseFavoritePlace(place)}>
                      <strong>{place.name}</strong>
                      <small>{place.district} · {place.address}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="scenario-section">
          <div className="lab-section-title"><strong>演示场景</strong><small>{editable ? "可选择是否覆盖实时数据" : "已锁定"}</small></div>
          <label className={`toggle-row ${editable ? "" : "is-locked"}`}>
            <div><strong>启用场景覆盖</strong><small>稳定触发低温、雨雪和低电量建议</small></div>
            <input
              type="checkbox"
              checked={value.enabled}
              disabled={!editable}
              onChange={(event) => update({ ...value, enabled: event.target.checked })}
            />
            <span />
          </label>
          <div className={`lab-controls ${value.enabled ? "" : "is-disabled"} ${editable ? "" : "is-locked"}`}>
            <label>
              <span>天气状况</span>
              <select
                value={value.condition}
                disabled={!editable}
                onChange={(event) => update({ ...value, condition: event.target.value })}
              >
                <option>晴</option><option>多云</option><option>小雨</option><option>暴雨</option><option>小雪</option>
              </select>
            </label>
            <label>
              <span>当前电量 <strong>{value.batteryPercent}%</strong></span>
              <input
                type="range"
                min="5"
                max="100"
                value={value.batteryPercent}
                disabled={!editable}
                onChange={(event) => update({ ...value, batteryPercent: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>座舱温度 <strong>{value.cabinTemperatureC}°C</strong></span>
              <input
                type="range"
                min="-5"
                max="45"
                value={value.cabinTemperatureC}
                disabled={!editable}
                onChange={(event) => update({ ...value, cabinTemperatureC: Number(event.target.value) })}
              />
            </label>
          </div>
        </section>
      </div>

      {editable && (
        <button className="primary-button full-width scenario-confirm" onClick={onConfirm}>
          锁定场景并开始对话 <ArrowIcon />
        </button>
      )}
    </section>
  );
}
