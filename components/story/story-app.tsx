"use client";

import { Component, type ReactNode } from "react";
import { StoryApp as StoryAppInner } from "./story-app-base";

type StoryAppProps = { onClose: () => void };

/**
 * 剧情模式顶层错误边界：任何渲染/生命周期异常都在这里兜住，
 * 避免整个应用崩成白屏（Netlify 部署版曾出现整页 client-side exception）。
 */
class StoryAppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 48, textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
          <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px" }}>剧情模式加载出错</p>
          <p style={{ fontSize: 13, color: "#8a8a8a", margin: "0 0 18px", lineHeight: 1.6 }}>
            已阻止错误影响其他功能。可以点击重试，或回到桌面后重新进入。
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            style={{
              padding: "9px 22px",
              borderRadius: 999,
              border: "1px solid #d0d0d0",
              background: "#fff",
              color: "#333",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            重试
          </button>
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
