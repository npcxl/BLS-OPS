/**
 * 附件暂存：用户加入本地文件后，**平台后台**把它写到任务绑定服务器的
 * 专属目录，按附件 id 隔离同名文件（`dist.zip` 换一次就是另一份）。
 *
 * 目录形状：`$HOME/.bls-ops/staging/<workspaceId>/<attachmentId>/<原始路径>`
 * - workspaceId 隔离对话；attachmentId 隔离同名的多次上传；
 * - 只写这份**副本**，不碰线上文件、站点备份或用户引用的远程原文件；
 * - 发送时只用这里**核验过**的路径，缺包就报错，绝不拿历史同名包顶替。
 *
 * # 一个传输服务
 *
 * 自动暂存、附件面板重试、手动上传、聊天发送与队列派发都走
 * [`stageWorkspaceAttachment`]。它按 `workspaceId + serverId + attachmentId`
 * 去重：同一份附件在**同一台服务器**上只会有一个在飞的上传；重连换了
 * sessionId 不会复用旧连接上的 Promise；切换到别的服务器则根本不会命中。
 *
 * # 大文件不进 React 状态
 *
 * 内容从 [`attachmentSource`] 按块读，逐块写入（1 MiB/块），内存里最多一个
 * 块。进度写回 store 的 `remoteProgress`，不把字节本身放进去。
 */
import { opsApi } from "@/api/ops-api";
import { i18n } from "@/i18n";
import { useExtremeStore, type ExtremeAttachment } from "@/stores/extreme-store";
import { attachmentSource, dropAttachmentFile } from "./payload";
import { bytesToBase64 } from "./payload";

/** 每块 1 MiB：IPC base64 约 1.4 MB，进度也足够细。 */
const CHUNK_BYTES = 1024 * 1024;
/**
 * 做 SHA-256 核验的体积上限。
 *
 * 超过它就不再整份读进内存（那会把大文件重新带回内存瓶颈），只核验字节数；
 * 常见附件（几百 KB ~ 十几 MB）两者都验。
 */
const HASH_VERIFY_MAX = 16 * 1024 * 1024;

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const digest = await subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** 同一附件在同一服务器上的在飞上传（重连后 sessionId 变了不复用）。 */
const pending = new Map<string, { sessionId: string; promise: Promise<ExtremeAttachment> }>();
/**
 * 上传代次：同一附件重试时，旧的一次可能晚于新的完成。只有**最新一次**
 * 允许写回 store，旧结果只用于清理它自己写下的半截文件。
 */
const generations = new Map<string, number>();

function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function transferKey(workspaceId: string, serverId: string | null, attachmentId: string): string {
  return `${workspaceId}\u0000${serverId ?? ""}\u0000${attachmentId}`;
}

/** 该附件在这台服务器上的暂存目录（不含文件名）。 */
export function stagingDir(workspaceId: string, attachmentId: string): string {
  if (![workspaceId, attachmentId].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error(i18n.t("无效的暂存目录标识"));
  }
  return `.bls-ops/staging/${workspaceId}/${attachmentId}`;
}

/** 附件里保留的相对路径（目录上传时是 `web/dist/index.html`）。 */
function relativePath(attachment: ExtremeAttachment): string {
  const raw = attachment.path || attachment.name;
  const parts = raw.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error(i18n.t("无效的附件相对路径"));
  }
  return parts.join("/");
}

/** 这条附件现在还在原来那条对话里吗（用户可能已经删掉它）。 */
function stillOwned(workspaceId: string, attachmentId: string): boolean {
  const state = useExtremeStore.getState();
  const items =
    state.workspaceId === workspaceId
      ? state.attachments
      : state.workspaces.find((entry) => entry.id === workspaceId)?.context?.attachments ?? [];
  return items.some((item) => item.id === attachmentId);
}

/** 写回**发起时那条对话**（切到 B 时不能把 A 的结果写进 B 的镜像）。 */
function patchAttachment(
  workspaceId: string,
  attachmentId: string,
  patch: (item: ExtremeAttachment) => ExtremeAttachment,
): void {
  useExtremeStore.getState().setAttachmentsIn(workspaceId, (items) =>
    items.map((item) => (item.id === attachmentId ? patch(item) : item)),
  );
}

async function removeRemoteDir(sessionId: string, workspaceId: string, attachmentId: string): Promise<void> {
  let dir: string;
  try {
    dir = stagingDir(workspaceId, attachmentId);
  } catch {
    return;
  }
  await opsApi
    .sshExec(sessionId, `cd "$HOME" && rm -rf -- ${quote(dir)}`, 15_000)
    .catch(() => undefined);
}

export interface StageInput {
  workspaceId: string;
  /** 服务器配置 id（身份）；`null` = 这条对话未关联服务器。 */
  serverId: string | null;
  /** 当前这次 SSH 连接（重连会变，只用于传输本身）。 */
  sessionId: string;
  attachment: ExtremeAttachment;
  /** 被更新的上传取代时不再写回（内部用）。 */
  generation?: number;
}

/**
 * 上传一份附件并**回读核验**。
 *
 * 返回核验过的绝对路径；任何一步失败都抛出，由调用方把附件标成 failed。
 */
async function stageAttachment(input: StageInput, generation: number): Promise<string> {
  const { workspaceId, serverId, sessionId, attachment } = input;
  const dir = stagingDir(workspaceId, attachment.id);
  const relative = relativePath(attachment);
  const parent = relative.includes("/") ? `${dir}/${relative.slice(0, relative.lastIndexOf("/"))}` : dir;
  const baseName = relative.slice(relative.lastIndexOf("/") + 1);

  const source = attachmentSource(attachment);
  if (!source) {
    throw new Error(
      i18n.t("本机附件内容不可用（应用重启或文件已被删除）：请重新选择文件"),
    );
  }

  const mkdir = await opsApi.sshExec(
    sessionId,
    `umask 077 && cd "$HOME" && mkdir -p -- ${quote(parent)} && cd -- ${quote(parent)} && pwd -P`,
    15_000,
  );
  const absolute = mkdir.stdout.trim();
  if (mkdir.exit_code !== 0 || !absolute.startsWith("/") || !absolute.endsWith(`/${parent}`)) {
    throw new Error(mkdir.stderr.trim() || i18n.t("创建暂存目录失败"));
  }
  const target = `${absolute}/${baseName}`;
  // `.part` 与目标同目录：写完再原子改名，失败不会留下"看起来完整"的半截包。
  const part = `${target}.part`;

  let written = 0;
  for (let offset = 0; offset < source.total; offset += CHUNK_BYTES) {
    if (generation !== generations.get(transferKey(workspaceId, serverId, attachment.id))) {
      throw new Error(i18n.t("这次上传已被新的上传取代"));
    }
    const chunk = await source.read(offset, CHUNK_BYTES);
    if (chunk.length === 0) break;
    written = await opsApi.sftpWriteChunk(sessionId, part, offset, bytesToBase64(chunk));
    const percent = source.total === 0 ? 100 : Math.min(99, Math.round((written / source.total) * 100));
    if (generation === generations.get(transferKey(workspaceId, serverId, attachment.id))) {
      patchAttachment(workspaceId, attachment.id, (item) => ({
        ...item,
        uploadState: "uploading",
        remoteProgress: percent,
        remoteError: undefined,
      }));
    }
  }
  if (written !== source.total) {
    throw new Error(
      i18n.t("上传未完成：已写 {{written}} / {{total}} 字节", {
        written,
        total: source.total,
      }),
    );
  }

  await opsApi.sftpStageFinish(sessionId, part, target);

  /*
   * 回读核验：只有真正在服务器上、字节数对得上，才把路径交给模型。
   *
   * 文本附件写的是**解码后的字符串**，字节长度和本地文件大小不一定相同
   * （BOM / CRLF / 非法 UTF-8 都会变），所以统一按 `attachmentSource.total`
   * （也就是真正写上去的字节数）比较，而不是 `attachment.size`。
   */
  const probe = await opsApi.sshExec(
    sessionId,
    `test -f ${quote(target)} && wc -c < ${quote(target)}`,
    15_000,
  );
  const size = probe.stdout.trim();
  if (probe.exit_code !== 0 || !/^\d+$/.test(size) || Number(size) !== source.total) {
    throw new Error(i18n.t("暂存文件回读失败：服务器文件大小不匹配"));
  }
  /*
   * 体积允许时再比一次 SHA-256：字节数相同也可能是传串了内容（同名包互换
   * 就是这种事故）。服务器没有 `sha256sum` / 本机没有 WebCrypto 时跳过，
   * 不让一个"额外的校验"反过来阻断上传。
   */
  if (source.total > 0 && source.total <= HASH_VERIFY_MAX) {
    const local = await sha256Hex(await source.read(0, source.total));
    if (local) {
      const remote = await opsApi
        .sshExec(sessionId, `sha256sum -- ${quote(target)}`, 30_000)
        .catch(() => null);
      const remoteHash = remote?.stdout.trim().split(/\s+/)[0]?.toLowerCase();
      if (remote && remote.exit_code === 0 && /^[0-9a-f]{64}$/.test(remoteHash ?? "") &&
        remoteHash !== local) {
        throw new Error(i18n.t("暂存文件校验失败：服务器内容与本地不一致"));
      }
    }
  }
  return target;
}

/**
 * 暂存一份附件（幂等）。
 *
 * 同一 `workspaceId + serverId + attachmentId` 的并发调用共享同一个 Promise；
 * 重连换了 `sessionId` 则重新开始 —— 旧连接上的 Promise 只会失败，不会把
 * "成功"写到新连接上。
 */
export function stageWorkspaceAttachment(
  input: StageInput,
): Promise<ExtremeAttachment> {
  const { workspaceId, serverId, sessionId, attachment } = input;
  const key = transferKey(workspaceId, serverId, attachment.id);
  const existing = pending.get(key);
  if (existing && existing.sessionId === sessionId) return existing.promise;

  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  const patch = (value: Partial<ExtremeAttachment>) => {
    // 只有最新一次上传、且附件仍在原对话里才写回。
    if (generation !== generations.get(key)) return { ...attachment, ...value };
    if (stillOwned(workspaceId, attachment.id)) {
      patchAttachment(workspaceId, attachment.id, (item) => ({ ...item, ...value }));
    }
    return { ...attachment, ...value };
  };
  patch({ uploadState: "uploading", remoteProgress: 0, remoteError: undefined });

  const promise = stageAttachment({ ...input, generation }, generation)
    .then((remotePath) => {
      // 上传期间附件被删：副本已经没有归属，顺手清掉，别在服务器上留垃圾。
      if (!stillOwned(workspaceId, attachment.id)) {
        void removeRemoteDir(sessionId, workspaceId, attachment.id);
        return { ...attachment, remotePath, uploadState: "uploaded" as const, staged: true };
      }
      return patch({
        remotePath,
        stagedPath: remotePath,
        uploadState: "uploaded",
        staged: true,
        stagedCleaned: false,
        remoteProgress: undefined,
        remoteError: undefined,
        remoteServerId: serverId,
      });
    })
    .catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (generation === generations.get(key)) {
        void removeRemoteDir(sessionId, workspaceId, attachment.id);
      }
      return patch({
        remotePath: undefined,
        uploadState: "local",
        staged: false,
        remoteProgress: undefined,
        remoteServerId: undefined,
        remoteError: reason,
      });
    })
    .finally(() => {
      // 只有自己这一代还在位时才移除：新一次上传已经替换了 map 项。
      if (pending.get(key)?.sessionId === sessionId && generation === generations.get(key)) {
        pending.delete(key);
      }
    });
  pending.set(key, { sessionId, promise });
  return promise;
}

/** 这份附件是否有在飞的上传（清空 / 删除 / 切任务前的统一判断）。 */
export function isAttachmentUploading(workspaceId: string, attachmentId: string): boolean {
  const prefix = `${workspaceId}\u0000`;
  const suffix = `\u0000${attachmentId}`;
  for (const key of pending.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) return true;
  }
  return false;
}

/** 这条对话里是否还有任何在飞的上传（清空对话前必须等它结束）。 */
export function hasActiveTransfers(workspaceId: string): boolean {
  const prefix = `${workspaceId}\u0000`;
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 发送前核对暂存副本**仍然有效**。
 *
 * 只查这一份（路径 + 字节数）：服务器上被手工删掉、临时目录被系统清理、
 * 同名包被覆盖都会在这里变成 `false`，发送方据此要求重新上传，而不是把
 * "我以为传过"的路径交给模型。
 */
export async function verifyStagedAttachment(
  sessionId: string,
  item: ExtremeAttachment,
): Promise<boolean> {
  const path = item.stagedPath ?? item.remotePath;
  if (!path) return false;
  try {
    const probe = await opsApi.sshExec(
      sessionId,
      `test -f ${quote(path)} && wc -c < ${quote(path)}`,
      15_000,
    );
    if (probe.exit_code !== 0) return false;
    const size = probe.stdout.trim();
    if (!/^\d+$/.test(size)) return false;
    const source = attachmentSource(item);
    // 本机已经拿不到原文（重启）：只能证明路径还在，不能证明是"这一份"。
    return source ? Number(size) === source.total : true;
  } catch {
    return false;
  }
}

/**
 * 删除平台创建的暂存副本。
 *
 * **只删** `.bls-ops/staging/<workspaceId>/<attachmentId>/…` 下、且
 * `remotePath` 与预期完全对得上的那一份：
 * - 线上文件、站点备份、用户引用的远程原文件都不在删除范围内；
 * - 失败时保留 `remotePath` 与错误，调用方可以重试。
 */
export async function removeStagedAttachment(input: {
  sessionId: string;
  workspaceId: string;
  serverId: string | null;
  item: ExtremeAttachment;
}): Promise<void> {
  const { sessionId, workspaceId, serverId, item } = input;
  // 只认 `stagedPath`：`remotePath` 部署后指向线上目标，删它就是删站点文件。
  const remotePath = item.stagedPath;
  if (!item.staged || !remotePath) {
    // 不是平台副本：绝不删。
    throw new Error(i18n.t("这份附件不是平台暂存副本，未删除"));
  }
  let relative: string;
  try {
    relative = `${stagingDir(workspaceId, item.id)}/${relativePath(item)}`;
  } catch {
    throw new Error(i18n.t("暂存路径不合法，未删除"));
  }
  if (!remotePath.endsWith(`/${relative}`)) {
    throw new Error(i18n.t("暂存路径与附件身份不匹配，未删除"));
  }
  const home = remotePath.slice(0, remotePath.length - relative.length - 1);
  if (!home.startsWith("/")) {
    throw new Error(i18n.t("暂存路径不合法，未删除"));
  }
  // 目录级删除：同名多文件（文件夹上传）一次清干净，且范围只在这份附件内。
  const dir = stagingDir(workspaceId, item.id);
  const result = await opsApi.sshExec(
    sessionId,
    `cd "$HOME" && test "$(pwd -P)" = ${quote(home)} && rm -rf -- ${quote(dir)}`,
    30_000,
  );
  if (result.exit_code !== 0) {
    throw new Error(result.stderr.trim() || i18n.t("清理暂存附件失败"));
  }
  useExtremeStore.getState().setAttachmentsIn(workspaceId, (items) =>
    items.map((entry) => {
      if (entry.id !== item.id || entry.stagedPath !== item.stagedPath) return entry;
      /*
       * 已部署的附件：线上目标仍然有效，只是暂存副本没了 —— 不能把
       * `uploadState` 改成 cleaned 让模型以为文件不在了。
       */
      if (entry.uploadState === "deployed" || entry.remotePath !== entry.stagedPath) {
        return {
          ...entry,
          staged: false,
          stagedPath: undefined,
          stagedCleaned: true,
          remoteProgress: undefined,
          remoteServerId: serverId,
          remoteError: undefined,
        };
      }
      return {
        ...entry,
        uploadState: "cleaned",
        stagedCleaned: true,
        remotePath: undefined,
        stagedPath: undefined,
        remoteProgress: undefined,
        staged: false,
        remoteServerId: serverId,
        remoteError: undefined,
      };
    }),
  );
  dropAttachmentFile(item.id);
}
