import { loadChatSessions } from "./chat-storage";
import { formatChatTimestamp } from "./llm-prompt-assembler";
import { kvGet, kvRemove, kvSet, registerDynamicPrefix } from "./kv-db";

const CHAT_OFFLINE_TURNS_PREFIX = "ai_phone_chat_offline_turns:";
// 线下「存档」索引：每个会话一份存档清单，轮次仍按 archiveId 存在 TURNS_PREFIX 下。
// 默认存档的 id 直接取会话 id —— 这样升级前的老线下记录无需迁移就天然属于默认存档。
const CHAT_OFFLINE_ARCHIVES_PREFIX = "ai_phone_chat_offline_archives:";
registerDynamicPrefix(CHAT_OFFLINE_TURNS_PREFIX);
registerDynamicPrefix(CHAT_OFFLINE_ARCHIVES_PREFIX);

export type ChatOfflineTurn = {
    id: string;
    sessionId: string;
    userContent: string;
    assistantContent: string;
    summary: string;
    summaryTag: string;
    rawText?: string;
    reasoningText?: string; // 模型思维链（reasoning/CoT）内容
    thinkingText?: string; // 预设格式 <thinking> 标签解析出的思维链（展示优先于 reasoningText）
    thinkingTag?: string; // 实际用于提取思维链的标签名（preset.thinking_tag 或默认 thinking）
    createdAt: string;
};

/** 一份线下存档：一组线下轮次 + 展示用元信息。
 *  轮次本身仍按 archiveId 存在 chat_offline_turns 键下，这里只存索引与统计。 */
export type ChatOfflineArchive = {
    id: string;
    sessionId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    /** 最近一次进入该存档的时间，存档列表按它倒序 */
    lastUsedAt: string;
    /** 最后一条轮次的时间（无轮次时为空）：聊天列表预览据此挑最新存档 */
    lastTurnAt?: string;
    turnCount: number;
    preview: string;
};

export const DEFAULT_CHAT_OFFLINE_ARCHIVE_NAME = "默认存档";

export type ChatOfflineProjectionEntry = {
    id: string;
    sessionId: string;
    groupSessionId?: string;
    timestamp: string;
    content: string;
};

export type ParsedOfflineResponse = {
    rawText: string;
    content: string;
    summary: string;
    summaryTag: string;
    thinking?: string; // 预设格式 <thinking> 标签内容（与模型 API 原生 reasoning 无关）
    thinkingTag?: string; // 实际用于提取思维链的标签名
};

function storageKey(sessionId: string): string {
    return `${CHAT_OFFLINE_TURNS_PREFIX}${sessionId}`;
}

function createTurnId(): string {
    return `offline_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeTurn(value: unknown): ChatOfflineTurn | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<ChatOfflineTurn>;
    if (typeof item.id !== "string" || typeof item.sessionId !== "string") return null;
    if (typeof item.userContent !== "string" || typeof item.assistantContent !== "string") return null;
    if (typeof item.createdAt !== "string") return null;
    return {
        id: item.id,
        sessionId: item.sessionId,
        userContent: item.userContent,
        assistantContent: item.assistantContent,
        summary: typeof item.summary === "string" ? item.summary : "",
        summaryTag: typeof item.summaryTag === "string" && item.summaryTag.trim() ? item.summaryTag.trim() : "summary",
        rawText: typeof item.rawText === "string" ? item.rawText : undefined,
        reasoningText: typeof item.reasoningText === "string" ? item.reasoningText : undefined,
        thinkingText: typeof item.thinkingText === "string" ? item.thinkingText : undefined,
        thinkingTag: typeof item.thinkingTag === "string" ? item.thinkingTag : undefined,
        createdAt: item.createdAt,
    };
}

export function loadChatOfflineTurns(sessionId: string): ChatOfflineTurn[] {
    try {
        const raw = kvGet(storageKey(sessionId));
        const parsed = raw ? JSON.parse(raw) as unknown : [];
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeTurn)
            .filter((turn): turn is ChatOfflineTurn => Boolean(turn))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch {
        return [];
    }
}

export function saveChatOfflineTurns(sessionId: string, turns: ChatOfflineTurn[]): void {
    const normalized = turns
        .map(normalizeTurn)
        .filter((turn): turn is ChatOfflineTurn => Boolean(turn))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    kvSet(storageKey(sessionId), JSON.stringify(normalized));
}

export function clearChatOfflineTurns(sessionId: string): void {
    kvRemove(storageKey(sessionId));
}

// ── 线下存档索引 ────────────────────────────────────────────

function archivesKey(sessionId: string): string {
    return `${CHAT_OFFLINE_ARCHIVES_PREFIX}${sessionId}`;
}

function createArchiveId(): string {
    return `offline_save_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function turnPreviewText(turn: ChatOfflineTurn | undefined): string {
    if (!turn) return "";
    const source = turn.summary.trim() || turn.assistantContent.trim() || turn.userContent.trim();
    return compactProjectionText(source, 60);
}

function normalizeArchive(value: unknown, sessionId: string): ChatOfflineArchive | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<ChatOfflineArchive>;
    if (typeof item.id !== "string" || !item.id.trim()) return null;
    const createdAt = typeof item.createdAt === "string" && item.createdAt ? item.createdAt : new Date().toISOString();
    return {
        id: item.id,
        sessionId: typeof item.sessionId === "string" && item.sessionId ? item.sessionId : sessionId,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : DEFAULT_CHAT_OFFLINE_ARCHIVE_NAME,
        createdAt,
        updatedAt: typeof item.updatedAt === "string" && item.updatedAt ? item.updatedAt : createdAt,
        lastUsedAt: typeof item.lastUsedAt === "string" && item.lastUsedAt ? item.lastUsedAt : createdAt,
        lastTurnAt: typeof item.lastTurnAt === "string" && item.lastTurnAt ? item.lastTurnAt : undefined,
        turnCount: Number.isFinite(item.turnCount) ? Math.max(0, Math.floor(Number(item.turnCount))) : 0,
        preview: typeof item.preview === "string" ? item.preview : "",
    };
}

function readArchives(sessionId: string): ChatOfflineArchive[] {
    try {
        const raw = kvGet(archivesKey(sessionId));
        const parsed = raw ? JSON.parse(raw) as unknown : [];
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(item => normalizeArchive(item, sessionId))
            .filter((item): item is ChatOfflineArchive => Boolean(item));
    } catch {
        return [];
    }
}

function writeArchives(sessionId: string, archives: ChatOfflineArchive[]): void {
    kvSet(archivesKey(sessionId), JSON.stringify(archives));
}

function sortArchives(archives: ChatOfflineArchive[]): ChatOfflineArchive[] {
    return [...archives].sort((a, b) => {
        const byUsed = (b.lastUsedAt || "").localeCompare(a.lastUsedAt || "");
        if (byUsed !== 0) return byUsed;
        return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
}

function createDefaultArchive(sessionId: string, turns: ChatOfflineTurn[]): ChatOfflineArchive {
    const first = turns[0]?.createdAt || new Date().toISOString();
    const lastTurn = turns[turns.length - 1];
    const last = lastTurn?.createdAt || first;
    return {
        id: sessionId,
        sessionId,
        name: DEFAULT_CHAT_OFFLINE_ARCHIVE_NAME,
        createdAt: first,
        updatedAt: last,
        lastUsedAt: last,
        lastTurnAt: lastTurn?.createdAt,
        turnCount: turns.length,
        preview: turnPreviewText(lastTurn),
    };
}

/** 存档清单（最近使用在前）。首次调用时会把「还没有存档登记的旧线下记录」
 *  就地登记成默认存档，老数据不会因为升级而消失。 */
export function loadChatOfflineArchives(sessionId: string): ChatOfflineArchive[] {
    let archives = readArchives(sessionId);
    if (archives.length === 0) {
        const legacyTurns = loadChatOfflineTurns(sessionId);
        if (legacyTurns.length > 0) {
            archives = [createDefaultArchive(sessionId, legacyTurns)];
            writeArchives(sessionId, archives);
        }
    }
    return sortArchives(archives);
}

export function getChatOfflineArchive(sessionId: string, archiveId: string): ChatOfflineArchive | null {
    return loadChatOfflineArchives(sessionId).find(archive => archive.id === archiveId) || null;
}

/** 删除会话时的连锁清理：该会话名下所有存档的轮次 + 存档清单本身。
 *  只清清单不清轮次会留下孤儿数据，只清当前存档又会让别的存档残留。 */
export function clearChatOfflineArchives(sessionId: string): void {
    const archives = readArchives(sessionId);
    for (const archive of archives) clearChatOfflineTurns(archive.id);
    // 兜底：老数据（没有存档登记、轮次直接挂在会话 id 下）
    clearChatOfflineTurns(sessionId);
    kvRemove(archivesKey(sessionId));
    lastTurnCache.delete(sessionId);
}

export function createChatOfflineArchive(sessionId: string, name?: string): ChatOfflineArchive {
    const archives = loadChatOfflineArchives(sessionId);
    const now = new Date().toISOString();
    const archive: ChatOfflineArchive = {
        id: createArchiveId(),
        sessionId,
        name: (name || "").trim() || `存档 ${archives.length + 1}`,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
        turnCount: 0,
        preview: "",
    };
    writeArchives(sessionId, [...archives, archive]);
    return archive;
}

export function renameChatOfflineArchive(sessionId: string, archiveId: string, name: string): ChatOfflineArchive | null {
    const nextName = name.trim();
    if (!nextName) return null;
    const archives = readArchives(sessionId);
    const index = archives.findIndex(archive => archive.id === archiveId);
    if (index < 0) return null;
    archives[index] = { ...archives[index], name: nextName };
    writeArchives(sessionId, archives);
    return archives[index];
}

export function deleteChatOfflineArchive(sessionId: string, archiveId: string): ChatOfflineArchive[] {
    const next = readArchives(sessionId).filter(archive => archive.id !== archiveId);
    writeArchives(sessionId, next);
    clearChatOfflineTurns(archiveId);
    return sortArchives(next);
}

/** 进入存档时调用：刷新「最近使用」，存档列表顺序跟着走。 */
export function touchChatOfflineArchive(sessionId: string, archiveId: string): void {
    if (!sessionId || !archiveId) return;
    const archives = readArchives(sessionId);
    const index = archives.findIndex(archive => archive.id === archiveId);
    if (index < 0) return;
    archives[index] = { ...archives[index], lastUsedAt: new Date().toISOString() };
    writeArchives(sessionId, archives);
}

/** 轮次增删改后同步存档元信息（轮数 / 预览 / 最后轮次时间）。
 *  整体覆盖写入（如「重试以下」截断）后需要手动调一次。 */
export function syncChatOfflineArchiveStats(sessionId: string | undefined, archiveId: string): void {
    if (!sessionId) return;
    const archives = readArchives(sessionId);
    const index = archives.findIndex(archive => archive.id === archiveId);
    if (index < 0) return;
    const turns = loadChatOfflineTurns(archiveId);
    const lastTurn = turns[turns.length - 1];
    archives[index] = {
        ...archives[index],
        updatedAt: lastTurn?.createdAt || archives[index].updatedAt,
        lastTurnAt: lastTurn?.createdAt,
        turnCount: turns.length,
        preview: turnPreviewText(lastTurn),
    };
    writeArchives(sessionId, archives);
}

export function appendChatOfflineTurn(input: {
    sessionId: string;
    /** 目标存档：缺省用会话 id（默认存档），传入存档 id 时轮次写进该存档 */
    archiveId?: string;
    userContent: string;
    assistantContent: string;
    summary: string;
    summaryTag: string;
    rawText?: string;
    reasoningText?: string;
    thinkingText?: string;
    thinkingTag?: string;
}): ChatOfflineTurn {
    const turn: ChatOfflineTurn = {
        id: createTurnId(),
        sessionId: input.sessionId,
        userContent: input.userContent,
        assistantContent: input.assistantContent,
        summary: input.summary,
        summaryTag: input.summaryTag.trim() || "summary",
        rawText: input.rawText,
        reasoningText: input.reasoningText,
        thinkingText: input.thinkingText,
        thinkingTag: input.thinkingTag,
        createdAt: new Date().toISOString(),
    };
    const archiveId = input.archiveId?.trim() || input.sessionId;
    saveChatOfflineTurns(archiveId, [...loadChatOfflineTurns(archiveId), turn]);
    syncChatOfflineArchiveStats(input.sessionId, archiveId);
    return turn;
}

export function updateChatOfflineTurn(
    archiveId: string,
    turnId: string,
    patch: Partial<Pick<ChatOfflineTurn, "userContent" | "assistantContent" | "summary" | "summaryTag" | "rawText" | "reasoningText" | "thinkingText" | "thinkingTag">>,
    /** sessionId 用于同步存档元信息（存档 id 与 sessionId 不同时必传） */
    options?: { sessionId?: string },
): ChatOfflineTurn | null {
    let updated: ChatOfflineTurn | null = null;
    const turns = loadChatOfflineTurns(archiveId).map((turn) => {
        if (turn.id !== turnId) return turn;
        updated = {
            ...turn,
            ...patch,
            summaryTag: patch.summaryTag?.trim() || turn.summaryTag || "summary",
        };
        return updated;
    });
    if (updated) {
        saveChatOfflineTurns(archiveId, turns);
        syncChatOfflineArchiveStats(options?.sessionId || archiveId, archiveId);
    }
    return updated;
}

export function deleteChatOfflineTurn(
    archiveId: string,
    turnId: string,
    options?: { sessionId?: string },
): ChatOfflineTurn[] {
    const next = loadChatOfflineTurns(archiveId).filter((turn) => turn.id !== turnId);
    saveChatOfflineTurns(archiveId, next);
    syncChatOfflineArchiveStats(options?.sessionId || archiveId, archiveId);
    return next;
}

export function deleteChatOfflineTurnsFrom(
    archiveId: string,
    turnId: string,
    options?: { sessionId?: string },
): ChatOfflineTurn[] {
    const turns = loadChatOfflineTurns(archiveId);
    const idx = turns.findIndex((turn) => turn.id === turnId);
    if (idx < 0) return turns;
    const next = turns.slice(0, idx);
    saveChatOfflineTurns(archiveId, next);
    syncChatOfflineArchiveStats(options?.sessionId || archiveId, archiveId);
    return next;
}

function compactProjectionText(text: string, maxLen: number): string {
    const plain = text
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/[#>*_`-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!plain) return "";
    return plain.length > maxLen ? `${plain.slice(0, maxLen)}...` : plain;
}

export function loadChatOfflineProjectionEntries(
    characterId: string,
    options?: { afterTimestamp?: string; excludeSessionId?: string },
): ChatOfflineProjectionEntry[] {
    const sessions = loadChatSessions().filter((session) => {
        if (session.id === options?.excludeSessionId) return false;
        if (session.isGroup) return session.participantIds?.includes(characterId);
        return session.contactId === characterId;
    });

    const entries: ChatOfflineProjectionEntry[] = [];
    for (const session of sessions) {
        // 一个会话可能有多个线下存档：事件流把它们都算进来，回档/开新档都不会丢记忆
        const archiveIds = loadChatOfflineArchives(session.id).map(archive => archive.id);
        const sources = archiveIds.length > 0 ? archiveIds : [session.id];
        for (const archiveId of sources) {
            for (const turn of loadChatOfflineTurns(archiveId)) {
                if (options?.afterTimestamp && turn.createdAt <= options.afterTimestamp) continue;
                const summaryText = compactProjectionText(turn.summary, 500);
                if (!summaryText) continue;
                const ts = formatChatTimestamp(turn.createdAt);
                entries.push({
                    id: `chat_offline_projection_${turn.id}`,
                    sessionId: session.id,
                    ...(session.isGroup ? { groupSessionId: session.id } : {}),
                    timestamp: turn.createdAt,
                    content: `[事件 ${ts}] ${summaryText}`,
                });
            }
        }
    }

    return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function escapeTagName(tag: string): string {
    return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractXmlField(rawText: string, tags: string[]): string {
    const candidates = tags
        .map((tag) => tag.trim())
        .filter(Boolean)
        .filter((tag, index, list) => list.indexOf(tag) === index);
    for (const tag of candidates) {
        const escaped = escapeTagName(tag);
        const match = rawText.match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "i"));
        const content = match?.[1]?.trim();
        if (content) return content;
    }
    return "";
}

function stripXmlField(rawText: string, tag: string): string {
    if (!tag.trim()) return rawText;
    const escaped = escapeTagName(tag.trim());
    return rawText.replace(new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, "gi"), "").trim();
}

/** 从原始输出中提取指定标签包裹的思维链（仅当预设开启标签解析时调用）。
 *  默认标签 thinking 时兼容 thought / think（DeepSeek R1 系模型输出 <think>）。 */
export function extractThinkingTag(rawText: string, tag?: string): string {
    const effective = (tag || "thinking").trim() || "thinking";
    const tags = effective === "thinking" ? ["thinking", "thought", "think"] : [effective];
    return extractXmlField(rawText.trim(), tags).trim();
}

export function parseOfflineResponse(rawText: string, summaryTag: string): ParsedOfflineResponse {
    const trimmed = rawText.trim();
    const effectiveSummaryTag = summaryTag.trim() || "summary";
    const summary = extractXmlField(trimmed, [effectiveSummaryTag, "summary"]);
    let content = extractXmlField(trimmed, ["content"]);
    if (!content) {
        // 无 <content> 标签时回退到剥掉摘要标签后的全文
        content = stripXmlField(stripXmlField(trimmed, effectiveSummaryTag), "summary");
    }
    return {
        rawText: trimmed,
        content: content.trim(),
        summary: summary.trim(),
        summaryTag: effectiveSummaryTag,
    };
}

// ── 聊天列表用：最后一条线下记录 ─────────────────────────────
// 聊天列表在每次渲染时都会逐会话读取，这里按原始 JSON 串缓存解析结果，
// 避免把整段线下记录反复 parse。
const lastTurnCache = new Map<string, { raw: string; turn: ChatOfflineTurn | null }>();

export function getLastChatOfflineTurn(sessionId: string): ChatOfflineTurn | null {
    let raw = "";
    let archives: ChatOfflineArchive[] = [];
    try {
        // 先取存档清单（可能就地登记旧数据），再读它的原始串做缓存签名
        archives = loadChatOfflineArchives(sessionId);
        raw = kvGet(archivesKey(sessionId)) || "";
    } catch {
        return null;
    }
    const cached = lastTurnCache.get(sessionId);
    if (cached && cached.raw === raw) return cached.turn;
    // 多存档：挑「最后一条轮次」最新的那个存档，只解析这一份
    let latest: ChatOfflineArchive | null = null;
    for (const archive of archives) {
        if (!latest) { latest = archive; continue; }
        const at = archive.lastTurnAt || archive.updatedAt || archive.createdAt || "";
        const best = latest.lastTurnAt || latest.updatedAt || latest.createdAt || "";
        if (at > best) latest = archive;
    }
    const turns = latest ? loadChatOfflineTurns(latest.id) : [];
    const turn = turns.length ? turns[turns.length - 1] : null;
    lastTurnCache.set(sessionId, { raw, turn });
    return turn;
}

// 线下记录没有普通消息那样的 preview 字段，这里从摘要/正文里压一条出来，
// 并带上「线下」标记，方便在列表里跟线上消息区分。
export function getChatOfflineTurnPreview(turn: ChatOfflineTurn | null): string {
    if (!turn) return "";
    const source = turn.summary.trim() || turn.assistantContent.trim() || turn.userContent.trim();
    const text = compactProjectionText(source, 60);
    return text ? `[线下] ${text}` : "";
}
