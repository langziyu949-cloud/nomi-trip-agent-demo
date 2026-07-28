"use client";

import { useState } from "react";

import { ArrowIcon, CloseIcon } from "@/components/icons";
import type {
  DemoSettings,
  FavoritePlaceKey,
  PlaceSearchResponse,
  ResolvedPlace,
  ScenarioFavoritePlace,
} from "@/lib/types";

const FAVORITE_PLACE_LABELS: Record<FavoritePlaceKey, string> = {
  home: "家",
  school: "学校",
  company: "公司",
  wifeCompany: "家人公司",
};

const FAVORITE_PLACE_KEYS = Object.keys(FAVORITE_PLACE_LABELS) as FavoritePlaceKey[];
const WEATHER_OPTIONS = ["晴", "多云", "阴", "小雨", "中雨", "暴雨", "小雪", "大雪", "雷阵雨"];
const TEMPERATURE_OPTIONS = Array.from({ length: 12 }, (_, index) => -10 + index * 5);

type FavoriteLabelOption = FavoritePlaceKey | "custom";

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

function newFavoriteId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `favorite-${random}`;
}

export function ConversationScenario({
  value,
  mode,
  onChange,
  onConfirm,
  onClose,
}: ConversationScenarioProps) {
  const editable = mode === "setup";
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | "new" | null>(null);
  const [favoriteLabelOption, setFavoriteLabelOption] = useState<FavoriteLabelOption>("home");
  const [customFavoriteLabel, setCustomFavoriteLabel] = useState("");
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeCandidates, setPlaceCandidates] = useState<ResolvedPlace[]>([]);
  const [placeSearchState, setPlaceSearchState] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const [placeSearchError, setPlaceSearchError] = useState("");

  const update = (next: DemoSettings) => {
    if (editable) onChange?.(next);
  };

  const resetFavoriteEditor = () => {
    setEditingFavoriteId(null);
    setPlaceQuery("");
    setPlaceCandidates([]);
    setPlaceSearchState("idle");
    setPlaceSearchError("");
    setCustomFavoriteLabel("");
  };

  const firstAvailableLabel = (): FavoriteLabelOption =>
    FAVORITE_PLACE_KEYS.find((key) => !value.favoritePlaces.some((item) => item.key === key))
    ?? "custom";

  const beginAddFavorite = () => {
    const label = firstAvailableLabel();
    setEditingFavoriteId("new");
    setFavoriteLabelOption(label);
    setCustomFavoriteLabel("");
    setPlaceQuery("");
    setPlaceCandidates([]);
    setPlaceSearchState("idle");
    setPlaceSearchError("");
  };

  const beginFavoriteEdit = (favorite: ScenarioFavoritePlace) => {
    setEditingFavoriteId(favorite.id);
    setFavoriteLabelOption(favorite.key ?? "custom");
    setCustomFavoriteLabel(favorite.key ? "" : favorite.label);
    setPlaceQuery(favorite.place.name || favorite.place.address);
    setPlaceCandidates([]);
    setPlaceSearchState("idle");
    setPlaceSearchError("");
  };

  const removeFavorite = (id: string) => {
    update({
      ...value,
      favoritePlaces: value.favoritePlaces.filter((item) => item.id !== id),
    });
    if (editingFavoriteId === id) resetFavoriteEditor();
  };

  const runPlaceSearch = async () => {
    if (!placeQuery.trim()) return;
    if (favoriteLabelOption === "custom" && !customFavoriteLabel.trim()) {
      setPlaceSearchError("先为这个常用地点填写一个标签。");
      setPlaceSearchState("error");
      return;
    }
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
    if (!editingFavoriteId) return;
    const key = favoriteLabelOption === "custom" ? null : favoriteLabelOption;
    const label = key ? FAVORITE_PLACE_LABELS[key] : customFavoriteLabel.trim();
    if (!label) return;
    const favorite: ScenarioFavoritePlace = {
      id: editingFavoriteId === "new" ? newFavoriteId() : editingFavoriteId,
      key,
      label,
      place: { ...place, source: "FAVORITE" },
    };
    update({
      ...value,
      favoritePlaces: editingFavoriteId === "new"
        ? [...value.favoritePlaces, favorite]
        : value.favoritePlaces.map((item) => item.id === editingFavoriteId ? favorite : item),
    });
    resetFavoriteEditor();
  };

  const customSummary = [
    value.weatherOverrideEnabled ? `${value.condition} ${value.temperatureC}°C` : "实际天气",
    value.batteryOverrideEnabled ? `${value.batteryPercent}% 电量` : "80% 电量",
    value.favoritePlacesEnabled && value.favoritePlaces.length
      ? `${value.favoritePlaces.length} 个常用地点`
      : "不使用常用地点",
  ].join(" · ");

  return (
    <section className={`conversation-scenario ${editable ? "is-setup" : "is-readonly"}`}>
      <div className="scenario-heading">
        <div>
          <span className="eyebrow">{editable ? "NEW CONVERSATION" : "CONVERSATION SCENE"}</span>
          <h2>{editable ? "设置本次行程场景" : "本次对话场景"}</h2>
        </div>
        {!editable && onClose && (
          <button className="icon-button" onClick={onClose} aria-label="关闭场景详情">
            <CloseIcon />
          </button>
        )}
      </div>

      <p className="scenario-lock-note">
        {editable
          ? "默认使用实际天气、80% 电量，NOMI 会主动备车。只需打开你想自定义的部分。"
          : `${customSummary}。该场景已随对话锁定。`}
      </p>

      <div className="scenario-scroll-area">
        <section className="scenario-section">
          <div className="scenario-default-card">
            <div>
              <span className="scenario-status-dot" />
              <div>
                <strong>NOMI 主动备车</strong>
                <small>{value.preconditionVehicle
                  ? "默认开启，会结合天气和出发时间准备座舱"
                  : "这个历史场景未开启主动备车"}</small>
              </div>
            </div>
            <em>{value.preconditionVehicle ? "已开启" : "未开启"}</em>
          </div>
        </section>

        <section className="scenario-section">
          <div className="lab-section-title">
            <strong>天气</strong>
            <small>{value.weatherOverrideEnabled ? "使用自定义场景" : "使用高德实际天气"}</small>
          </div>
          {editable ? (
            <label className="toggle-row scenario-toggle">
              <div><strong>自定义天气</strong><small>用于稳定演示雨雪、高温或低温场景</small></div>
              <input
                type="checkbox"
                checked={value.weatherOverrideEnabled}
                onChange={(event) => update({
                  ...value,
                  weatherOverrideEnabled: event.target.checked,
                })}
              />
              <span />
            </label>
          ) : (
            <div className="scenario-readonly-row">
              <span>{value.weatherOverrideEnabled ? "自定义天气" : "实际天气"}</span>
              <strong>{value.weatherOverrideEnabled ? `${value.condition} · ${value.temperatureC}°C` : "规划时实时获取"}</strong>
            </div>
          )}
          {editable && value.weatherOverrideEnabled && (
            <div className="scenario-options-grid is-weather">
              <label>
                <span>天气状况</span>
                <select
                  value={value.condition}
                  onChange={(event) => update({ ...value, condition: event.target.value })}
                >
                  {WEATHER_OPTIONS.map((condition) => <option key={condition}>{condition}</option>)}
                </select>
              </label>
              <label>
                <span>气温</span>
                <select
                  value={value.temperatureC}
                  onChange={(event) => update({ ...value, temperatureC: Number(event.target.value) })}
                >
                  {TEMPERATURE_OPTIONS.map((temperature) => (
                    <option value={temperature} key={temperature}>{temperature}°C</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </section>

        <section className="scenario-section">
          <div className="lab-section-title">
            <strong>车辆电量</strong>
            <small>{value.batteryOverrideEnabled ? "使用自定义电量" : "默认 80%"}</small>
          </div>
          {editable ? (
            <label className="toggle-row scenario-toggle">
              <div><strong>自定义电量</strong><small>打开后可模拟低电量和补能建议</small></div>
              <input
                type="checkbox"
                checked={value.batteryOverrideEnabled}
                onChange={(event) => update({
                  ...value,
                  batteryOverrideEnabled: event.target.checked,
                })}
              />
              <span />
            </label>
          ) : (
            <div className="scenario-readonly-row">
              <span>{value.batteryOverrideEnabled ? "自定义电量" : "默认电量"}</span>
              <strong>{value.batteryOverrideEnabled ? value.batteryPercent : 80}%</strong>
            </div>
          )}
          {editable && value.batteryOverrideEnabled && (
            <label className="scenario-range-card">
              <span><strong>当前电量</strong><em>{value.batteryPercent}%</em></span>
              <input
                type="range"
                min="5"
                max="100"
                value={value.batteryPercent}
                onChange={(event) => update({
                  ...value,
                  batteryPercent: Number(event.target.value),
                })}
              />
              <small><span>5%</span><span>100%</span></small>
            </label>
          )}
        </section>

        <section className="scenario-section">
          <div className="lab-section-title">
            <strong>常用地点</strong>
            <small>{value.favoritePlacesEnabled ? "仅用于本次对话" : "默认不设置"}</small>
          </div>
          {editable ? (
            <label className="toggle-row scenario-toggle">
              <div><strong>设置常用地点</strong><small>用“家、学校、公司”等简称直接规划</small></div>
              <input
                type="checkbox"
                checked={value.favoritePlacesEnabled}
                onChange={(event) => update({
                  ...value,
                  favoritePlacesEnabled: event.target.checked,
                })}
              />
              <span />
            </label>
          ) : !value.favoritePlacesEnabled || value.favoritePlaces.length === 0 ? (
            <div className="scenario-empty-state is-readonly">本次对话未设置常用地点</div>
          ) : null}

          {value.favoritePlacesEnabled && (
            <div className="scenario-favorites">
              {value.favoritePlaces.map((favorite) => (
                <div className="scenario-favorite-card" key={favorite.id}>
                  <div>
                    <span>{favorite.label}</span>
                    <strong>{favorite.place.name}</strong>
                    <small>{favorite.place.district} · {favorite.place.address}</small>
                  </div>
                  {editable && (
                    <div className="scenario-favorite-actions">
                      <button onClick={() => beginFavoriteEdit(favorite)}>修改</button>
                      <button onClick={() => removeFavorite(favorite.id)}>移除</button>
                    </div>
                  )}
                </div>
              ))}

              {editable && editingFavoriteId === null && (
                <button className="scenario-add-favorite" onClick={beginAddFavorite}>
                  ＋ 添加常用地点
                </button>
              )}

              {editable && editingFavoriteId !== null && (
                <div className="favorite-place-editor scenario-place-editor">
                  <div className="favorite-label-options" role="group" aria-label="常用地点标签">
                    {FAVORITE_PLACE_KEYS.map((key) => {
                      const usedByAnother = value.favoritePlaces.some((item) =>
                        item.key === key && item.id !== editingFavoriteId,
                      );
                      return (
                        <button
                          className={favoriteLabelOption === key ? "is-selected" : ""}
                          disabled={usedByAnother}
                          key={key}
                          onClick={() => {
                            setFavoriteLabelOption(key);
                            setPlaceSearchError("");
                          }}
                        >
                          {FAVORITE_PLACE_LABELS[key]}
                        </button>
                      );
                    })}
                    <button
                      className={favoriteLabelOption === "custom" ? "is-selected" : ""}
                      onClick={() => setFavoriteLabelOption("custom")}
                    >
                      自定义
                    </button>
                  </div>
                  {favoriteLabelOption === "custom" && (
                    <input
                      className="favorite-custom-label"
                      value={customFavoriteLabel}
                      maxLength={8}
                      onChange={(event) => {
                        setCustomFavoriteLabel(event.target.value);
                        setPlaceSearchError("");
                      }}
                      placeholder="输入标签，如：健身房"
                    />
                  )}
                  <div className="place-search-row">
                    <input
                      value={placeQuery}
                      onChange={(event) => setPlaceQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void runPlaceSearch();
                        }
                      }}
                      placeholder="搜索具体地址"
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
                  <button className="scenario-editor-cancel" onClick={resetFavoriteEditor}>取消</button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {editable && (
        <button className="primary-button full-width scenario-confirm" onClick={onConfirm}>
          保存场景并开始对话 <ArrowIcon />
        </button>
      )}
    </section>
  );
}
