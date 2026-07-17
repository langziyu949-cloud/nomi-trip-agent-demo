import { addCalendarDays, todayInShanghai } from "@/lib/date-utils";
import type {
  Coordinates,
  ResolvedPlace,
  RouteLeg,
  RouteStep,
  WeatherContext,
} from "@/lib/types";

const AMAP_BASE_URL = "https://restapi.amap.com";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = true,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function serviceKey(): string {
  const key = process.env.AMAP_WEB_SERVICE_KEY;
  if (!key) {
    throw new ProviderError(
      "尚未配置高德 Web 服务 Key，请先完成 .env.local 配置。",
      "AMAP_KEY_MISSING",
      false,
      503,
    );
  }
  return key;
}

async function fetchAmap<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, AMAP_BASE_URL);
  Object.entries({ ...params, key: serviceKey() }).forEach(([key, value]) => {
    if (value !== "") url.searchParams.set(key, value);
  });

  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(9000) });
  } catch {
    throw new ProviderError("暂时无法连接高德服务，请检查网络后重试。", "AMAP_NETWORK_ERROR");
  }

  if (!response.ok) {
    throw new ProviderError(`高德服务返回 ${response.status}。`, "AMAP_HTTP_ERROR");
  }

  const body = (await response.json()) as T & {
    status?: string;
    info?: string;
    infocode?: string;
  };
  if (body.status && body.status !== "1") {
    throw new ProviderError(
      body.info ? `高德服务：${body.info}` : "高德服务请求失败。",
      `AMAP_${body.infocode ?? "UNKNOWN"}`,
      body.infocode !== "10001",
      body.infocode === "10001" ? 401 : 502,
    );
  }
  return body;
}

function parseLocation(value: string): Coordinates | null {
  const [lng, lat] = value.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

export async function searchPlaces(query: string, city = "上海市"): Promise<ResolvedPlace[]> {
  interface PlaceResponse {
    pois?: Array<{
      id: string;
      name: string;
      address?: string;
      adname?: string;
      adcode?: string;
      location: string;
    }>;
  }

  const result = await fetchAmap<PlaceResponse>("/v5/place/text", {
    keywords: query,
    region: city,
    city_limit: "true",
    page_size: "3",
    page_num: "1",
  });

  return (result.pois ?? []).flatMap((poi) => {
    const location = parseLocation(poi.location);
    if (!location) return [];
    return [
      {
        id: poi.id,
        name: poi.name,
        address: poi.address ?? "地址信息暂缺",
        district: poi.adname ?? city,
        adcode: poi.adcode ?? "310000",
        location,
        source: "AMAP" as const,
      },
    ];
  });
}

function parsePolyline(value: string | undefined): Coordinates[] {
  if (!value) return [];
  return value.split(";").flatMap((pair) => {
    const location = parseLocation(pair);
    return location ? [location] : [];
  });
}

function dedupeCoordinates(points: Coordinates[]): Coordinates[] {
  return points.filter((point, index) => {
    if (index === 0) return true;
    const previous = points[index - 1];
    return point.lng !== previous.lng || point.lat !== previous.lat;
  });
}

export async function planRouteLeg(
  from: ResolvedPlace,
  to: ResolvedPlace,
): Promise<RouteLeg> {
  interface DirectionResponse {
    route?: {
      paths?: Array<{
        distance?: string;
        cost?: { duration?: string };
        duration?: string;
        steps?: Array<{
          instruction?: string;
          road_name?: string;
          step_distance?: string;
          distance?: string;
          polyline?: string;
        }>;
      }>;
    };
  }

  const result = await fetchAmap<DirectionResponse>("/v5/direction/driving", {
    origin: `${from.location.lng},${from.location.lat}`,
    destination: `${to.location.lng},${to.location.lat}`,
    origin_id: from.source === "AMAP" ? from.id : "",
    destination_id: to.source === "AMAP" ? to.id : "",
    strategy: "32",
    cartype: "1",
    show_fields: "cost,polyline",
  });
  const path = result.route?.paths?.[0];
  if (!path) {
    throw new ProviderError(`未找到“${from.name}”到“${to.name}”的驾车路线。`, "ROUTE_NOT_FOUND", false, 404);
  }

  const rawSteps = path.steps ?? [];
  const steps: RouteStep[] = rawSteps.map((step) => ({
    instruction: step.instruction ?? "沿当前道路行驶",
    roadName: step.road_name ?? "未知道路",
    distanceM: Number(step.step_distance ?? step.distance ?? 0),
  }));
  const polyline = dedupeCoordinates(rawSteps.flatMap((step) => parsePolyline(step.polyline)));
  if (polyline.length === 0) {
    throw new ProviderError("路线已计算，但高德未返回可绘制的轨迹。", "ROUTE_POLYLINE_MISSING");
  }

  return {
    from,
    to,
    distanceM: Number(path.distance ?? 0),
    durationSec: Number(path.cost?.duration ?? path.duration ?? 0),
    polyline,
    steps,
  };
}

function dateOffsetFromToday(targetDate: string): number {
  const today = todayInShanghai();
  for (let offset = 0; offset <= 4; offset += 1) {
    if (addCalendarDays(today, offset) === targetDate) return offset;
  }
  return -1;
}

export async function getWeather(
  adcode: string,
  targetDate: string,
  targetTime: string,
): Promise<WeatherContext> {
  const offset = dateOffsetFromToday(targetDate);
  if (offset < 0 || offset > 3) {
    return {
      available: false,
      condition: "暂无可靠天气",
      temperatureC: null,
      humidity: null,
      reportTime: null,
      source: "unavailable",
    };
  }

  if (offset === 0) {
    interface LiveWeatherResponse {
      lives?: Array<{
        weather: string;
        temperature: string;
        humidity?: string;
        reporttime?: string;
      }>;
    }
    const result = await fetchAmap<LiveWeatherResponse>("/v3/weather/weatherInfo", {
      city: adcode,
      extensions: "base",
    });
    const weather = result.lives?.[0];
    if (!weather) throw new ProviderError("高德未返回实时天气。", "WEATHER_NOT_FOUND");
    return {
      available: true,
      condition: weather.weather,
      temperatureC: Number(weather.temperature),
      humidity: weather.humidity ? Number(weather.humidity) : null,
      reportTime: weather.reporttime ?? null,
      source: "live",
    };
  }

  interface ForecastResponse {
    forecasts?: Array<{
      reporttime?: string;
      casts?: Array<{
        date: string;
        dayweather: string;
        nightweather: string;
        daytemp: string;
        nighttemp: string;
      }>;
    }>;
  }
  const result = await fetchAmap<ForecastResponse>("/v3/weather/weatherInfo", {
    city: adcode,
    extensions: "all",
  });
  const forecast = result.forecasts?.[0];
  const cast = forecast?.casts?.find((item) => item.date === targetDate);
  if (!cast) {
    return {
      available: false,
      condition: "暂无可靠天气",
      temperatureC: null,
      humidity: null,
      reportTime: forecast?.reporttime ?? null,
      source: "unavailable",
    };
  }
  const hour = Number(targetTime.split(":")[0]);
  const isDaytime = hour >= 8 && hour < 19;
  return {
    available: true,
    condition: isDaytime ? cast.dayweather : cast.nightweather,
    temperatureC: Number(isDaytime ? cast.daytemp : cast.nighttemp),
    humidity: null,
    reportTime: forecast?.reporttime ?? null,
    source: "forecast",
  };
}

export function providerHealth() {
  return {
    amapWebService: Boolean(process.env.AMAP_WEB_SERVICE_KEY),
    amapJsApi: Boolean(process.env.NEXT_PUBLIC_AMAP_JS_KEY),
    amapSecurityCode: Boolean(process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE),
  };
}
