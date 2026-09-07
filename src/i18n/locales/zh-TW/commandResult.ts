/**
 * zh-TW · 統一輸出適配結果面板（`src/workbench/views/command-result/**`）。
 *
 * 只按 `view` 分發的通用渲染層（JSON / 表格 / 樹 / 鍵值 / 日誌 / 指標 / 原始），
 * 因此文案也是**通用**的：不提任何具體命令。
 */
export default {
  // -- 檢視切換 --
  "Structured view": "結構化檢視",
  "Tree view": "樹檢視",
  "Expand all": "全部展開",
  "Collapse all": "全部摺疊",

  // -- 複製提示（title / aria）--
  "Click to copy the value": "點選複製該值",
  "Click to copy full value": "點選複製完整值",
  "Click to copy whole JSON": "點選複製整個 JSON",
  "Copy whole JSON": "複製整個 JSON",
  "Copy node JSON": "複製該節點的 JSON",
  "Click to copy this cell": "點選複製該單元格",
  "Click to copy this node's value": "點選複製該節點的值",
  "Click to copy: label + value + unit": "點選複製：名稱 + 數值 + 單位",
  "Copy full result": "複製完整結果",
  "Copy raw output": "複製原始輸出",
  "Copy raw output (without escape markers)": "複製原始輸出（去掉轉義標記）",
  "Copy executed command": "複製已執行的命令",
  "Copy path": "複製路徑",
  "Command copied": "命令已複製",
  "Output copied": "輸出已複製",

  // -- 元資訊 --
  "Command: {{command}}": "命令：{{command}}",
  "Executed: {{command}}": "已執行：{{command}}",
  "Duration: {{ms}} ms": "耗時：{{ms}} 毫秒",

  // -- JSON 摺疊佔位 --
  "[…] {{count}} items": "[…] {{count}} 項",
  "{…} {{count}} keys": "{…} {{count}} 個鍵",

  // -- 搜尋與空態 --
  "Search keys / values…": "搜尋鍵 / 值…",
  "No data.": "沒有資料。",
  "No nodes.": "沒有節點。",
  "No properties.": "沒有屬性。",
  "No metrics.": "沒有指標。",
  "No log entries.": "沒有日誌條目。",
  "No matching records.": "沒有匹配的記錄。",
  "No errors or warnings.": "沒有錯誤或警告。",
  "Errors & warnings only ({{count}})": "僅錯誤與警告（{{count}}）",
  "{{count}} entries": "{{count}} 條記錄",
} as const;
