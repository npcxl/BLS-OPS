/**
 * 连接中的顶部光条。
 *
 * # 为什么需要它
 *
 * 点服务器 → 打开终端 → 握手 → 认证，这段可能几百毫秒到几秒。之前只有
 * 终端里的文字状态，用户点完不知道"到底有没有反应"。这里给一个**全局**
 * 的即时反馈：不管从哪个入口发起连接，右侧内容区顶部都会出现一条光条。
 *
 * # 状态从哪来
 *
 * 不新增一套状态：直接读 `useSessionStore` 里那些 `status === "connecting"`
 * 的会话。`TerminalView` 在发 `ssh_connect` **之前**就 `register()`，
 * 所有终止路径（成功 / 失败 / 断开 / 主机指纹待确认）都会把状态改掉，
 * 所以计数不会漏减——这一点有单测钉着。
 *
 * # 它不表达"还要多久"
 *
 * 连接耗时取决于网络与握手，假装有百分比会骗人。所以是不确定进度光条，
 * 只回答"正在发生"。
 */

import { useTranslation } from "react-i18next";

import { selectConnectingCount, useSessionStore } from "@/stores/session-store";

export function ConnectionProgressBar() {
  const { t } = useTranslation();
  // 只订阅计数：别的会话状态变化不会让这个组件重渲染。
  const connecting = useSessionStore(selectConnectingCount);

  if (connecting === 0) return null;

  // 定位在**右侧内容区**顶部：`Workspace` 的 `main` 是 `relative overflow-hidden`，
  // 所以这里用 `absolute inset-x-0 top-0`，光条不会横跨整个窗口，
  // 也不会压到左侧导航与侧栏。
  return (
    <div
      data-testid="connection-progress"
      role="progressbar"
      aria-label={t("Connecting to server")}
      // 不确定进度：不设 aria-valuenow（设了就等于谎称知道百分比）。
      aria-valuetext={t("Connecting")}
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] overflow-hidden"
    >
      <div className="ops-connect-sweep h-full w-1/3 bg-accent" />
    </div>
  );
}
