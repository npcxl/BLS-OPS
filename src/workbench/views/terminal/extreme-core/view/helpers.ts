/**
 * 超能视图里的纯工具：命令拼装、静态站点确认、引用块、审批解释与输入焦点。
 *
 * 都不依赖 React 状态 —— 只是为了不再往 6k 行的视图文件里堆函数。
 */
import { opsApi } from "@/api/ops-api";
import type { AgentApproval } from "@/api/types/agent";
import { classifySite, parseNginxConfig, staticDirs } from "../site-discovery";
import type { VerifiedTarget } from "../task-context";

/** i18n 的 t：只用到「取一句人话」这一层能力。 */
export type TFn = (key: string, options?: Record<string, unknown>) => string;

/** 单引号转义：这些路径来自用户输入，直接拼进 shell 会被截断。 */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * 只读确认「这台机器上确实有一个静态站点」。
 *
 * 判定顺序全部来自实测：`nginx -T` 展开所有 include → 只认 `classifySite` 为
 * static 的 server → 取它的 root，再 `test -f` 确认 index.html 真在。拿不到
 * nginx、没有静态 server、目录不可读时一律返回 `null`（**不猜**），调用方据此
 * 退回"等待补充信息"而不是硬塞一个静态更新计划。
 */
export async function detectStaticSite(sessionId: string): Promise<VerifiedTarget | null> {
  try {
    const config = await opsApi.sshExec(sessionId, "nginx -T 2>/dev/null", 20_000);
    if (config.exit_code !== 0 || !config.stdout.trim()) return null;
    for (const server of parseNginxConfig(config.stdout)) {
      if (classifySite(server) !== "static") continue;
      const root = staticDirs(server).find((dir) => dir.startsWith("/") && !dir.includes("$"));
      if (!root) continue;
      const probe = await opsApi.sshExec(
        sessionId,
        `test -f ${shellQuote(`${root}/index.html`)} && echo yes || echo no`,
        8_000,
      );
      if (probe.stdout.trim() !== "yes") continue;
      return {
        kind: "static-site",
        root,
        evidence: `nginx -T: ${server.serverNames.join(", ") || "默认 server"} → root ${root}，index.html 存在`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 引用一条回复：整段变成 Markdown 引用块，末尾留一个空行给追问。
 *
 * 空行也写成 `>`，否则引用块会在空行处断掉，后半段就不是引用了。
 */
export function quoteBlock(text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

/**
 * 用户问「会影响什么」时的答复：**只讲这一步自己的事实**。
 *
 * 内容全部来自确认卡（摘要 / 影响 / 路径 / 备份 / 回滚），不新起一次模型
 * 请求 —— 那会和在等的这条任务抢同一台机器，也答不出比卡片更准的东西。
 */
export function explainApproval(
  approval: AgentApproval,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const lines: string[] = [];
  const summary = approval.summary?.trim() || approval.command.split("\n")[0]?.trim() || "";
  if (summary) lines.push(t("这一步要做：{{summary}}", { summary }));
  const impact = approval.impact?.trim();
  lines.push(
    impact
      ? t("影响：{{impact}}", { impact })
      : t("影响未知：无法判断它会改什么，展开详情可以看到完整命令。"),
  );
  if (approval.path) lines.push(t("涉及文件：{{path}}", { path: approval.path }));
  if (approval.backupPath) lines.push(t("会先备份到：{{path}}", { path: approval.backupPath }));
  if (approval.rollback) lines.push(t("要回滚就用：{{command}}", { command: approval.rollback }));
  lines.push(t("确认继续吗？回复「按你说的改」执行，「先别动」取消。"));
  return lines.join("\n");
}

/**
 * 把焦点交回输入框，并把光标放到**末尾**。
 *
 * 编辑与引用都是"接着这段话继续写"，光标落在中间会让人一上手就覆盖原文。
 * 受控值要等 React 提交到 DOM 之后再量长度，所以放到下一帧。
 */
export function focusComposerEnd(): void {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-extreme-composer] textarea",
    );
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

/** 能力 id → 英文名（中文名在 `capabilities.ts` 里，中文界面直接用）。 */
export const CAPABILITY_EN: Record<string, string> = {
  kubernetes: "Kubernetes workload",
  compose: "Docker Compose service",
  "static-nginx": "Static site (Nginx-hosted)",
  systemd: "systemd service",
  "bare-linux": "Plain Linux project",
};
