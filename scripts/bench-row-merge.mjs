/**
 * 可重复运行的前端批次合并基准。
 * 模拟 db_query_next 每批 rows 追加到结果数组：
 * - old: rows.concat(batch)（每批复制全部历史）
 * - new: rows.push(...batch)（只追加本批）
 *
 * 运行：node scripts/bench-row-merge.mjs
 */
const totalRows = Number(process.env.BENCH_ROWS ?? 200_000);
const batchSize = Number(process.env.BENCH_BATCH ?? 1_000);

function batches() {
  const list = [];
  for (let start = 0; start < totalRows; start += batchSize) {
    list.push(
      Array.from({ length: Math.min(batchSize, totalRows - start) }, (_, i) => ({
        id: start + i,
        value: `row-${start + i}`,
      })),
    );
  }
  return list;
}

function runConcat(list) {
  let rows = [];
  const started = performance.now();
  for (const batch of list) rows = rows.concat(batch);
  return { ms: performance.now() - started, rows: rows.length };
}

function runPush(list) {
  const rows = [];
  const started = performance.now();
  for (const batch of list) rows.push(...batch);
  return { ms: performance.now() - started, rows: rows.length };
}

const input = batches();
const concat = runConcat(input);
const push = runPush(input);
console.log(
  JSON.stringify(
    {
      rows: totalRows,
      batchSize,
      batches: input.length,
      concatMs: Number(concat.ms.toFixed(2)),
      pushMs: Number(push.ms.toFixed(2)),
      speedup: Number((concat.ms / Math.max(push.ms, 0.01)).toFixed(1)),
      sameRowCount: concat.rows === push.rows,
    },
    null,
    2,
  ),
);
