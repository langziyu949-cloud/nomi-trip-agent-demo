import {
  createChatMessage,
  createEmptyConversation,
  draftConversationTitle,
  plannedConversationTitle,
  type Conversation,
  type ConversationIdFactory,
} from "@/lib/conversations";
import {
  ResolvedPlaceSchema,
  TripIntentDraftSchema,
} from "@/lib/conversation-turn";
import type {
  DemoSettings,
  TripIntentDraft,
  TripPlan,
} from "@/lib/types";
import { z } from "zod";

export const CONVERSATION_DB_NAME = "nomi-trip-conversations";
export const CONVERSATION_DB_VERSION = 1;
export const CONVERSATIONS_STORE_NAME = "conversations";
export const CONVERSATION_META_STORE_NAME = "meta";
export const ACTIVE_CONVERSATION_META_KEY = "activeConversationId";
export const LEGACY_MIGRATION_META_KEY = "legacyLocalStorageMigrationV1";

export const LEGACY_INTENT_STORAGE_KEY = "nomi-demo-intent";
export const LEGACY_PLAN_STORAGE_KEY = "nomi-demo-plan";
export const LEGACY_DEMO_SETTINGS_STORAGE_KEY = "nomi-demo-overrides";

export type ConversationStoreErrorCode =
  | "UNAVAILABLE"
  | "OPEN_FAILED"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "INVALID_DATA"
  | "MIGRATION_FAILED";

export class ConversationStoreError extends Error {
  readonly code: ConversationStoreErrorCode;
  readonly operation: string;
  readonly originalError: unknown;

  constructor(
    code: ConversationStoreErrorCode,
    operation: string,
    message: string,
    originalError?: unknown,
  ) {
    super(message);
    this.name = "ConversationStoreError";
    this.code = code;
    this.operation = operation;
    this.originalError = originalError;
  }
}

export interface ConversationPersistence {
  readonly persistent: boolean;
  loadConversations(): Promise<Conversation[]>;
  loadConversation(id: string): Promise<Conversation | null>;
  saveConversation(conversation: Conversation): Promise<void>;
  saveConversations(conversations: readonly Conversation[]): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  getActiveConversationId(): Promise<string | null>;
  setActiveConversationId(id: string | null): Promise<void>;
  close(): void;
}

export interface LegacyStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export interface LegacyConversationSnapshot {
  intentJson: string | null;
  planJson: string | null;
  demoSettingsJson: string | null;
}

export interface LegacyConversationOptions {
  defaultDemoSettings?: DemoSettings | null;
  now?: string;
  idFactory?: ConversationIdFactory;
}

export interface IndexedDbConversationStoreOptions extends LegacyConversationOptions {
  indexedDB?: IDBFactory | null;
  databaseName?: string;
  legacyStorage?: LegacyStorage | null;
}

export interface MemoryConversationStoreOptions {
  conversations?: readonly Conversation[];
  activeConversationId?: string | null;
}

interface MetaRecord {
  key: string;
  value: unknown;
}

function asStoreError(
  error: unknown,
  code: ConversationStoreErrorCode,
  operation: string,
  message: string,
): ConversationStoreError {
  return error instanceof ConversationStoreError
    ? error
    : new ConversationStoreError(code, operation, message, error);
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTripIntentDraft(value: unknown): value is TripIntentDraft {
  return TripIntentDraftSchema.safeParse(value).success;
}

const CoordinatesSchema = z.object({
  lng: z.number().finite(),
  lat: z.number().finite(),
}).strict();

const RouteStepSchema = z.object({
  instruction: z.string(),
  roadName: z.string(),
  distanceM: z.number().finite().min(0),
}).strict();

const RouteLegSchema = z.object({
  from: ResolvedPlaceSchema,
  to: ResolvedPlaceSchema,
  distanceM: z.number().finite().min(0),
  durationSec: z.number().finite().min(0),
  polyline: z.array(CoordinatesSchema),
  steps: z.array(RouteStepSchema),
}).strict();

const TripStopPlanSchema = z.object({
  place: ResolvedPlaceSchema,
  eta: z.string(),
  dateTime: z.string(),
  departureTime: z.string().nullable().optional(),
  departureDateTime: z.string().nullable().optional(),
  dwellSec: z.number().finite().min(0).optional(),
}).strict();

const WeatherContextSchema = z.object({
  available: z.boolean(),
  condition: z.string(),
  temperatureC: z.number().finite().nullable(),
  humidity: z.number().finite().nullable(),
  reportTime: z.string().nullable(),
  source: z.enum(["live", "forecast", "override", "unavailable"]),
}).strict();

const VehicleContextSchema = z.object({
  batteryPercent: z.number().finite(),
  estimatedArrivalBattery: z.number().finite(),
  cabinTemperatureC: z.number().finite(),
  consumptionKwhPer100Km: z.number().finite(),
  batteryCapacityKwh: z.number().finite(),
  source: z.enum(["mock", "override"]),
}).strict();

const ProactiveActionSchema = z.object({
  id: z.string(),
  type: z.enum([
    "PREHEAT",
    "PRECOOL",
    "SEAT_HEAT",
    "DEFOG",
    "UMBRELLA",
    "LEAVE_BUFFER",
    "ENERGY_LOW",
    "ENERGY_CRITICAL",
  ]),
  title: z.string(),
  detail: z.string(),
  scheduledAt: z.string().nullable(),
  severity: z.enum(["info", "suggestion", "warning", "critical"]),
}).strict();

const TripPlanSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  intent: TripIntentDraftSchema,
  departureAt: z.string(),
  departureTime: z.string(),
  totalDistanceM: z.number().finite().min(0),
  totalDurationSec: z.number().finite().min(0),
  planningBufferSec: z.number().finite().min(0),
  legs: z.array(RouteLegSchema),
  stops: z.array(TripStopPlanSchema),
  weather: WeatherContextSchema,
  vehicle: VehicleContextSchema,
  actions: z.array(ProactiveActionSchema),
  notes: z.array(z.string()),
}).strict();

function isTripPlan(value: unknown): value is TripPlan {
  return TripPlanSchema.safeParse(value).success;
}

const FavoritePlacesSchema = z.object({
  home: ResolvedPlaceSchema,
  company: ResolvedPlaceSchema,
  school: ResolvedPlaceSchema,
  wifeCompany: ResolvedPlaceSchema,
}).strict();

const DemoSettingsSchema = z.object({
  enabled: z.boolean(),
  condition: z.string(),
  batteryPercent: z.number().finite(),
  cabinTemperatureC: z.number().finite(),
  preconditionVehicle: z.boolean(),
  favoritePlaces: FavoritePlacesSchema,
}).strict();

function isDemoSettings(value: unknown): value is DemoSettings {
  return DemoSettingsSchema.safeParse(value).success;
}

const ChatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  turnId: z.string(),
  role: z.enum(["user", "assistant"]),
  kind: z.enum(["text", "plan", "clarification", "error", "status"]),
  status: z.enum(["pending", "complete", "failed"]),
  planId: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
}).strict();

const TurnErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
  retryable: z.boolean(),
}).strict();

const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(ChatMessageSchema),
  trip: z.object({
    currentIntent: TripIntentDraftSchema.nullable(),
    currentPlan: TripPlanSchema.nullable(),
    pendingIntent: TripIntentDraftSchema.nullable(),
    planUpdatedAt: z.string().nullable(),
    lastSuccessfulTurnId: z.string().nullable(),
  }).strict(),
  turn: z.object({
    turnId: z.string().nullable(),
    status: z.enum([
      "idle",
      "pending",
      "resolving_places",
      "planning",
      "answering",
      "complete",
      "failed",
      "cancelled",
    ]),
    startedAt: z.string().nullable(),
    updatedAt: z.string(),
    error: TurnErrorSchema.nullable(),
  }).strict(),
  scenario: z.object({
    demoSettings: DemoSettingsSchema.nullable(),
    ready: z.boolean(),
    lockedAt: z.string().nullable(),
  }).strict(),
}).strict().superRefine((conversation, context) => {
  conversation.messages.forEach((message, index) => {
    if (message.conversationId !== conversation.id) {
      context.addIssue({
        code: "custom",
        path: ["messages", index, "conversationId"],
        message: "消息不属于当前会话",
      });
    }
  });
  const scenarioIsConsistent = conversation.scenario.ready
    ? conversation.scenario.demoSettings !== null && conversation.scenario.lockedAt !== null
    : conversation.scenario.demoSettings === null && conversation.scenario.lockedAt === null;
  if (!scenarioIsConsistent) {
    context.addIssue({
      code: "custom",
      path: ["scenario"],
      message: "会话场景的锁定状态不一致",
    });
  }
});

export function isConversation(value: unknown): value is Conversation {
  return ConversationSchema.safeParse(value).success;
}

export function sortConversationsByUpdatedAt(
  conversations: readonly Conversation[],
): Conversation[] {
  return [...conversations].sort((left, right) => {
    const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
    return byUpdatedAt || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
  });
}

function parseLegacyJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ConversationStoreError(
      "MIGRATION_FAILED",
      "parseLegacyStorage",
      `旧版${label}数据无法解析，原数据已保留。`,
      error,
    );
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function mergeLegacyDemoSettings(
  value: unknown,
  fallback: DemoSettings | null,
): DemoSettings {
  if (!isRecord(value)) {
    throw new ConversationStoreError(
      "MIGRATION_FAILED",
      "parseLegacyStorage",
      "旧版 Demo Lab 数据格式无效，原数据已保留。",
    );
  }
  const legacyTemperature = typeof value.temperatureC === "number" ? value.temperatureC : undefined;
  const favoritePlaces = isRecord(value.favoritePlaces)
    ? { ...(fallback?.favoritePlaces ?? {}), ...value.favoritePlaces }
    : fallback?.favoritePlaces;
  const candidate = {
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback?.enabled,
    condition: typeof value.condition === "string" ? value.condition : fallback?.condition,
    batteryPercent: typeof value.batteryPercent === "number"
      ? value.batteryPercent
      : fallback?.batteryPercent,
    cabinTemperatureC: typeof value.cabinTemperatureC === "number"
      ? value.cabinTemperatureC
      : legacyTemperature ?? fallback?.cabinTemperatureC,
    preconditionVehicle: typeof value.preconditionVehicle === "boolean"
      ? value.preconditionVehicle
      : fallback?.preconditionVehicle,
    favoritePlaces,
  };
  if (!isDemoSettings(candidate)) {
    throw new ConversationStoreError(
      "MIGRATION_FAILED",
      "parseLegacyStorage",
      "旧版 Demo Lab 数据不完整，原数据已保留。",
    );
  }
  return cloneValue(candidate);
}

export function readLegacyConversationSnapshot(storage: LegacyStorage): LegacyConversationSnapshot {
  try {
    return {
      intentJson: storage.getItem(LEGACY_INTENT_STORAGE_KEY),
      planJson: storage.getItem(LEGACY_PLAN_STORAGE_KEY),
      demoSettingsJson: storage.getItem(LEGACY_DEMO_SETTINGS_STORAGE_KEY),
    };
  } catch (error) {
    throw new ConversationStoreError(
      "MIGRATION_FAILED",
      "readLegacyStorage",
      "无法读取旧版行程记录，历史暂未保存。",
      error,
    );
  }
}

export function buildLegacyConversation(
  snapshot: LegacyConversationSnapshot,
  options: LegacyConversationOptions = {},
): Conversation | null {
  if (!snapshot.intentJson && !snapshot.planJson) return null;

  const parsedIntent = snapshot.intentJson
    ? parseLegacyJson(snapshot.intentJson, "行程")
    : null;
  const parsedPlan = snapshot.planJson
    ? parseLegacyJson(snapshot.planJson, "规划")
    : null;
  if (parsedIntent !== null && !isTripIntentDraft(parsedIntent)) {
    throw new ConversationStoreError(
      "MIGRATION_FAILED",
      "parseLegacyStorage",
      "旧版行程数据格式无效，原数据已保留。",
    );
  }
  if (parsedPlan !== null && !isTripPlan(parsedPlan)) {
    throw new ConversationStoreError(
      "MIGRATION_FAILED",
      "parseLegacyStorage",
      "旧版规划数据格式无效，原数据已保留。",
    );
  }

  const latestLegacyIntent = parsedIntent ?? parsedPlan?.intent ?? null;
  if (!latestLegacyIntent) return null;
  // A legacy edit could update nomi-demo-intent before a new route succeeded.
  // In that case the plan's own intent remains the last successful state and
  // the edited intent is retained separately for an explicit retry.
  const currentIntent = parsedPlan?.intent ?? latestLegacyIntent;
  const pendingIntent = parsedPlan
    && parsedIntent
    && !sameJsonValue(parsedIntent, parsedPlan.intent)
    ? parsedIntent
    : null;
  const timestamp = options.now ?? new Date().toISOString();
  const idFactory = options.idFactory;
  const conversation = createEmptyConversation({ now: timestamp, idFactory });
  const turnId = idFactory?.("turn") ?? `turn-legacy-${conversation.id}`;
  const demoSettings = snapshot.demoSettingsJson
    ? mergeLegacyDemoSettings(
      parseLegacyJson(snapshot.demoSettingsJson, "Demo Lab"),
      options.defaultDemoSettings ?? null,
    )
    : options.defaultDemoSettings
      ? cloneValue(options.defaultDemoSettings)
      : null;
  const userMessage = createChatMessage({
    conversationId: conversation.id,
    turnId,
    role: "user",
    content: latestLegacyIntent.rawText || "继续之前的行程",
    createdAt: timestamp,
  }, idFactory);
  const messages = parsedPlan
    ? [
      userMessage,
      createChatMessage({
        conversationId: conversation.id,
        turnId,
        role: "assistant",
        kind: "plan",
        status: "complete",
        planId: parsedPlan.id,
        content: "已恢复此前保存的行程规划。",
        createdAt: timestamp,
      }, idFactory),
    ]
    : [userMessage];

  return {
    ...conversation,
    title: parsedPlan
      ? plannedConversationTitle(parsedPlan)
      : draftConversationTitle(latestLegacyIntent.rawText),
    messages,
    trip: {
      currentIntent: cloneValue(currentIntent),
      currentPlan: parsedPlan ? cloneValue(parsedPlan) : null,
      pendingIntent: pendingIntent ? cloneValue(pendingIntent) : null,
      planUpdatedAt: parsedPlan?.createdAt ?? null,
      lastSuccessfulTurnId: parsedPlan ? turnId : null,
    },
    turn: {
      turnId,
      status: "complete",
      startedAt: timestamp,
      updatedAt: timestamp,
      error: null,
    },
    scenario: {
      demoSettings,
      ready: demoSettings !== null,
      lockedAt: demoSettings ? timestamp : null,
    },
  };
}

function cleanupLegacyStorage(storage: LegacyStorage): void {
  // The IndexedDB transaction has committed before this runs. A marker stored
  // in that same transaction prevents duplicate migrations if cleanup is denied.
  for (const key of [
    LEGACY_INTENT_STORAGE_KEY,
    LEGACY_PLAN_STORAGE_KEY,
    LEGACY_DEMO_SETTINGS_STORAGE_KEY,
  ]) {
    try {
      storage.removeItem(key);
    } catch {
      // A privacy/quota implementation may reject localStorage writes. The
      // committed migration remains valid and will not be duplicated.
    }
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function resolveDefaultIndexedDb(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function resolveDefaultLegacyStorage(): LegacyStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class IndexedDbConversationStore implements ConversationPersistence {
  readonly persistent = true;

  private readonly factory: IDBFactory | null;
  private readonly databaseName: string;
  private readonly legacyStorage: LegacyStorage | null;
  private readonly defaultDemoSettings: DemoSettings | null;
  private readonly migrationNow?: string;
  private readonly idFactory?: ConversationIdFactory;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbConversationStoreOptions = {}) {
    this.factory = options.indexedDB === undefined
      ? resolveDefaultIndexedDb()
      : options.indexedDB;
    this.databaseName = options.databaseName ?? CONVERSATION_DB_NAME;
    this.legacyStorage = options.legacyStorage === undefined
      ? resolveDefaultLegacyStorage()
      : options.legacyStorage;
    this.defaultDemoSettings = options.defaultDemoSettings
      ? cloneValue(options.defaultDemoSettings)
      : null;
    this.migrationNow = options.now;
    this.idFactory = options.idFactory;
  }

  private getDatabase(): Promise<IDBDatabase> {
    if (!this.factory) {
      return Promise.reject(new ConversationStoreError(
        "UNAVAILABLE",
        "open",
        "当前浏览器不支持历史存储，历史暂未保存。",
      ));
    }
    if (this.databasePromise) return this.databasePromise;

    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory!.open(this.databaseName, CONVERSATION_DB_VERSION);
      } catch (error) {
        reject(asStoreError(error, "OPEN_FAILED", "open", "无法打开历史存储，历史暂未保存。"));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CONVERSATIONS_STORE_NAME)) {
          const store = database.createObjectStore(CONVERSATIONS_STORE_NAME, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!database.objectStoreNames.contains(CONVERSATION_META_STORE_NAME)) {
          database.createObjectStore(CONVERSATION_META_STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(asStoreError(
        request.error,
        "OPEN_FAILED",
        "open",
        "无法打开历史存储，历史暂未保存。",
      ));
      request.onblocked = () => reject(new ConversationStoreError(
        "OPEN_FAILED",
        "open",
        "历史存储正在被另一个页面占用，请关闭旧页面后重试。",
      ));
    }).catch((error) => {
      this.databasePromise = null;
      throw error;
    });
    return this.databasePromise;
  }

  async loadConversations(): Promise<Conversation[]> {
    try {
      const database = await this.getDatabase();
      const transaction = database.transaction(CONVERSATIONS_STORE_NAME, "readonly");
      const request = transaction.objectStore(CONVERSATIONS_STORE_NAME).getAll();
      const [values] = await Promise.all([requestResult(request), transactionComplete(transaction)]);
      if (!values.every(isConversation)) {
        throw new ConversationStoreError(
          "INVALID_DATA",
          "loadConversations",
          "历史记录数据已损坏，历史暂未加载。",
        );
      }
      return sortConversationsByUpdatedAt(values.map((value) => cloneValue(value)));
    } catch (error) {
      throw asStoreError(error, "READ_FAILED", "loadConversations", "无法读取历史记录，历史暂未加载。");
    }
  }

  async loadConversation(id: string): Promise<Conversation | null> {
    try {
      const database = await this.getDatabase();
      const transaction = database.transaction(CONVERSATIONS_STORE_NAME, "readonly");
      const request = transaction.objectStore(CONVERSATIONS_STORE_NAME).get(id);
      const [value] = await Promise.all([requestResult(request), transactionComplete(transaction)]);
      if (value === undefined) return null;
      if (!isConversation(value)) {
        throw new ConversationStoreError(
          "INVALID_DATA",
          "loadConversation",
          "该历史记录数据已损坏，暂时无法加载。",
        );
      }
      return cloneValue(value);
    } catch (error) {
      throw asStoreError(error, "READ_FAILED", "loadConversation", "无法读取历史记录，历史暂未加载。");
    }
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.saveConversations([conversation]);
  }

  async saveConversations(conversations: readonly Conversation[]): Promise<void> {
    if (!conversations.every(isConversation)) {
      throw new ConversationStoreError(
        "INVALID_DATA",
        "saveConversations",
        "会话数据不完整，未写入历史记录。",
      );
    }
    try {
      const database = await this.getDatabase();
      const transaction = database.transaction(CONVERSATIONS_STORE_NAME, "readwrite");
      const store = transaction.objectStore(CONVERSATIONS_STORE_NAME);
      for (const conversation of conversations) store.put(cloneValue(conversation));
      await transactionComplete(transaction);
    } catch (error) {
      throw asStoreError(error, "WRITE_FAILED", "saveConversations", "无法保存历史记录，历史暂未保存。");
    }
  }

  async deleteConversation(id: string): Promise<void> {
    try {
      const database = await this.getDatabase();
      const transaction = database.transaction(
        [CONVERSATIONS_STORE_NAME, CONVERSATION_META_STORE_NAME],
        "readwrite",
      );
      transaction.objectStore(CONVERSATIONS_STORE_NAME).delete(id);
      const metaStore = transaction.objectStore(CONVERSATION_META_STORE_NAME);
      const activeRequest = metaStore.get(ACTIVE_CONVERSATION_META_KEY);
      activeRequest.onsuccess = () => {
        const record = activeRequest.result as MetaRecord | undefined;
        if (record?.value === id) metaStore.delete(ACTIVE_CONVERSATION_META_KEY);
      };
      await transactionComplete(transaction);
    } catch (error) {
      throw asStoreError(error, "WRITE_FAILED", "deleteConversation", "无法更新历史记录。");
    }
  }

  private async getMetaValue(key: string): Promise<unknown | null> {
    const database = await this.getDatabase();
    const transaction = database.transaction(CONVERSATION_META_STORE_NAME, "readonly");
    const request = transaction.objectStore(CONVERSATION_META_STORE_NAME).get(key);
    const [record] = await Promise.all([requestResult(request), transactionComplete(transaction)]);
    return (record as MetaRecord | undefined)?.value ?? null;
  }

  async getActiveConversationId(): Promise<string | null> {
    try {
      const value = await this.getMetaValue(ACTIVE_CONVERSATION_META_KEY);
      if (value === null) return null;
      if (typeof value !== "string") {
        throw new ConversationStoreError(
          "INVALID_DATA",
          "getActiveConversationId",
          "当前会话标记已损坏。",
        );
      }
      return value;
    } catch (error) {
      throw asStoreError(error, "READ_FAILED", "getActiveConversationId", "无法恢复当前会话。");
    }
  }

  async setActiveConversationId(id: string | null): Promise<void> {
    try {
      const database = await this.getDatabase();
      const transaction = database.transaction(CONVERSATION_META_STORE_NAME, "readwrite");
      const store = transaction.objectStore(CONVERSATION_META_STORE_NAME);
      if (id === null) store.delete(ACTIVE_CONVERSATION_META_KEY);
      else store.put({ key: ACTIVE_CONVERSATION_META_KEY, value: id } satisfies MetaRecord);
      await transactionComplete(transaction);
    } catch (error) {
      throw asStoreError(error, "WRITE_FAILED", "setActiveConversationId", "无法保存当前会话。");
    }
  }

  private async commitLegacyMigration(conversation: Conversation): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [CONVERSATIONS_STORE_NAME, CONVERSATION_META_STORE_NAME],
      "readwrite",
    );
    transaction.objectStore(CONVERSATIONS_STORE_NAME).put(cloneValue(conversation));
    const metaStore = transaction.objectStore(CONVERSATION_META_STORE_NAME);
    metaStore.put({
      key: ACTIVE_CONVERSATION_META_KEY,
      value: conversation.id,
    } satisfies MetaRecord);
    metaStore.put({
      key: LEGACY_MIGRATION_META_KEY,
      value: conversation.id,
    } satisfies MetaRecord);
    await transactionComplete(transaction);
  }

  async migrateLegacyConversation(
    options: LegacyConversationOptions & { storage?: LegacyStorage | null } = {},
  ): Promise<Conversation | null> {
    const storage = options.storage === undefined ? this.legacyStorage : options.storage;
    if (!storage) return null;
    try {
      const migratedId = await this.getMetaValue(LEGACY_MIGRATION_META_KEY);
      if (migratedId !== null) {
        if (typeof migratedId !== "string") {
          throw new ConversationStoreError(
            "INVALID_DATA",
            "migrateLegacyConversation",
            "旧版迁移标记已损坏。",
          );
        }
        const migrated = await this.loadConversation(migratedId);
        cleanupLegacyStorage(storage);
        return migrated;
      }

      const snapshot = readLegacyConversationSnapshot(storage);
      const conversation = buildLegacyConversation(snapshot, {
        defaultDemoSettings: options.defaultDemoSettings === undefined
          ? this.defaultDemoSettings
          : options.defaultDemoSettings,
        now: options.now ?? this.migrationNow,
        idFactory: options.idFactory ?? this.idFactory,
      });
      if (!conversation) return null;
      await this.commitLegacyMigration(conversation);
      cleanupLegacyStorage(storage);
      return cloneValue(conversation);
    } catch (error) {
      throw asStoreError(
        error,
        "MIGRATION_FAILED",
        "migrateLegacyConversation",
        "无法迁移旧版行程，原数据已保留。",
      );
    }
  }

  close(): void {
    if (!this.databasePromise) return;
    void this.databasePromise.then((database) => database.close()).catch(() => undefined);
    this.databasePromise = null;
  }
}

export class MemoryConversationStore implements ConversationPersistence {
  readonly persistent = false;

  private conversations = new Map<string, Conversation>();
  private activeConversationId: string | null;

  constructor(options: MemoryConversationStoreOptions = {}) {
    for (const conversation of options.conversations ?? []) {
      if (!isConversation(conversation)) {
        throw new ConversationStoreError(
          "INVALID_DATA",
          "MemoryConversationStore",
          "会话数据不完整。",
        );
      }
      this.conversations.set(conversation.id, cloneValue(conversation));
    }
    this.activeConversationId = options.activeConversationId ?? null;
  }

  async loadConversations(): Promise<Conversation[]> {
    return sortConversationsByUpdatedAt(
      [...this.conversations.values()].map((conversation) => cloneValue(conversation)),
    );
  }

  async loadConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    return conversation ? cloneValue(conversation) : null;
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.saveConversations([conversation]);
  }

  async saveConversations(conversations: readonly Conversation[]): Promise<void> {
    if (!conversations.every(isConversation)) {
      throw new ConversationStoreError(
        "INVALID_DATA",
        "saveConversations",
        "会话数据不完整。",
      );
    }
    for (const conversation of conversations) {
      this.conversations.set(conversation.id, cloneValue(conversation));
    }
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    if (this.activeConversationId === id) this.activeConversationId = null;
  }

  async getActiveConversationId(): Promise<string | null> {
    return this.activeConversationId;
  }

  async setActiveConversationId(id: string | null): Promise<void> {
    this.activeConversationId = id;
  }

  close(): void {
    // No resources are held by the in-memory fallback.
  }
}

export function createConversationStore(
  options: IndexedDbConversationStoreOptions = {},
): IndexedDbConversationStore {
  return new IndexedDbConversationStore(options);
}

export function createMemoryConversationStore(
  options: MemoryConversationStoreOptions = {},
): MemoryConversationStore {
  return new MemoryConversationStore(options);
}
