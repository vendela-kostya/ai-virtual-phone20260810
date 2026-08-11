import Dexie from "dexie";
import { formatChatTimestamp } from "./llm-prompt-assembler";

export type StoryUiPrefs = {
  hideBubble?: boolean;
  hideAvatar?: boolean;
  hideTimestamp?: boolean;
  theme?: string;
};

export type StorySession = {
  id: string;
  characterId: string;
  title?: string;
  updatedAt: string;
  customCSS?: string;
  foldTags?: string;            // Comma-separated tag names to fold for this session.
  contextExcludedTags?: string; // Comma-separated tag names stripped before sending story history to the LLM.
  uiPrefs?: StoryUiPrefs;
  lastMessageId?: string;
  lastMessagePreview?: string;
  /** 多人剧情：参与角色 id 列表（≥2 时视为多人会话）。characterId 仍存主角色 id。 */
  characterIds?: string[];
  /** 进入剧情时手动指定的用户身份 id；缺省时按绑定级联解析（角色→全局→默认）。 */
  userIdentityId?: string;
};

export type StoryMessageRole = "user" | "assistant" | "system";

export type StoryMessage = {
  id: string;
  sessionId: string;
  role: StoryMessageRole;
  rawContent: string;
  renderedContent?: string;
  storySummary?: string;
  regexSignature?: string;
  parserVersion?: number;
  createdAt: string;
};

export type StoryProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
};

/** 存档时一并快照的会话配置，读档时整体恢复，保证存档独立完整 */
export type StorySaveSnapshot = {
  foldTags?: string;
  contextExcludedTags?: string;
  customCSS?: string;
  uiPrefs?: StoryUiPrefs;
};

/** 一份剧情存档：某时刻的完整消息快照 + 会话配置快照 */
export type StorySave = {
  id: string;
  sessionId: string;
  name: string;
  createdAt: string;
  messageCount: number;
  messages: StoryMessage[];
  sessionSnapshot?: StorySaveSnapshot;
};

class StoryDatabase extends Dexie {
  sessions!: Dexie.Table<StorySession, string>;
  messages!: Dexie.Table<StoryMessage, string>;
  saves!: Dexie.Table<StorySave, string>;

  constructor() {
    super("AiPhoneStoryDB");
    this.version(1).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, createdAt",
    });
    this.version(2).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, createdAt",
      saves: "id, sessionId, createdAt",
    });
  }
}

const storyDb = new StoryDatabase();

let _hydrated = false;
let _sessionsCache: StorySession[] = [];
let _messagesCache: StoryMessage[] = [];
let _savesCache: StorySave[] = [];

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getStorySessionActivityTime(session: StorySession): number {
  const lastMessageTime = _messagesCache
    .filter((message) => message.sessionId === session.id)
    .reduce((latest, message) => Math.max(latest, parseTime(message.createdAt)), 0);
  return Math.max(lastMessageTime, parseTime(session.updatedAt));
}

function isPreferredStorySession(candidate: StorySession, current: StorySession): boolean {
  const candidateTime = getStorySessionActivityTime(candidate);
  const currentTime = getStorySessionActivityTime(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const candidateUpdated = parseTime(candidate.updatedAt);
  const currentUpdated = parseTime(current.updatedAt);
  if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;
  return candidate.id.localeCompare(current.id) > 0;
}

function getMultiSessionKey(characterIds: string[]): string {
  return `multi:${[...new Set(characterIds)].sort().join(",")}`;
}

/** 判断会话是否为多人剧情（参与角色 ≥2） */
export function isMultiStorySession(session: StorySession | null | undefined): boolean {
  return Boolean(session && Array.isArray(session.characterIds) && session.characterIds.length >= 2);
}

function normalizeStorySessions(sessions: StorySession[]): { items: StorySession[]; changed: boolean } {
  const normalized: StorySession[] = [];
  const indexByCharacter = new Map<string, number>();
  let changed = false;

  for (const session of sessions) {
    // 防御：旧版本/异常写入可能在 sessions 表里留下 null 或非对象记录，
    // 直接跳过而不是让 normalize/渲染崩溃（剧情模式曾整页 client-side exception）
    if (!session || typeof session !== "object") {
      changed = true;
      continue;
    }
    const id = session.id?.trim();
    const characterId = session.characterId?.trim();
    if (!id || !characterId) {
      changed = true;
      continue;
    }
    const item = id === session.id && characterId === session.characterId
      ? session
      : { ...session, id, characterId };
    // 多人会话用角色组合作为去重 key，与单人会话语义隔离，互不顶替
    const dedupeKey = isMultiStorySession(item)
      ? getMultiSessionKey(item.characterIds || [])
      : characterId;
    const existingIndex = indexByCharacter.get(dedupeKey);
    if (existingIndex === undefined) {
      indexByCharacter.set(dedupeKey, normalized.length);
      normalized.push(item);
      if (item !== session) changed = true;
      continue;
    }

    changed = true;
    if (isPreferredStorySession(item, normalized[existingIndex])) {
      normalized[existingIndex] = item;
    }
  }

  return { items: normalized, changed };
}

function persistStorySessionsSnapshot(sessions: StorySession[]): void {
  storyDb.transaction("rw", storyDb.sessions, async () => {
    await storyDb.sessions.clear();
    await storyDb.sessions.bulkPut(sessions);
  }).catch(() => undefined);
}

export async function hydrateStoryStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return;
  const [sessions, messages, saves] = await Promise.all([
    storyDb.sessions.toArray().catch(() => []),
    storyDb.messages.toArray().catch(() => []),
    storyDb.saves.toArray().catch(() => []),
  ]);
  // 防御：旧版本/异常写入可能产生缺字段或 null 记录，读取时直接剔除，
  // 避免后续渲染访问 message.role / message.id 时抛 TypeError
  _messagesCache = messages.filter(
    (m): m is StoryMessage => !!m && typeof m === "object" && typeof m.id === "string" && typeof m.sessionId === "string",
  );
  _savesCache = saves.filter(
    (s): s is StorySave => !!s && typeof s === "object" && typeof s.id === "string" && typeof s.sessionId === "string",
  );
  const normalized = normalizeStorySessions(sessions);
  _sessionsCache = normalized.items;
  if (normalized.changed) persistStorySessionsSnapshot(normalized.items);
  _hydrated = true;
}

export function loadStorySessions(): StorySession[] {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) _sessionsCache = normalized.items;
  // 空值安全：旧版本/异常导入的数据可能缺 updatedAt，排序不能让页面崩溃
  return [..._sessionsCache].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function loadStoryMessages(sessionId: string): StoryMessage[] {
  return _messagesCache
    .filter((message) => message.sessionId === sessionId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

export function createOrGetStorySession(characterId: string): StorySession {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistStorySessionsSnapshot(normalized.items);
  }
  const existing = _sessionsCache.find((session) => !isMultiStorySession(session) && session.characterId === characterId);
  if (existing) return existing;

  const session: StorySession = {
    id: generateId("story_sess"),
    characterId,
    updatedAt: new Date().toISOString(),
    uiPrefs: {},
  };
  _sessionsCache.unshift(session);
  storyDb.sessions.put(session).catch(() => undefined);
  return session;
}

/** 创建或获取多人剧情会话：同一组角色共用一份会话（含用户共三人参与） */
export function createOrGetMultiStorySession(characterIds: string[]): StorySession {
  const uniqueIds = Array.from(new Set(characterIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueIds.length < 2) {
    // 参数不足时退化为单人会话
    return createOrGetStorySession(uniqueIds[0] || "");
  }
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistStorySessionsSnapshot(normalized.items);
  }
  const key = getMultiSessionKey(uniqueIds);
  const existing = _sessionsCache.find((session) => isMultiStorySession(session) && getMultiSessionKey(session.characterIds || []) === key);
  if (existing) return existing;

  const session: StorySession = {
    id: generateId("story_sess"),
    characterId: uniqueIds[0],
    characterIds: uniqueIds,
    updatedAt: new Date().toISOString(),
    uiPrefs: {},
  };
  _sessionsCache.unshift(session);
  storyDb.sessions.put(session).catch(() => undefined);
  return session;
}

/** 列出所有多人剧情会话（含角色组合与最后预览） */
export function listMultiStorySessions(): StorySession[] {
  return loadStorySessions().filter(isMultiStorySession);
}

export function updateStorySession(sessionId: string, updates: Partial<StorySession>): StorySession | null {
  const idx = _sessionsCache.findIndex((session) => session.id === sessionId);
  if (idx === -1) return null;
  const next: StorySession = {
    ..._sessionsCache[idx],
    ...updates,
    uiPrefs: { ..._sessionsCache[idx].uiPrefs, ...updates.uiPrefs },
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  _sessionsCache[idx] = next;
  storyDb.sessions.put(next).catch(() => undefined);
  return next;
}

export function pushStoryMessage(
  input: Omit<StoryMessage, "id" | "createdAt">
): StoryMessage {
  const message: StoryMessage = {
    ...input,
    id: generateId("story_msg"),
    createdAt: new Date().toISOString(),
  };
  _messagesCache.push(message);
  storyDb.messages.put(message).catch(() => undefined);

  const previewSource = message.renderedContent || message.rawContent;
  const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 64);
  updateStorySession(message.sessionId, {
    lastMessageId: message.id,
    lastMessagePreview: preview,
    updatedAt: message.createdAt,
  });

  return message;
}

/** Delete a single story message */
export function deleteStoryMessage(messageId: string): void {
    _messagesCache = _messagesCache.filter(m => m.id !== messageId);
    storyDb.messages.delete(messageId).catch(() => undefined);
}

/** Delete a message and all messages after it (by createdAt in same session) */
export function deleteStoryMessagesFrom(sessionId: string, messageId: string): void {
    const msg = _messagesCache.find(m => m.id === messageId);
    if (!msg) return;
    const idsToDelete = _messagesCache
        .filter(m => m.sessionId === sessionId && m.createdAt >= msg.createdAt)
        .map(m => m.id);
    _messagesCache = _messagesCache.filter(m => !idsToDelete.includes(m.id));
    storyDb.messages.bulkDelete(idsToDelete).catch(() => undefined);
}

/** Edit a story message's rawContent (renderedContent will be rebuilt by cache invalidation) */
export function editStoryMessage(messageId: string, newRawContent: string): void {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    _messagesCache[idx] = {
        ..._messagesCache[idx],
        rawContent: newRawContent,
        renderedContent: undefined,
        regexSignature: undefined,
        parserVersion: undefined,
    };
    storyDb.messages.put(_messagesCache[idx]).catch(() => undefined);
}

export function replaceStoryMessages(sessionId: string, messages: StoryMessage[]): void {
  _messagesCache = _messagesCache.filter((message) => message.sessionId !== sessionId);
  _messagesCache.push(...messages);
  storyDb.messages.where("sessionId").equals(sessionId).delete()
    .then(() => storyDb.messages.bulkPut(messages))
    .catch(() => undefined);
}

function compactProjectionText(text: string, maxLen = 160): string {
  const plain = text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}...` : plain;
}

export function loadStoryProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string; userName?: string; charName?: string }
): StoryProjectionEntry[] {
  const session = _sessionsCache.find((item) => !isMultiStorySession(item) && item.characterId === characterId);
  if (!session) return [];
  const messages = loadStoryMessages(session.id);
  const projections: StoryProjectionEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (current.role !== "assistant") continue;
    if (options?.afterTimestamp && current.createdAt <= options.afterTimestamp) continue;

    if (!current.storySummary) continue;
    const summaryText = compactProjectionText(current.storySummary, 500);
    if (!summaryText) continue;

    const ts = formatChatTimestamp(current.createdAt);
    projections.push({
      id: `story_projection_${current.id}`,
      timestamp: current.createdAt,
      content: `[事件 ${ts}] ${summaryText}`,
    });
  }

  return projections;
}

// ── 剧情存档（每份存档是独立完整快照，互不影响） ──

export function listStorySaves(sessionId: string): StorySave[] {
  return _savesCache
    .filter((save) => save.sessionId === sessionId)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export function getStorySave(saveId: string): StorySave | undefined {
  return _savesCache.find((save) => save.id === saveId);
}

export function createStorySave(
  sessionId: string,
  name: string,
  messages: StoryMessage[],
  sessionSnapshot?: StorySaveSnapshot
): StorySave {
  const save: StorySave = {
    id: generateId("story_save"),
    sessionId,
    name: name.trim() || "未命名存档",
    createdAt: new Date().toISOString(),
    messageCount: messages.length,
    messages: messages.map((message) => ({ ...message })),
    sessionSnapshot: sessionSnapshot
      ? {
          ...sessionSnapshot,
          uiPrefs: sessionSnapshot.uiPrefs ? { ...sessionSnapshot.uiPrefs } : undefined,
        }
      : undefined,
  };
  _savesCache.unshift(save);
  storyDb.saves.put(save).catch(() => undefined);
  return save;
}

export function deleteStorySave(saveId: string): void {
  _savesCache = _savesCache.filter((save) => save.id !== saveId);
  storyDb.saves.delete(saveId).catch(() => undefined);
}

/** 删除一个剧情会话及其全部消息与存档（开屏「继续之前的多剧情」双击删除用） */
export function deleteStorySession(sessionId: string): void {
  _sessionsCache = _sessionsCache.filter((session) => session.id !== sessionId);
  _messagesCache = _messagesCache.filter((message) => message.sessionId !== sessionId);
  _savesCache = _savesCache.filter((save) => save.sessionId !== sessionId);
  storyDb.sessions.delete(sessionId).catch(() => undefined);
  storyDb.messages.where("sessionId").equals(sessionId).delete().catch(() => undefined);
  storyDb.saves.where("sessionId").equals(sessionId).delete().catch(() => undefined);
}
