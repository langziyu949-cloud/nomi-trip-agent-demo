import type { DemoSettings, TripIntentDraft, TripPlan } from "@/lib/types";

export const DEFAULT_CONVERSATION_TITLE = "新行程";
export const DEFAULT_HISTORY_MESSAGE_LIMIT = 20;
export const DEFAULT_HISTORY_CHARACTER_LIMIT = 12_000;

export type ChatRole = "user" | "assistant";
export type ChatMessageKind = "text" | "plan" | "clarification" | "error" | "status";
export type ChatMessageStatus = "pending" | "complete" | "failed";

export interface ChatMessage {
  id: string;
  conversationId: string;
  turnId: string;
  role: ChatRole;
  kind: ChatMessageKind;
  status: ChatMessageStatus;
  planId: string | null;
  content: string;
  createdAt: string;
}

export interface ConversationTripState {
  currentIntent: TripIntentDraft | null;
  currentPlan: TripPlan | null;
  pendingIntent: TripIntentDraft | null;
  planUpdatedAt: string | null;
  lastSuccessfulTurnId: string | null;
}

export type TurnStatus =
  | "idle"
  | "pending"
  | "resolving_places"
  | "planning"
  | "answering"
  | "complete"
  | "failed"
  | "cancelled";

export interface TurnError {
  message: string;
  code: string;
  retryable: boolean;
}

export interface TurnState {
  turnId: string | null;
  status: TurnStatus;
  startedAt: string | null;
  updatedAt: string;
  error: TurnError | null;
}

/**
 * Demo settings belong to one conversation and become immutable once ready.
 * New conversations deliberately start without a scenario so the UI can ask
 * the user to confirm the Demo Lab values before the first turn.
 */
export interface ConversationScenario {
  demoSettings: DemoSettings | null;
  ready: boolean;
  lockedAt: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  trip: ConversationTripState;
  turn: TurnState;
  scenario: ConversationScenario;
}

export type ConversationIdFactory = (prefix: "conversation" | "message" | "turn") => string;

export interface CreateEmptyConversationOptions {
  id?: string;
  title?: string;
  now?: string;
  idFactory?: ConversationIdFactory;
}

export interface CreateChatMessageInput {
  id?: string;
  conversationId: string;
  turnId: string;
  role: ChatRole;
  kind?: ChatMessageKind;
  status?: ChatMessageStatus;
  planId?: string | null;
  content: string;
  createdAt?: string;
}

export interface ClipRecentMessagesOptions {
  maxMessages?: number;
  maxCharacters?: number;
}

export interface BeginConversationTurnOptions {
  turnId?: string;
  pendingIntent?: TripIntentDraft | null;
  status?: Exclude<TurnStatus, "idle" | "complete" | "failed" | "cancelled">;
  now?: string;
  idFactory?: ConversationIdFactory;
}

export interface CommitConversationPlanOptions {
  turnId: string;
  intent: TripIntentDraft;
  plan: TripPlan;
  now?: string;
}

export interface FailConversationTurnOptions {
  turnId: string;
  error: TurnError;
  now?: string;
}

function defaultIdFactory(prefix: "conversation" | "message" | "turn"): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function clipText(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return "";
  const characters = codePoints(value);
  return characters.length <= maxCharacters
    ? value
    : characters.slice(0, maxCharacters).join("");
}

function placeName(intent: TripIntentDraft, type: "origin" | "destination"): string {
  const place = type === "origin" ? intent.origin : intent.stops.at(-1);
  if (!place) return "未定地点";
  return place.resolved?.name || place.label || place.query || "未定地点";
}

function assertMatchingTurn(conversation: Conversation, turnId: string): void {
  if (conversation.turn.turnId && conversation.turn.turnId !== turnId) {
    throw new Error(`Turn ${turnId} is not active for conversation ${conversation.id}.`);
  }
}

export function createEmptyConversation(
  options: CreateEmptyConversationOptions = {},
): Conversation {
  const timestamp = options.now ?? nowIso();
  const idFactory = options.idFactory ?? defaultIdFactory;
  return {
    id: options.id ?? idFactory("conversation"),
    title: options.title?.trim() || DEFAULT_CONVERSATION_TITLE,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    trip: {
      currentIntent: null,
      currentPlan: null,
      pendingIntent: null,
      planUpdatedAt: null,
      lastSuccessfulTurnId: null,
    },
    turn: {
      turnId: null,
      status: "idle",
      startedAt: null,
      updatedAt: timestamp,
      error: null,
    },
    scenario: {
      demoSettings: null,
      ready: false,
      lockedAt: null,
    },
  };
}

export function createChatMessage(
  input: CreateChatMessageInput,
  idFactory: ConversationIdFactory = defaultIdFactory,
): ChatMessage {
  return {
    id: input.id ?? idFactory("message"),
    conversationId: input.conversationId,
    turnId: input.turnId,
    role: input.role,
    kind: input.kind ?? "text",
    status: input.status ?? "complete",
    planId: input.planId ?? null,
    content: input.content,
    createdAt: input.createdAt ?? nowIso(),
  };
}

export function draftConversationTitle(text: string, maxCharacters = 22): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return DEFAULT_CONVERSATION_TITLE;
  const characters = codePoints(normalized);
  if (characters.length <= maxCharacters) return normalized;
  if (maxCharacters <= 1) return "…";
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export function plannedConversationTitle(
  intentOrPlan: TripIntentDraft | TripPlan,
): string {
  const intent = "intent" in intentOrPlan ? intentOrPlan.intent : intentOrPlan;
  return `${intent.date} · ${placeName(intent, "origin")}→${placeName(intent, "destination")}`;
}

/** Keep the newest messages while satisfying both model-context limits. */
export function clipRecentMessages(
  messages: readonly ChatMessage[],
  options: ClipRecentMessagesOptions = {},
): ChatMessage[] {
  const maxMessages = Math.max(0, Math.floor(options.maxMessages ?? DEFAULT_HISTORY_MESSAGE_LIMIT));
  const maxCharacters = Math.max(0, Math.floor(options.maxCharacters ?? DEFAULT_HISTORY_CHARACTER_LIMIT));
  if (maxMessages === 0 || maxCharacters === 0) return [];

  const selected: ChatMessage[] = [];
  let remainingCharacters = maxCharacters;
  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    if (remainingCharacters <= 0) break;
    const message = messages[index];
    const messageLength = codePoints(message.content).length;
    if (messageLength > remainingCharacters && selected.length > 0) break;
    const content = clipText(message.content, remainingCharacters);
    if (!content && message.content) break;
    selected.push(content === message.content ? { ...message } : { ...message, content });
    remainingCharacters -= codePoints(content).length;
  }
  return selected.reverse();
}

export function appendConversationMessage(
  conversation: Conversation,
  message: ChatMessage,
  now = message.createdAt,
): Conversation {
  if (message.conversationId !== conversation.id) {
    throw new Error(`Message ${message.id} belongs to a different conversation.`);
  }
  const title = conversation.messages.some((item) => item.role === "user") || message.role !== "user"
    ? conversation.title
    : draftConversationTitle(message.content);
  return {
    ...conversation,
    title,
    updatedAt: now,
    messages: [...conversation.messages, { ...message }],
  };
}

export function lockConversationScenario(
  conversation: Conversation,
  demoSettings: DemoSettings,
  now = nowIso(),
): Conversation {
  if (conversation.scenario.ready || conversation.scenario.lockedAt) {
    throw new Error(`Scenario for conversation ${conversation.id} is already locked.`);
  }
  return {
    ...conversation,
    updatedAt: now,
    scenario: {
      demoSettings: structuredClone(demoSettings),
      ready: true,
      lockedAt: now,
    },
  };
}

export function beginConversationTurn(
  conversation: Conversation,
  options: BeginConversationTurnOptions = {},
): Conversation {
  const timestamp = options.now ?? nowIso();
  const idFactory = options.idFactory ?? defaultIdFactory;
  const turnId = options.turnId ?? idFactory("turn");
  return {
    ...conversation,
    updatedAt: timestamp,
    trip: {
      ...conversation.trip,
      pendingIntent: options.pendingIntent ?? null,
    },
    turn: {
      turnId,
      status: options.status ?? "pending",
      startedAt: timestamp,
      updatedAt: timestamp,
      error: null,
    },
  };
}

export function updateConversationTurnStatus(
  conversation: Conversation,
  turnId: string,
  status: TurnStatus,
  now = nowIso(),
): Conversation {
  assertMatchingTurn(conversation, turnId);
  return {
    ...conversation,
    updatedAt: now,
    turn: {
      ...conversation.turn,
      turnId,
      status,
      updatedAt: now,
    },
  };
}

/**
 * The only helper that replaces the current route. Call it after every POI,
 * route, weather and planner request for the turn has succeeded.
 */
export function commitConversationPlan(
  conversation: Conversation,
  options: CommitConversationPlanOptions,
): Conversation {
  assertMatchingTurn(conversation, options.turnId);
  const timestamp = options.now ?? nowIso();
  return {
    ...conversation,
    title: plannedConversationTitle(options.plan),
    updatedAt: timestamp,
    trip: {
      currentIntent: structuredClone(options.intent),
      currentPlan: structuredClone(options.plan),
      pendingIntent: null,
      planUpdatedAt: timestamp,
      lastSuccessfulTurnId: options.turnId,
    },
    turn: {
      turnId: options.turnId,
      status: "complete",
      startedAt: conversation.turn.startedAt ?? timestamp,
      updatedAt: timestamp,
      error: null,
    },
  };
}

/** Mark a turn failed without replacing the last successful intent or plan. */
export function failConversationTurn(
  conversation: Conversation,
  options: FailConversationTurnOptions,
): Conversation {
  assertMatchingTurn(conversation, options.turnId);
  const timestamp = options.now ?? nowIso();
  return {
    ...conversation,
    updatedAt: timestamp,
    turn: {
      turnId: options.turnId,
      status: "failed",
      startedAt: conversation.turn.startedAt ?? timestamp,
      updatedAt: timestamp,
      error: { ...options.error },
    },
  };
}

export function clearPendingConversationIntent(
  conversation: Conversation,
  now = nowIso(),
): Conversation {
  return {
    ...conversation,
    updatedAt: now,
    trip: {
      ...conversation.trip,
      pendingIntent: null,
    },
  };
}
