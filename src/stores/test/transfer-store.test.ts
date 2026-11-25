import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferTask } from "@/api/ops-api";

/**
 * 传输状态的核心不变量：
 * - 旧快照 / 旧事件不能让进度倒退，也不能把终态改回进行中；
 * - 重试是新一次尝试（attempt +1），允许从 0 重新开始；
 * - 取消 / 重试的重复点击只提交一次；
 * - 列表加载失败不清空已经显示的任务。
 */
const listen = vi.hoisted(() => vi.fn());
const transferList = vi.hoisted(() => vi.fn());
const transferCancel = vi.hoisted(() => vi.fn());
const transferRetry = vi.hoisted(() => vi.fn());
const transferClearFinished = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({ listen }));

vi.mock("@/api/ops-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops-api")>();
  return {
    ...actual,
    opsApi: {
      ...actual.opsApi,
      transferList,
      transferCancel,
      transferRetry,
      transferClearFinished,
    },
  };
});

const loadStore = async () => await import("../transfer-store");

function task(overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    id: "t1",
    session_id: "s1",
    kind: "upload",
    name: "a.txt",
    source: "/tmp/a.txt",
    target: "/var/www/a.txt",
    total: 1000,
    transferred: 0,
    size_known: true,
    state: "running",
    batch_id: "b1",
    attempt: 1,
    revision: 5,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  listen.mockReset();
  listen.mockResolvedValue(() => undefined);
  transferList.mockReset();
  transferCancel.mockReset();
  transferRetry.mockReset();
  transferClearFinished.mockReset();
});

describe("mergeTask", () => {
  it("drops a snapshot that is older than the progress already shown", async () => {
    const { mergeTask } = await loadStore();
    const current = task({ transferred: 600, revision: 8 });

    const stale = mergeTask(current, task({ transferred: 200, revision: 7 }));
    expect(stale.transferred).toBe(600);
    expect(stale).toBe(current);
  });

  it("never lets a late event move a terminal task back to running", async () => {
    const { mergeTask } = await loadStore();
    const current = task({ state: "completed", transferred: 1000, revision: 9 });

    // 事件乱序：即使版本号更大，同一轮里也不能从终态回到进行中。
    const late = mergeTask(current, task({ state: "running", transferred: 900, revision: 10 }));
    expect(late.state).toBe("completed");
    expect(late.transferred).toBe(1000);
  });

  it("keeps transferred bytes monotonic within one attempt", async () => {
    const { mergeTask } = await loadStore();
    const current = task({ transferred: 800, revision: 8 });
    const next = mergeTask(current, task({ transferred: 700, revision: 9 }));
    expect(next.transferred).toBe(800);
  });

  it("starts a retried attempt from zero", async () => {
    const { mergeTask } = await loadStore();
    const current = task({ state: "completed", transferred: 1000, attempt: 1, revision: 20 });
    const retried = mergeTask(
      current,
      task({ state: "queued", transferred: 0, attempt: 2, revision: 21 }),
    );
    expect(retried.attempt).toBe(2);
    expect(retried.transferred).toBe(0);
    expect(retried.state).toBe("queued");
  });

  it("ignores an identical revision", async () => {
    const { mergeTask } = await loadStore();
    const current = task({ transferred: 500, revision: 9 });
    expect(mergeTask(current, task({ transferred: 0, revision: 9 }))).toBe(current);
  });

  it("treats an empty file as a known size, not unknown", async () => {
    const { normalizeTask } = await loadStore();
    expect(normalizeTask(task({ total: 0, size_known: true })).size_known).toBe(true);
  });
});

describe("useTransferStore", () => {
  it("keeps progress when the snapshot arrives late", async () => {
    const { useTransferStore } = await loadStore();
    useTransferStore.getState().applyRemote(task({ transferred: 640, revision: 7 }));

    transferList.mockResolvedValue([task({ transferred: 128, revision: 3 })]);
    await useTransferStore.getState().refresh();

    expect(useTransferStore.getState().tasks.t1.transferred).toBe(640);
    expect(useTransferStore.getState().loaded).toBe(true);
  });

  it("keeps the tasks already on screen when the list request fails", async () => {
    const { useTransferStore } = await loadStore();
    useTransferStore.getState().applyRemote(task({ revision: 2 }));
    const failure = new Error("list failed");
    transferList.mockRejectedValue(failure);

    await useTransferStore.getState().refresh();

    const state = useTransferStore.getState();
    expect(state.tasks.t1).toBeDefined();
    expect(state.error).toBe(failure);
    expect(state.loading).toBe(false);
  });

  it("submits cancel once and shows «cancelling» until the executor decides", async () => {
    const { useTransferStore } = await loadStore();
    useTransferStore.getState().applyRemote(task({ revision: 2 }));

    const reply = deferred<TransferTask>();
    transferCancel.mockReturnValue(reply.promise);

    const first = useTransferStore.getState().cancel("t1");
    void useTransferStore.getState().cancel("t1");
    expect(transferCancel).toHaveBeenCalledTimes(1);
    // 点击即进入「正在取消」，不等 IPC 往返。
    expect(useTransferStore.getState().cancelRequested.t1).toBe(true);

    reply.resolve(task({ state: "cancelling", revision: 3, error: undefined }));
    await first;

    expect(useTransferStore.getState().tasks.t1.state).toBe("cancelling");
    // 已由后端确认，本地标记撤掉。
    expect(useTransferStore.getState().cancelRequested.t1).toBeUndefined();

    // 执行器的最终结果：传输刚好已经完成。
    useTransferStore.getState().applyRemote(task({ state: "completed", revision: 4, transferred: 1000 }));
    expect(useTransferStore.getState().tasks.t1.state).toBe("completed");
  });

  it("reports a failed cancel on its own row", async () => {
    const { useTransferStore } = await loadStore();
    useTransferStore.getState().applyRemote(task({ revision: 2 }));
    transferCancel.mockRejectedValue(new Error("cancel failed"));

    await useTransferStore.getState().cancel("t1");

    expect(useTransferStore.getState().actionErrors.t1).toBeInstanceOf(Error);
    expect(useTransferStore.getState().cancelRequested.t1).toBeUndefined();
  });

  it("starts at most one retry for a burst of clicks", async () => {
    const { useTransferStore } = await loadStore();
    useTransferStore.getState().applyRemote(task({ state: "failed", revision: 4 }));

    const reply = deferred<TransferTask>();
    transferRetry.mockReturnValue(reply.promise);

    const first = useTransferStore.getState().retry("t1");
    void useTransferStore.getState().retry("t1");
    expect(transferRetry).toHaveBeenCalledTimes(1);

    reply.resolve(task({ state: "queued", attempt: 2, revision: 5, transferred: 0 }));
    await first;

    expect(useTransferStore.getState().tasks.t1.attempt).toBe(2);
    expect(useTransferStore.getState().tasks.t1.transferred).toBe(0);
    expect(useTransferStore.getState().pending.t1).toBeUndefined();
  });

  it("summarises only the current session for the toolbar entry", async () => {
    const { useTransferStore, activityLabel } = await loadStore();
    useTransferStore.getState().applyRemote(
      task({ id: "a", transferred: 500, revision: 1, session_id: "s1" }),
    );
    useTransferStore.getState().applyRemote(
      task({ id: "b", transferred: 250, revision: 1, session_id: "s1" }),
    );
    // 别的服务器、以及已结束的任务都不计入。
    useTransferStore.getState().applyRemote(task({ id: "c", revision: 1, session_id: "s2" }));
    useTransferStore.getState().applyRemote(
      task({ id: "d", state: "completed", revision: 1, session_id: "s1" }),
    );

    expect(activityLabel(useTransferStore.getState().tasks, "s1")).toBe("2 · 38%");
    expect(activityLabel(useTransferStore.getState().tasks, "s3")).toBe("");
  });

  it("counts an unknown-size task without inventing a percentage", async () => {
    const { useTransferStore, activityLabel } = await loadStore();
    useTransferStore.getState().applyRemote(
      task({ size_known: false, total: 0, transferred: 4096, revision: 1 }),
    );
    expect(activityLabel(useTransferStore.getState().tasks, "s1")).toBe("1");
  });

  it("drops cleared records but keeps tasks created after the request began", async () => {
    const { useTransferStore } = await loadStore();
    useTransferStore.getState().applyRemote(task({ id: "old", created_at: 1, revision: 1 }));

    const reply = deferred<TransferTask[]>();
    transferList.mockReturnValue(reply.promise);
    const refreshing = useTransferStore.getState().refresh();

    // 请求发出后新入队的任务不在快照里，必须留下。
    useTransferStore.getState().applyRemote(
      task({ id: "fresh", created_at: Date.now() + 1000, revision: 1 }),
    );
    reply.resolve([]);
    await refreshing;

    expect(useTransferStore.getState().tasks.old).toBeUndefined();
    expect(useTransferStore.getState().tasks.fresh).toBeDefined();
  });
});
