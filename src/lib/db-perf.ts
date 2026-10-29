/**
 * 查询批次轻量采样。
 *
 * 只保留最近 500 个批次，不参与 UI 状态，不触发 React 渲染。
 * 开发时可在控制台查看：
 *   window.__blsDbPerf.summary()
 */
export interface DbBatchSample {
  at: number;
  ipcMs: number;
  processMs: number;
  kind: string;
  rows: number;
  bytes: number;
  resultSetId: string | null;
}

export interface DbBatchSummary {
  count: number;
  rows: number;
  bytes: number;
  ipcP50: number;
  ipcP95: number;
  ipcMax: number;
  processP95: number;
  slowest: DbBatchSample[];
}

const MAX_SAMPLES = 500;
const samples: DbBatchSample[] = [];

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

export function recordDbBatch(sample: DbBatchSample): void {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();

  if (
    typeof localStorage !== "undefined" &&
    localStorage.getItem("ops.db.debugBatchPerf") === "1" &&
    sample.ipcMs > 100
  ) {
    console.debug("[db-batch]", sample);
  }
}

export function summarizeDbBatches(
  input: readonly DbBatchSample[] = samples,
): DbBatchSummary {
  const ipc = input.map((sample) => sample.ipcMs);
  const process = input.map((sample) => sample.processMs);
  return {
    count: input.length,
    rows: input.reduce((sum, sample) => sum + sample.rows, 0),
    bytes: input.reduce((sum, sample) => sum + sample.bytes, 0),
    ipcP50: percentile(ipc, 0.5),
    ipcP95: percentile(ipc, 0.95),
    ipcMax: Math.max(0, ...ipc),
    processP95: percentile(process, 0.95),
    slowest: [...input]
      .sort((a, b) => b.ipcMs - a.ipcMs)
      .slice(0, 10),
  };
}

export function clearDbBatchSamples(): void {
  samples.length = 0;
}

if (typeof window !== "undefined") {
  (
    window as typeof window & {
      __blsDbPerf?: {
        summary: () => DbBatchSummary;
        clear: () => void;
        samples: readonly DbBatchSample[];
      };
    }
  ).__blsDbPerf = {
    summary: () => summarizeDbBatches(),
    clear: clearDbBatchSamples,
    samples,
  };
}
