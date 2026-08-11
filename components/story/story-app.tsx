"use client";

import { Component, type ReactNode } from "react";
import { StoryApp as StoryAppInner } from "./story-app-base";
import { repairStoryStorageData, resetStoryStorageData } from "@/lib/story-storage";

type StoryAppProps = { onClose: () => void };

type StoryBoundaryState = {
  hasError: boolean;
  error: Error | null;
  repairing: boolean;
};

/**
 * 剧情模式顶层错误边界：任何渲染/生命周期异常都在这里兜住，
 * 避免整个应用崩成白屏（Netlify 部署版曾出现整页 client-side exception）。
 *
 * 「重试」不再是简单重置 hasError：先执行一次剧情数据清洗（repairStoryStorageData），
 * 把损坏记录/字段归一化后再重新挂载——否则同样的坏数据会让重试反复撞上同一个错误
 * （即此前"重试后仍打不开"的根因）。另提供「清空剧情数据」作为最后手段。
 */
class StoryAppErrorBoundary extends Component<{ children: ReactNode }, StoryBoundaryState> {
  state: StoryBoundaryState = { hasError: false, error: null, repairing: false };

  static getDerivedStateFromError(error: unknown): Partial<StoryBoundaryState> {
    return { hasError: true, error: error instanceof Error ? error : new Error(String(error)) };
  }

  private handleRetry = async () => {
    this.setState({ repairing: true });
    try {
      await repairStoryStorageData();
    } catch {
      // 清洗失败也继续尝试重新挂载
    }
    this.setState({ hasError: false, error: null, repairing: false });
  };

  private handleReset = async () => {
    if (!window.confirm("将清空所有剧情会话、消息与存档（角色卡与聊天记录不受影响）。确定继续？")) return;
    this.setState({ repairing: true });
    try {
      await resetStoryStorageData();
    } catch {
      // 忽略
    }
    this.setState({ hasError: false, error: null, repairing: false });
  };

  render() {
    if (this.state.hasError) {
      const errorMessage = this.state.error?.message || "";
      return (
        <div style={{ padding: 48, textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
          <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px" }}>剧情模式加载出错</p>
          <p style={{ fontSize: 13, color: "#8a8a8a", margin: "0 0 18px", lineHeight: 1.6 }}>
            {this.state.repairing
              ? "正在修复剧情数据…"
              : "已阻止错误影响其他功能。点击「重试」会先自动修复剧情数据；仍不行可清空剧情数据（不影响角色卡与聊天）。"}
          </p>
          {errorMessage ? (
            <p style={{ fontSize: 12, color: "#b0b0b0", margin: "0 0 18px", lineHeight: 1.5, wordBreak: "break-all" }}>
              {errorMessage}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => void this.handleRetry()}
              disabled={this.state.repairing}
              style={{
                padding: "9px 22px",
                borderRadius: 999,
                border: "1px solid #d0d0d0",
                background: "#fff",
                color: "#333",
                fontSize: 13,
                cursor: this.state.repairing ? "default" : "pointer",
                opacity: this.state.repairing ? 0.6 : 1,
              }}
            >
              {this.state.repairing ? "修复中…" : "重试"}
            </button>
            <button
              type="button"
              onClick={() => void this.handleReset()}
              disabled={this.state.repairing}
              style={{
                padding: "9px 22px",
                borderRadius: 999,
                border: "1px solid #e0c0c0",
                background: "#fff8f8",
                color: "#a33",
                fontSize: 13,
                cursor: this.state.repairing ? "default" : "pointer",
                opacity: this.state.repairing ? 0.6 : 1,
              }}
            >
              清空剧情数据并重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function StoryApp(props: StoryAppProps) {
  return (
    <StoryAppErrorBoundary>
      <StoryAppInner {...props} />
    </StoryAppErrorBoundary>
  );
}
