/**
 * 100 个隐藏工作项的结果缓存内存基准。
 *
 * 运行：node --expose-gc scripts/bench-result-memory.mjs
 *
 * 这里复现的是“结果数组仍被隐藏页持有 + 全局 LRU 预算”这一数据形态；
 * 不包含 React 组件/闭包的真实堆开销，结果用于回归趋势，不当作浏览器绝对值。
 */
const PAGES = Number(process.env.BENCH_PAGES ?? 100);
const ROWS = Number(process.env.BENCH_ROWS ?? 1000);
const COLS = Number(process.env.BENCH_COLS ?? 10);
const BUDGET = Number(process.env.BENCH_BUDGET_BYTES ?? 32 * 1024 * 1024);

const pages = new Map();
let touch = 0;
let total = 0;

function gc() {
  if (typeof global.gc === "function") global.gc();
}

function estimateRows(rows) {
  let bytes = 0;
  for (const row of rows) {
    for (const value of row) bytes += value.length * 2 + 32;
  }
  return bytes;
}

function evictOldest(keepId) {
  const candidates = [...pages.values()]
    .filter((page) => page.id !== keepId)
    .sort((a, b) => a.touched - b.touched);
  for (const page of candidates) {
    if (total <= BUDGET) break;
    total -= page.bytes;
    pages.delete(page.id);
  }
}

function addPage(id, rows) {
  const bytes = estimateRows(rows);
  pages.set(id, { id, rows, bytes, touched: ++touch });
  total += bytes;
  evictOldest(id);
}

gc();
const before = process.memoryUsage().heapUsed;
for (let index = 0; index < PAGES; index += 1) {
  const rows = Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLS }, (_, col) => `row-${row}-column-${col}-${"x".repeat(24)}`),
  );
  addPage(`page-${index}`, rows);
}
gc();
const after = process.memoryUsage().heapUsed;

console.log(
  JSON.stringify(
    {
      pagesConfigured: PAGES,
      rowsPerPage: ROWS,
      columns: COLS,
      budgetMiB: Number((BUDGET / 1024 / 1024).toFixed(1)),
      pagesRetained: pages.size,
      estimatedBytesRetained: total,
      heapDeltaMiB: Number(((after - before) / 1024 / 1024).toFixed(2)),
      gcAvailable: typeof global.gc === "function",
    },
    null,
    2,
  ),
);
