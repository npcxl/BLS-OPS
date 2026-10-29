/**
 * 复制动作的唯一出口：序列化 → 写剪贴板 → 返回结构化结果。
 *
 * 序列化与写剪贴板分开，是因为"写失败"和"内容太大"要给用户**不同**的提示
 * （前者查剪贴板权限，后者建议改用导出）。UI 只消费这里的结果，不自己拼字符串。
 */
import { copyText } from "@/lib/clipboard";
import { buildCopyText, type CopyRequest, type CopyResult } from "./copy-format";

export type CopyOutcome = CopyResult & { written: boolean };

export async function copySelectionToClipboard(request: CopyRequest): Promise<CopyOutcome> {
  const result = await buildCopyText(request);
  if (!result.ok) return { ...result, written: false };
  const written = await copyText(result.text);
  return { ...result, written };
}
