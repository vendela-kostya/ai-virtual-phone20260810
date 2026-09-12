"use client";

// 线下存档选择器：选择 / 新增 / 重命名 / 删除线下存档，选中后进入线下
// （见 chat-room.enterOfflineMode）。
// 线下内容每轮生成后都会自动写进「当前存档」，不需要手动保存；本面板负责的是
// 「进哪一份存档、以及把现有内容另存一份」。老数据（还没被登记过的线下记录）
// 会由 loadChatOfflineArchives 自动登记成「已有内容」存档，不会丢。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, MoreHorizontal, Trash2, X } from "lucide-react";
import {
    createChatOfflineArchive,
    deleteChatOfflineArchive,
    loadChatOfflineArchives,
    renameChatOfflineArchive,
    type ChatOfflineArchive,
} from "@/lib/chat-offline-storage";
import { formatChatUiTime } from "@/lib/chat-time";
import { Toggle } from "@/components/ui/form";

/** 请求打开线下存档选择器（聊天信息页 → 线下存档 用；聊天室监听后弹出） */
export const CHAT_OPEN_OFFLINE_SAVES_EVENT = "chat-open-offline-saves";

export type ChatOfflineSavePickerProps = {
    sessionId: string;
    /** 会话显示名（角色名 / 群名），仅用于副标题展示 */
    sessionTitle: string;
    /** 当前线下正在使用的存档 id；未进入线下时为 null */
    activeArchiveId: string | null;
    onClose: () => void;
    /** 选中某个存档 → 开始线下 */
    onSelect: (archiveId: string) => void;
    /** 存档清单发生变化（新建 / 重命名 / 删除） */
    onChanged: () => void;
};

export function ChatOfflineSavePicker({
    sessionId,
    sessionTitle,
    activeArchiveId,
    onClose,
    onSelect,
    onChanged,
}: ChatOfflineSavePickerProps) {
    const [archives, setArchives] = useState<ChatOfflineArchive[]>(() => loadChatOfflineArchives(sessionId));
    const [creating, setCreating] = useState(false);
    const [draftName, setDraftName] = useState("");
    const [menuId, setMenuId] = useState<string | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState("");
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    // 新建存档时是否顺带把现有内容复制进去（默认开：用户的诉求是「别让内容无处安放」）
    const [copySource, setCopySource] = useState(true);

    const reload = useCallback(() => {
        setArchives(loadChatOfflineArchives(sessionId));
    }, [sessionId]);

    useEffect(() => { reload(); }, [reload]);

    const suggestedName = useMemo(() => `存档 ${archives.length + 1}`, [archives.length]);

    // 可继承的源：优先当前使用的存档（有内容时），否则第一份有内容的存档
    const copyCandidate = useMemo(() => {
        const active = activeArchiveId ? archives.find(item => item.id === activeArchiveId) : null;
        if (active && active.turnCount > 0) return active;
        return archives.find(item => item.turnCount > 0) || null;
    }, [archives, activeArchiveId]);

    const startCreate = () => {
        setMenuId(null);
        setRenamingId(null);
        setConfirmDeleteId(null);
        setDraftName(suggestedName);
        setCopySource(Boolean(copyCandidate));
        setCreating(true);
    };

    const handleCreate = () => {
        const archive = createChatOfflineArchive(sessionId, draftName.trim() || suggestedName, {
            copyFromArchiveId: copySource && copyCandidate ? copyCandidate.id : undefined,
        });
        setCreating(false);
        setDraftName("");
        reload();
        onChanged();
        // 新建即进入：省掉「再点一次才进去」的多余一步
        onSelect(archive.id);
    };

    const handleRename = (archiveId: string) => {
        const next = renameDraft.trim();
        if (!next) return;
        renameChatOfflineArchive(sessionId, archiveId, next);
        setRenamingId(null);
        setRenameDraft("");
        reload();
        onChanged();
    };

    const handleDelete = (archiveId: string) => {
        deleteChatOfflineArchive(sessionId, archiveId);
        setConfirmDeleteId(null);
        setMenuId(null);
        reload();
        onChanged();
    };

    const renderRow = (archive: ChatOfflineArchive) => {
        const isActive = archive.id === activeArchiveId;
        const isRenaming = renamingId === archive.id;
        return (
            <div key={archive.id} className="flex flex-col gap-2">
                {isRenaming ? (
                    <div className="flex items-center gap-2 rounded-2xl border border-[var(--c-accent)] bg-[var(--c-input)]/70 px-3 py-2">
                        <input
                            autoFocus
                            value={renameDraft}
                            onChange={e => setRenameDraft(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === "Enter") handleRename(archive.id);
                                if (e.key === "Escape") { setRenamingId(null); setRenameDraft(""); }
                            }}
                            className="flex-1 min-w-0 bg-transparent outline-none ts-14 text-[var(--c-text)]"
                        />
                        <button type="button" className="ui-btn ui-btn-primary" onClick={() => handleRename(archive.id)}>保存</button>
                        <button type="button" className="ui-btn ui-btn-outline" onClick={() => { setRenamingId(null); setRenameDraft(""); }}>取消</button>
                    </div>
                ) : (
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => onSelect(archive.id)}
                            className={`w-full text-left rounded-2xl border bg-[var(--c-input)]/70 px-3 py-2.5 pr-10 flex flex-col gap-1 ${isActive ? "border-[var(--c-accent)]" : "border-[var(--c-border)]"}`}
                        >
                            <span className="flex items-center gap-2">
                                <span className="menu-label flex-1 truncate text-left">{archive.name}</span>
                                {isActive && <Check size={14} strokeWidth={2.2} className="text-[var(--c-accent)] shrink-0" />}
                            </span>
                            <span className="menu-desc !mt-0 truncate">
                                {archive.turnCount > 0
                                    ? `${archive.turnCount} 轮 · ${formatChatUiTime(archive.lastTurnAt || archive.updatedAt)}`
                                    : "尚未开始"}
                            </span>
                            {archive.preview ? (
                                <span className="menu-desc !mt-0 truncate opacity-80">{archive.preview}</span>
                            ) : null}
                        </button>
                        <button
                            type="button"
                            aria-label="存档操作"
                            title="存档操作"
                            onClick={() => {
                                setConfirmDeleteId(null);
                                setMenuId(menuId === archive.id ? null : archive.id);
                            }}
                            className="ui-bare-btn absolute right-2 top-2 text-[var(--c-icon)]"
                        >
                            <MoreHorizontal size={16} strokeWidth={2} />
                        </button>
                    </div>
                )}

                {menuId === archive.id && !isRenaming && (
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => {
                                setMenuId(null);
                                setConfirmDeleteId(null);
                                setRenameDraft(archive.name);
                                setRenamingId(archive.id);
                            }}
                        >重命名</button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => {
                                setMenuId(null);
                                setRenamingId(null);
                                setConfirmDeleteId(archive.id);
                            }}
                        >删除</button>
                    </div>
                )}

                {confirmDeleteId === archive.id && (
                    <div className="flex flex-col gap-2 rounded-2xl border border-[var(--c-border)] bg-[var(--c-input)]/70 px-3 py-2">
                        <span className="menu-desc !mt-0">
                            删除「{archive.name}」会连同这份存档里的 {archive.turnCount} 轮线下记录一起清掉，且无法恢复。
                        </span>
                        <div className="flex justify-end gap-2">
                            <button type="button" className="ui-btn ui-btn-outline" onClick={() => setConfirmDeleteId(null)}>取消</button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-primary"
                                onClick={() => handleDelete(archive.id)}
                            >
                                <Trash2 size={14} strokeWidth={1.8} />
                                确认删除
                            </button>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="chat-html-overlay" onClick={onClose}>
            <div
                className="g-card w-[min(88vw,440px)] max-h-[78vh] p-4 flex flex-col gap-3"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col gap-1 min-w-0">
                        <span className="menu-label">线下存档</span>
                        <span className="menu-desc !mt-0 truncate">
                            {sessionTitle ? `${sessionTitle} · ` : ""}线下内容每轮都会自动存进当前存档
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ui-bare-btn text-[var(--c-icon)] ts-18 leading-none shrink-0"
                        aria-label="关闭"
                    ><X size={18} strokeWidth={2} /></button>
                </div>

                <div className="flex flex-col gap-3 overflow-y-auto max-h-[52vh]">
                    {archives.length === 0 ? (
                        <span className="menu-desc !mt-0">
                            这个会话还没有线下存档。新建一份，聊天室的线下模式就会从这份存档开始记录。
                        </span>
                    ) : archives.map(renderRow)}
                </div>

                {creating ? (
                    <div className="flex flex-col gap-2 rounded-2xl border border-[var(--c-accent)] bg-[var(--c-input)]/70 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                            <input
                                autoFocus
                                value={draftName}
                                onChange={e => setDraftName(e.target.value)}
                                placeholder={suggestedName}
                                onKeyDown={e => {
                                    if (e.key === "Enter") handleCreate();
                                    if (e.key === "Escape") { setCreating(false); setDraftName(""); }
                                }}
                                className="flex-1 min-w-0 bg-transparent outline-none ts-14 text-[var(--c-text)]"
                            />
                            <button type="button" className="ui-btn ui-btn-primary" onClick={handleCreate}>创建并开始</button>
                            <button type="button" className="ui-btn ui-btn-outline" onClick={() => { setCreating(false); setDraftName(""); }}>取消</button>
                        </div>
                        {copyCandidate && copyCandidate.turnCount > 0 && (
                            <div className="flex items-center gap-2">
                                <div className="menu-label-group flex-1 min-w-0">
                                    <span className="menu-desc !mt-0">
                                        带上「{copyCandidate.name}」的 {copyCandidate.turnCount} 轮记录（复制成独立的一份）
                                    </span>
                                </div>
                                <Toggle checked={copySource} onChange={setCopySource} />
                            </div>
                        )}
                    </div>
                ) : (
                    <button
                        type="button"
                        className="ui-btn ui-btn-primary w-full"
                        onClick={startCreate}
                    >＋ 新增存档</button>
                )}
            </div>
        </div>
    );
}
