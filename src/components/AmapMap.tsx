"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from "react";

import type { Coordinates, TripPlan } from "@/lib/types";

interface AmapMapProps {
  plan: TripPlan | null;
  vehiclePosition: Coordinates | null;
  activeLegIndex: number;
}

let loaderPromise: Promise<any> | null = null;

function loadAmap(): Promise<any> {
  if (loaderPromise) return loaderPromise;
  const key = process.env.NEXT_PUBLIC_AMAP_JS_KEY;
  const securityJsCode = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;
  if (!key || !securityJsCode) return Promise.reject(new Error("AMAP_CONFIG_MISSING"));

  window._AMapSecurityConfig = { securityJsCode };
  loaderPromise = new Promise((resolve, reject) => {
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
  return loaderPromise;
}

export function AmapMap({ plan, vehiclePosition, activeLegIndex }: AmapMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<any>(null);
  const vehicleMarkerRef = useRef<any>(null);
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
        setStatus(error instanceof Error && error.message === "AMAP_CONFIG_MISSING" ? "missing" : "error");
      });
    return () => {
      cancelled = true;
      mapRef.current?.destroy?.();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!AMap || !map || !plan) return;

    map.clearMap();
    const overlays: any[] = [];
    plan.legs.forEach((leg, index) => {
      const polyline = new AMap.Polyline({
        path: leg.polyline.map((point) => [point.lng, point.lat]),
        strokeColor: index === activeLegIndex ? "#2d7c70" : "#8db5ad",
        strokeWeight: index === activeLegIndex ? 8 : 6,
        strokeOpacity: index === activeLegIndex ? 1 : 0.7,
        lineJoin: "round",
        lineCap: "round",
        zIndex: index === activeLegIndex ? 30 : 20,
      });
      overlays.push(polyline);
    });

    const places = [plan.intent.origin.resolved!, ...plan.intent.stops.map((stop) => stop.resolved!)];
    places.forEach((place, index) => {
      const marker = new AMap.Marker({
        position: [place.location.lng, place.location.lat],
        anchor: "center",
        content: `<div class="amap-stop-marker ${index === 0 ? "is-origin" : ""}"><span>${index === 0 ? "家" : index}</span><em>${place.name}</em></div>`,
        zIndex: 40,
      });
      overlays.push(marker);
    });

    vehicleMarkerRef.current = new AMap.Marker({
      position: [plan.legs[0].polyline[0].lng, plan.legs[0].polyline[0].lat],
      anchor: "center",
      content: '<div class="amap-vehicle-marker"><span>➤</span></div>',
      zIndex: 80,
    });
    overlays.push(vehicleMarkerRef.current);
    map.add(overlays);
    map.setFitView(overlays.filter((item) => item !== vehicleMarkerRef.current), false, [80, 80, 160, 80], 15);
  }, [plan, activeLegIndex]);

  useEffect(() => {
    if (!vehiclePosition || !vehicleMarkerRef.current) return;
    vehicleMarkerRef.current.setPosition([vehiclePosition.lng, vehiclePosition.lat]);
  }, [vehiclePosition]);

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
