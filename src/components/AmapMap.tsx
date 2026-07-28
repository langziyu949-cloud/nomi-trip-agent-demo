"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from "react";

import type { Coordinates, TripPlan } from "@/lib/types";

interface AmapMapProps {
  plan: TripPlan | null;
}

interface AmapBrowserConfig {
  key: string;
  securityJsCode: string;
}

let loaderPromise: Promise<any> | null = null;

function hasValidCoordinates(position: Coordinates | null | undefined): position is Coordinates {
  return Boolean(position && Number.isFinite(position.lng) && Number.isFinite(position.lat));
}

async function fetchAmapBrowserConfig(): Promise<AmapBrowserConfig> {
  const response = await fetch("/api/providers/amap-browser-config", {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("AMAP_CONFIG_MISSING");
  const config = await response.json() as Partial<AmapBrowserConfig>;
  if (!config.key || !config.securityJsCode) {
    throw new Error("AMAP_CONFIG_MISSING");
  }
  return {
    key: config.key,
    securityJsCode: config.securityJsCode,
  };
}

function loadAmap(): Promise<any> {
  if (loaderPromise) return loaderPromise;
  loaderPromise = fetchAmapBrowserConfig().then(({ key, securityJsCode }) => {
    window._AMapSecurityConfig = { securityJsCode };
    return new Promise((resolve, reject) => {
      const start = () => {
        window.AMapLoader?.load({ key, version: "2.0" }).then(resolve).catch(reject);
      };
      if (window.AMapLoader) return start();
      const script = document.createElement("script");
      script.src = "https://webapi.amap.com/loader.js";
      script.async = true;
      script.onload = start;
      script.onerror = () => reject(new Error("AMAP_LOADER_FAILED"));
      document.head.appendChild(script);
    });
  });
  return loaderPromise;
}

export function AmapMap({ plan }: AmapMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<any>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    loadAmap()
      .then((AMap) => {
        if (cancelled || !containerRef.current) return;
        amapRef.current = AMap;
        mapRef.current = new AMap.Map(containerRef.current, {
          viewMode: "2D",
          zoom: 12,
          center: [121.4737, 31.2304],
          mapStyle: "amap://styles/whitesmoke",
          showBuildingBlock: false,
        });
        setStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus(error instanceof Error && error.message === "AMAP_CONFIG_MISSING" ? "missing" : "error");
      });
    return () => {
      cancelled = true;
      mapRef.current?.destroy?.();
      mapRef.current = null;
      amapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!AMap || !map || status !== "ready") return;

    map.clearMap();
    if (!plan) return;

    const overlays: any[] = [];

    plan.legs.forEach((leg) => {
      const path = leg.polyline
        .filter(hasValidCoordinates)
        .map((point) => [point.lng, point.lat]);
      if (path.length < 2) return;

      const polyline = new AMap.Polyline({
        path,
        strokeColor: "#2d7c70",
        strokeWeight: 7,
        strokeOpacity: 0.86,
        lineJoin: "round",
        lineCap: "round",
        zIndex: 20,
      });
      overlays.push(polyline);
    });

    const places = [
      plan.intent.origin.resolved
        ? { place: plan.intent.origin.resolved, label: "家", isOrigin: true }
        : null,
      ...plan.intent.stops.map((stop, index) => stop.resolved
        ? { place: stop.resolved, label: String(index + 1), isOrigin: false }
        : null),
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    places.forEach(({ place, label, isOrigin }) => {
      if (!hasValidCoordinates(place.location)) return;

      const content = document.createElement("div");
      content.className = `amap-stop-marker${isOrigin ? " is-origin" : ""}`;
      const markerLabel = document.createElement("span");
      markerLabel.textContent = label;
      const markerName = document.createElement("em");
      markerName.textContent = place.name;
      content.append(markerLabel, markerName);

      const marker = new AMap.Marker({
        position: [place.location.lng, place.location.lat],
        anchor: "center",
        content,
        zIndex: 40,
      });
      overlays.push(marker);
    });

    if (overlays.length) map.add(overlays);
    if (overlays.length) map.setFitView(overlays, false, [80, 80, 160, 80], 15);
  }, [plan, status]);

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map-canvas" />
      {status !== "ready" && (
        <div className="map-placeholder">
          <div className="map-grid-lines" />
          <div className="map-placeholder-card">
            <span className="map-pin-dot" />
            <strong>{status === "missing" ? "等待连接高德地图" : status === "error" ? "地图加载失败" : "正在加载地图"}</strong>
            <p>{status === "missing" ? "配置 .env.local 后即可显示真实路线" : "请检查网络或高德凭证"}</p>
          </div>
        </div>
      )}
    </div>
  );
}
