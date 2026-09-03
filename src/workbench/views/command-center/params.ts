/**
 * 参数与补全工具已合并到 `complete.ts`（命令中心与终端共用）。
 * 此文件保留为转发层，避免旧导入路径失效。
 */
export { buildArgs, completionKeys, needsParams, paramLabel, placeholderFor } from "./complete";
