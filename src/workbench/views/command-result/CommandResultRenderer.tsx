import type { StructuredCommandResult } from "./model";
import { TableView } from "./views/TableView";
import { KeyValueView } from "./views/KeyValueView";
import { MetricsView } from "./views/MetricsView";
import { LogView } from "./views/LogView";
import { TreeView } from "./views/TreeView";
import { JsonView } from "./views/JsonView";
import { RawView } from "./views/RawView";

/**
 * 统一结果渲染器 —— **只按 `view` 分发**，完全不关心命令来自 Docker、
 * Nginx 还是普通 Linux 工具。
 *
 * 这是"统一输出适配引擎"的前端一半：新增命令只要后端产出 9 种视图之一，
 * 前端零改动。
 *
 * - `diff` / `progress`：协议已保留，但当前没有适配器产出（git diff 与
 *   构建进度在 P4.5+）。此时**退回 raw**，绝不显示空壳 UI。
 * - 任何未预期的 view 值同样退回 raw —— 解析/协议异常不影响可用性。
 */
export function CommandResultRenderer({ result }: { result: StructuredCommandResult }) {
  switch (result.view) {
    case "table":
      if (result.columns.length === 0) return <RawView {...result.raw} />;
      return (
        <TableView columns={result.columns} rows={result.rows} summary={result.summary} />
      );
    case "key_value":
      return <KeyValueView rows={result.rows} sections={result.sections} />;
    case "metrics":
      return <MetricsView rows={result.rows} />;
    case "log":
      return <LogView rows={result.rows} />;
    case "tree":
      return <TreeView rows={result.rows} />;
    case "json":
      return <JsonView value={result.json} />;
    // diff / progress 暂无数据源 → 退回原始输出（保留全部 stdout）。
    case "diff":
    case "progress":
    case "raw":
    default:
      return <RawView {...result.raw} />;
  }
}
