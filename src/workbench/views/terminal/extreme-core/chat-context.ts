import { formatSize } from "@/lib/format";
import type { ExtremeAttachment, ExtremeMessage } from "@/stores/extreme-store";

/**
 * 输入框底栏的「上下文」与「输出」偏好。
 *
 * 两者都只影响**下一次请求怎么组装**，不改服务器连接、权限与待审批任务：
 * 收窄上下文时，正在跑的任务仍然绑在原来那条连接上。
 */

/** 当前会话 = 带完整历史；仅本条 = 只带这句话；自选 = 只带勾选的材料。 */
export type ContextMode = "session" | "only" | "picked";

export type OutputStyle = "auto" | "brief" | "detailed" | "structured";

export const CONTEXT_MODES: readonly ContextMode[] = ["session", "only", "picked"];
export const OUTPUT_STYLES: readonly OutputStyle[] = ["auto", "brief", "detailed", "structured"];

/** 自选材料：附件、远程路径、上一条命令输出、计划步骤。 */
export interface PickedContext {
  kind: "attachment" | "path" | "output" | "step";
  /** 稳定 id（附件 id / 路径 / 步骤 id）。 */
  id: string;
  /** 显示在标签上的短标题。 */
  label: string;
  /** 真正放进提示词的正文。 */
  detail: string;
}

export const PICKED_KIND_LABEL: Record<PickedContext["kind"], string> = {
  attachment: "附件",
  path: "远程路径",
  output: "命令输出",
  step: "计划步骤",
};

/**
 * 带哪些历史消息。
 *
 * * `session`：最近若干条（按时间正序），与以前一致；
 * * `only` / `picked`：**不带**历史——独立问题不该被前面的对话带偏，
 *   也不该把上一台服务器的内容混进这次提问。
 */
export function historyFor(
  mode: ContextMode,
  messages: ExtremeMessage[],
  limit = 20,
): ExtremeMessage[] {
  if (mode !== "session") return [];
  return messages.filter((message) => message.text.trim()).slice(-limit);
}

/** 输出偏好 → 系统提示里的一句（`auto` 不加，保持现有行为）。 */
export function outputInstruction(style: OutputStyle): string | null {
  switch (style) {
    case "brief":
      return "**输出要求**：只给结论与下一步，最多三句话；细节、命令与日志留在右栏，不要复述。";
    case "detailed":
      return "**输出要求**：结论之后补齐判断依据与执行过程（为什么这么做、看到了什么），仍然避免空话。";
    case "structured":
      return "**输出要求**：用固定结构回答——结论 / 证据 / 下一步；每一项一行，证据里写清命令或文件路径。";
    default:
      return null;
  }
}

/** 自选材料 → 提示词里的段落（空数组 = 没有段落）。 */
export function pickedLines(items: PickedContext[]): string[] {
  if (items.length === 0) return [];
  const lines = ["**本次只依据这些材料**（用户勾选的上下文）："];
  for (const item of items) {
    const title = PICKED_KIND_LABEL[item.kind];
    lines.push(`- [${title}] ${item.label}`);
    const body = item.detail.trim();
    if (body) lines.push(`  ${body.replace(/\n+/g, "\n  ")}`);
  }
  return lines;
}

/**
 * 附件清单（给模型看的一行一份）。
 *
 * 只写**文件本身**的信息：路径、大小、文本/二进制、读取失败。不塞正文——
 * 正文在后面的段落里单独给，清单只负责"有哪些"。
 */
export function renderManifest(attachments: ExtremeAttachment[]): string {
  return attachments
    .map((item) => {
      const name = item.path ?? item.name;
      const traits = [formatSize(item.size)];
      if (item.binary) traits.push("二进制");
      if (item.state === "failed") traits.push("读取失败");
      if (item.uploadState === "uploaded") traits.push("已上传");
      return `- ${name}（${traits.join("，")}）`;
    })
    .join("\n");
}

/** 自选模式没有任何材料时，明确告诉模型"别猜"，而不是静默退回全量历史。 */
export function missingPickedHint(): string {
  return "（用户选择了「自选」上下文，但没有勾选任何材料：只回答这句话本身，不要假设服务器上的状态。）";
}
