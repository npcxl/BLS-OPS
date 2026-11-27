import { beforeEach, describe, expect, it, vi } from "vitest";
import { opsApi } from "@/api/ops-api";
import { useExtremeStore } from "@/stores/extreme-store";
import { readAttachment } from "../attachments";
import {
  hasActiveTransfers,
  isAttachmentUploading,
  removeStagedAttachment,
  stageWorkspaceAttachment,
  stagingDir,
  verifyStagedAttachment,
} from "../attachments/staging";
import {
  isCleanupBlocked,
  isPlatformStagedPath,
} from "../attachments/cleanup";

const t = ((key: string) => key) as never;

function enter() {
  useExtremeStore.getState().enter("srv-1", "prod", "sess-1", "root@host:22");
  const workspaceId = useExtremeStore.getState().ensureWorkspace()!;
  return workspaceId;
}

function mockRemote(root = "/root") {
  let mkdirCount = 0;
  const sizes = new Map<string, number>();
  const exec = vi.spyOn(opsApi, "sshExec").mockImplementation(async (_session, command) => {
    if (command.includes("mkdir -p")) {
      mkdirCount += 1;
      // 复刻真实脚本的返回值：父目录的规范化绝对路径。
      const match = /mkdir -p -- '([^']+)'/.exec(command);
      return { stdout: `${root}/${match?.[1] ?? ""}`, stderr: "", exit_code: 0, truncated: false };
    }
    if (command.includes("wc -c")) {
      const path = /test -f '([^']+)'/.exec(command)?.[1] ?? "";
      // 分块写的是 `.part`，回读核验的是正式名：两边都认。
      const size = sizes.get(path) ?? sizes.get(`${path}.part`) ?? 0;
      return { stdout: String(size), stderr: "", exit_code: 0, truncated: false };
    }
    return { stdout: "", stderr: "", exit_code: 0, truncated: false };
  });
  const chunk = vi.spyOn(opsApi, "sftpWriteChunk").mockImplementation(
    async (_session, path, offset, base64) => {
      const total = offset + atob(base64).length;
      sizes.set(path, total);
      return total;
    },
  );
  const finish = vi.spyOn(opsApi, "sftpStageFinish").mockResolvedValue(undefined);
  return { exec, chunk, finish, mkdirs: () => mkdirCount };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useExtremeStore.getState().exit();
});

describe("暂存目录按附件身份隔离同名文件", () => {
  it("workspace + attachmentId 进目录，同名 dist.zip 不会互相覆盖", () => {
    const dir = stagingDir("ws-1", "att-new");
    expect(dir).toBe(".bls-ops/staging/ws-1/att-new");
    expect(stagingDir("ws-1", "att-old")).not.toBe(dir);
    // 非法 id 直接拒绝，绝不让路径拼进 shell。
    expect(() => stagingDir("ws-1", "../etc")).toThrow();
  });
});

describe("统一上传服务", () => {
  it("同一附件只传一次：并发调用共享同一个 Promise", async () => {
    const workspaceId = enter();
    const file = new File([new Uint8Array(2048)], "dist.zip");
    const attachment = await readAttachment(file, { id: "att-same", t });
    useExtremeStore.getState().setAttachments(() => [attachment]);
    const remote = mockRemote();

    const [a, b] = await Promise.all([
      stageWorkspaceAttachment({ workspaceId, serverId: "srv-1", sessionId: "sess-1", attachment }),
      stageWorkspaceAttachment({ workspaceId, serverId: "srv-1", sessionId: "sess-1", attachment }),
    ]);

    expect(remote.mkdirs()).toBe(1);
    expect(remote.chunk).toHaveBeenCalledTimes(1);
    expect(a.remotePath).toBe(b.remotePath);
    expect(a.remotePath).toContain(`/.bls-ops/staging/${workspaceId}/att-same/`);
    expect(a.remotePath?.endsWith("/.part")).toBe(false);
    expect(useExtremeStore.getState().attachments[0].uploadState).toBe("uploaded");
    expect(useExtremeStore.getState().attachments[0].staged).toBe(true);
  });

  it("同名的新包走自己的目录，发送时不会拿到旧包路径", async () => {
    const workspaceId = enter();
    const oldFile = new File([new Uint8Array(1024)], "dist.zip");
    const newFile = new File([new Uint8Array(512)], "dist.zip");
    const oldItem = await readAttachment(oldFile, { id: "att-old", t });
    const newItem = await readAttachment(newFile, { id: "att-new", t });
    useExtremeStore.getState().setAttachments(() => [oldItem, newItem]);
    mockRemote();

    const [a, b] = await Promise.all([
      stageWorkspaceAttachment({ workspaceId, serverId: "srv-1", sessionId: "sess-1", attachment: oldItem }),
      stageWorkspaceAttachment({ workspaceId, serverId: "srv-1", sessionId: "sess-1", attachment: newItem }),
    ]);

    expect(a.remotePath).not.toBe(b.remotePath);
    expect(b.remotePath).toContain(`/${workspaceId}/att-new/`);
  });

  it("上传中能被清空 / 删除感知", async () => {
    const workspaceId = enter();
    const attachment = await readAttachment(new File([new Uint8Array(1024)], "a.bin"), {
      id: "att-busy",
      t,
    });
    useExtremeStore.getState().setAttachments(() => [attachment]);
    let release: (() => void) | null = null;
    vi.spyOn(opsApi, "sshExec").mockImplementation(async (_session, command) => {
      if (command.includes("mkdir -p")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { stdout: "/root/.bls-ops/staging", stderr: "", exit_code: 0, truncated: false };
      }
      return { stdout: "1024", stderr: "", exit_code: 0, truncated: false };
    });
    vi.spyOn(opsApi, "sftpWriteChunk").mockResolvedValue(1024);
    vi.spyOn(opsApi, "sftpStageFinish").mockResolvedValue(undefined);

    const pending = stageWorkspaceAttachment({
      workspaceId,
      serverId: "srv-1",
      sessionId: "sess-1",
      attachment,
    });
    await Promise.resolve();
    expect(isAttachmentUploading(workspaceId, "att-busy")).toBe(true);
    expect(hasActiveTransfers(workspaceId)).toBe(true);
    const resume = release as (() => void) | null;
    resume?.();
    await pending;
    expect(isAttachmentUploading(workspaceId, "att-busy")).toBe(false);
  });

  it("回读字节数对不上就整条失败，并把原因写回附件", async () => {
    const workspaceId = enter();
    const attachment = await readAttachment(new File([new Uint8Array(1024)], "dist.zip"), {
      id: "att-short",
      t,
    });
    useExtremeStore.getState().setAttachments(() => [attachment]);
    mockRemote();
    // 服务器实际只有 10 字节（传输被截断）。
    vi.spyOn(opsApi, "sshExec").mockImplementation(async (_session, command) => {
      if (command.includes("mkdir -p")) {
        const parent = /mkdir -p -- '([^']+)'/.exec(command)?.[1] ?? "";
        return {
          stdout: `/root/${parent}`,
          stderr: "",
          exit_code: 0,
          truncated: false,
        };
      }
      if (command.includes("wc -c")) {
        return { stdout: "10", stderr: "", exit_code: 0, truncated: false };
      }
      return { stdout: "", stderr: "", exit_code: 0, truncated: false };
    });

    const result = await stageWorkspaceAttachment({
      workspaceId,
      serverId: "srv-1",
      sessionId: "sess-1",
      attachment,
    });
    expect(result.remotePath).toBeUndefined();
    expect(result.remoteError).toMatch(/大小不匹配|size does not match/);
    expect(useExtremeStore.getState().attachments[0].uploadState).toBe("local");
  });
});

describe("清理只删暂存副本", () => {
  it("已部署的附件：删暂存目录，线上目标与部署状态都不动", async () => {
    const workspaceId = enter();
    const attachment = {
      id: "att-deployed",
      name: "dist.zip",
      size: 1,
      state: "ready" as const,
      uploadState: "deployed" as const,
      staged: true,
      stagedPath: `/root/.bls-ops/staging/${workspaceId}/att-deployed/dist.zip`,
      remotePath: "/var/www/app/dist.zip",
    };
    useExtremeStore.getState().setAttachments(() => [attachment]);
    const exec = vi.spyOn(opsApi, "sshExec").mockResolvedValue({
      stdout: "",
      stderr: "",
      exit_code: 0,
      truncated: false,
    });

    await removeStagedAttachment({
      sessionId: "sess-1",
      workspaceId,
      serverId: "srv-1",
      item: attachment,
    });

    const command = String(exec.mock.calls[0][1]);
    expect(command).toContain(`.bls-ops/staging/${workspaceId}/att-deployed`);
    expect(command).not.toContain("/var/www/app");

    const after = useExtremeStore.getState().attachments[0];
    expect(after.uploadState).toBe("deployed");
    expect(after.remotePath).toBe("/var/www/app/dist.zip");
    expect(after.stagedCleaned).toBe(true);
    expect(after.stagedPath).toBeUndefined();
  });
});

describe("发送前核验", () => {
  it("服务器上的文件没了 → false", async () => {
    vi.spyOn(opsApi, "sshExec").mockResolvedValue({
      stdout: "",
      stderr: "No such file",
      exit_code: 1,
      truncated: false,
    });
    expect(
      await verifyStagedAttachment("sess-1", {
        id: "att-x",
        name: "dist.zip",
        size: 1,
        state: "ready",
        remotePath: "/root/.bls-ops/staging/ws/att-x/dist.zip",
      }),
    ).toBe(false);
  });
});

describe("清理范围", () => {
  const item = { id: "att-1", remotePath: "/root/.bls-ops/staging/ws-1/att-1/dist.zip" };

  it("只认平台暂存目录，线上同名文件与站点备份不匹配", () => {
    expect(isPlatformStagedPath("ws-1", item)).toBe(true);
    expect(isPlatformStagedPath("ws-2", item)).toBe(false);
    expect(
      isPlatformStagedPath("ws-1", { id: "att-1", remotePath: "/var/www/dist.zip" }),
    ).toBe(false);
    expect(
      isPlatformStagedPath("ws-1", { id: "att-1", remotePath: "/var/www.bak/dist.zip" }),
    ).toBe(false);
  });

  it("被运行任务或排队消息引用时保留", () => {
    const request = { workspaceId: "ws-1" };
    expect(
      isCleanupBlocked(request, item, {
        tasks: { t1: { workspaceId: "ws-1", status: "running" } },
        queuedSends: [],
      }),
    ).toBe(true);
    expect(
      isCleanupBlocked(request, item, {
        tasks: {},
        queuedSends: [
          {
            id: "q1",
            workspaceId: "ws-1",
            text: "",
            attachments: [{ id: "att-1", name: "dist.zip", size: 1 }],
            selection: { providerId: null, model: "m", effort: "medium", contextBudget: null },
            context: "session",
            output: "brief",
            picked: [],
            createdAt: 1,
            error: null,
          },
        ],
      }),
    ).toBe(true);
    expect(isCleanupBlocked(request, item, { tasks: {}, queuedSends: [] })).toBe(false);
  });

  it("非平台副本拒绝删除", async () => {
    const exec = vi.spyOn(opsApi, "sshExec").mockResolvedValue({
      stdout: "",
      stderr: "",
      exit_code: 0,
      truncated: false,
    });
    await expect(
      removeStagedAttachment({
        sessionId: "sess-1",
        workspaceId: "ws-1",
        serverId: "srv-1",
        item: {
          id: "att-1",
          name: "dist.zip",
          size: 1,
          state: "ready",
          // 部署后的线上目标：不是平台暂存目录，必须拒绝。
          remotePath: "/var/www/dist.zip",
          stagedPath: "/var/www/dist.zip",
          staged: true,
        },
      }),
    ).rejects.toThrow(/不匹配|does not match/);
    expect(exec).not.toHaveBeenCalled();
  });
});
