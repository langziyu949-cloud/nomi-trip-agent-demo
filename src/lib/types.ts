export type ConstraintType = "ARRIVE_BY" | "DEPART_AT";

export type PlaceSource = "FAVORITE" | "AMAP";

export type FavoritePlaceKey = "home" | "company" | "school" | "wifeCompany";

export interface Coordinates {
  lng: number;
  lat: number;
}

export interface ResolvedPlace {
  id: string;
  name: string;
  address: string;
  district: string;
  adcode: string;
  location: Coordinates;
  source: PlaceSource;
}

export interface PlaceDraft {
  key: string;
  label: string;
  query: string;
  resolved: ResolvedPlace | null;
}

export interface TimeConstraint {
  type: ConstraintType;
  time: string;
  targetStopIndex: number;
  inferred: boolean;
}

export interface IntentUnderstandingMeta {
  provider: "mock" | "minimax";
  model: string | null;
  fallback: boolean;
}

export interface TripIntentDraft {
  rawText: string;
  date: string;
  city: string;
  origin: PlaceDraft;
  stops: PlaceDraft[];
  timeConstraint: TimeConstraint;
  timeConstraints?: TimeConstraint[];
  preferences: string[];
  confidence: number;
  issues: string[];
  understanding?: IntentUnderstandingMeta;
}

export interface RouteStep {
  instruction: string;
  roadName: string;
  distanceM: number;
}

export interface RouteLeg {
  from: ResolvedPlace;
  to: ResolvedPlace;
  distanceM: number;
  durationSec: number;
  polyline: Coordinates[];
  steps: RouteStep[];
}

export interface WeatherContext {
  available: boolean;
  condition: string;
  temperatureC: number | null;
  humidity: number | null;
  reportTime: string | null;
  source: "live" | "forecast" | "override" | "unavailable";
}

export interface VehicleContext {
  batteryPercent: number;
  estimatedArrivalBattery: number;
  cabinTemperatureC: number;
  consumptionKwhPer100Km: number;
  batteryCapacityKwh: number;
  source: "mock" | "override";
}

export type ActionType =
  | "PREHEAT"
  | "PRECOOL"
  | "SEAT_HEAT"
  | "DEFOG"
  | "UMBRELLA"
  | "LEAVE_BUFFER"
  | "ENERGY_LOW"
  | "ENERGY_CRITICAL";

export interface ProactiveAction {
  id: string;
  type: ActionType;
  title: string;
  detail: string;
  scheduledAt: string | null;
  severity: "info" | "suggestion" | "warning" | "critical";
}

export interface TripStopPlan {
  place: ResolvedPlace;
  eta: string;
  dateTime: string;
  departureTime?: string | null;
  departureDateTime?: string | null;
  dwellSec?: number;
}

export interface TripPlan {
  id: string;
  createdAt: string;
  intent: TripIntentDraft;
  departureAt: string;
  departureTime: string;
  totalDistanceM: number;
  totalDurationSec: number;
  planningBufferSec: number;
  legs: RouteLeg[];
  stops: TripStopPlan[];
  weather: WeatherContext;
  vehicle: VehicleContext;
  actions: ProactiveAction[];
  notes: string[];
}

export interface DemoOverrides {
  enabled: boolean;
  condition: string;
  batteryPercent: number;
  cabinTemperatureC: number;
}

export interface DemoSettings extends DemoOverrides {
  preconditionVehicle: boolean;
  favoritePlaces: Record<FavoritePlaceKey, ResolvedPlace>;
}

export interface PlaceSearchResponse {
  candidates: ResolvedPlace[];
  provider: "amap";
}

export interface ProviderErrorPayload {
  error: string;
  code: string;
  retryable: boolean;
}

export interface TripNarrationResponse {
  text: string;
  provider: "minimax" | "template";
  model: string | null;
  generatedAt: string;
  fallback: boolean;
  errorCode?: string;
  fallbackReason?: string;
}
