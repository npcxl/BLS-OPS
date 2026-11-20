/**
 * English overrides for Chinese natural keys used by direct `t("...")` calls.
 *
 * Kept next to the Chinese `coverage.ts` so the reverse direction is checked by
 * `src/i18n/test/direct-keys.test.ts` too.
 */
export default {
  "确认{{what}}": "Confirm {{what}}",
  "{{reason}}。可以再试一次。": "{{reason}}. You can try again.",
  "哨兵/集群模式下所有节点必须能从本机直连（不支持经 SSH 隧道），且当前版本不支持订阅（pub/sub）。":
    "In Sentinel/cluster mode, every node must be directly reachable from this machine (SSH tunnels are not supported), and this version does not support pub/sub.",
  "只读连接：键的写入、删除、TTL 修改与 PUBLISH 都会被拒绝，只能浏览。要修改数据请显式关闭。":
    "Read-only connection: key writes, deletes, TTL changes and PUBLISH are rejected; browsing only. Turn it off explicitly to modify data.",
  "连接配置已经保存，可以随时编辑；但当前版本没有该引擎的真实驱动，因此不会建立连接、也不会执行任何 SQL。配置不会被删除。":
    "The connection is saved and can be edited at any time, but this version has no real driver for this engine, so no connection is opened and no SQL runs. The configuration is not deleted.",
  "已复制 {{cells}} 个单元格；其中 {{partial}} 个字段为截断预览或不支持类型，完整内容请查看详情或导出。":
    "Copied {{cells}} cells; {{partial}} fields were truncated previews or unsupported types. Open details or export for the full content.",
  "该值在查询结果中已被截断（原始 {{bytes}} 字节），这里只显示已接收的预览。请从表数据页读取完整值。":
    "This value was truncated in the query result ({{bytes}} bytes original); only the received preview is shown. Read the full value from the table data page.",
  "将写入 {{cells}} 个单元格（{{rows}} 行 × {{cols}} 列），起点为焦点单元格。":
    "Will write {{cells}} cells ({{rows}} rows × {{cols}} columns), starting at the focused cell.",
  "目标包含主键列（{{columns}}）：提交时按主键定位，重复主键会让整笔事务回滚。":
    "The target includes primary-key columns ({{columns}}): rows are located by primary key on commit; duplicate keys roll back the whole transaction.",
  "这次对话还没有文件变更：AI 用 write_file 改文件时，这里会显示预览与实际差异。":
    "No file changes in this conversation yet. When the AI edits files with write_file, previews and actual diffs appear here.",
  "普通 shell 命令（sed / tee / 脚本）拿不到明确目标与前后快照，不会生成 Diff。":
    "Plain shell commands (sed / tee / scripts) have no reliable target or before/after snapshot, so no diff is generated.",
} as const;
