/**
 * 部署动作：上传附件、生成计划、执行计划。
 *
 * 三件事都只认**发起时的归属快照**（`ActionScope`）：等上传、等命令回来时
 * 界面可能已经切到另一条对话甚至另一台服务器，这里绝不读当前前台的连接。
 * 每一步执行前都核对归属，断了就停在原地并把原因写回原对话。
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { opsApi } from "@/api/ops-api";
import { toAppError } from "@/lib/app-error";
import {
  useExtremeStore,
  type ExtremeMessage,
  type TerminalPane,
  type WorkspacePane,
} from "@/stores/extreme-store";
import { notifyTaskOutcome } from "@/desktop-notification/task";
import { planValidFor, type ActionScope } from "../action-scope";
import { buildDeployPlan, verifyPassed, type DeployStep } from "../deploy-plan";
import { buildStaticUpdatePlan, verifyHttpStatus } from "../static-update-plan";
import {
  buildUpdatePlan,
  parseDockerPs,
  parseInspectMounts,
  pickDeployDirs,
  type ServiceCandidate,
} from "../update-plan";
import {
  createTaskContext,
  selectPlanKind,
  withPlan,
  type PlanFacts,
  type PlanKind,
  type TaskContext,
} from "../task-context";
import { cardFromPlan, riskOfSteps, statusOf } from "../task-view";
import {
  planReport,
  requestedUploadReport,
  uploadReceipt,
  uploadReport,
} from "../execution-report";
import { detectStaticSite, shellQuote, type TFn } from "./helpers";
import type { ActionResult } from "./types";

type Store = ReturnType<typeof useExtremeStore.getState>;

/**
 * 回读一份文本（变更审阅用）：二进制 / 太大 / 无权限一律返回 `null`。
 *
 * 用 try/catch 而不是 `.catch()`：调用本身也可能同步失败（旧版本 IPC 没这个方法），
 * 审阅信息不能反过来让部署失败。
 */
async function readTextOrNull(sessionId: string, path: string): Promise<string | null> {
  try {
    const file = await opsApi.sftpReadFile(sessionId, path);
    return file.binary ? null : file.content;
  } catch {
    return null;
  }
}

export interface DeployDeps {
  t: TFn;
  /** 按钮入口的归属快照（"此刻界面上这条对话"）。 */
  currentScope: () => ActionScope;
  scopeBlocked: (scope: ActionScope) => string | null;
  scopeIsForeground: (scope: ActionScope) => boolean;
  pauseAction: (scope: ActionScope, reason: string) => void;
  pushMessageTo: Store["pushMessageTo"];
  pushUserMessageTo: (workspaceId: string, text: string) => ExtremeMessage;
  setNotice: Store["setNotice"];
  setPlan: Store["setPlan"];
  setPlanSession: Store["setPlanSession"];
  updatePlan: Store["updatePlan"];
  patchMessageIn: Store["patchMessageIn"];
  patchWorkspaceContext: Store["patchWorkspaceContext"];
  mergeFileChange: Store["mergeFileChange"];
  setAttachmentsIn: Store["setAttachmentsIn"];
  setExecutingFor: Store["setExecutingFor"];
  upsertTask: Store["upsertTask"];
  upsertReport: Store["upsertReport"];
  openPaneTab: (tab: WorkspacePane, terminal?: TerminalPane) => void;
  planTaskIdRef: MutableRefObject<string | null>;
  stopTasksRef: MutableRefObject<Set<string>>;
  userConfirmedPlansRef: MutableRefObject<Set<string>>;
  remoteRoot: string | null;
  setRemoteRoot: Dispatch<SetStateAction<string | null>>;
  sessionId: string | null;
  uploading: boolean;
  setUploading: Dispatch<SetStateAction<boolean>>;
  probing: boolean;
  setProbing: Dispatch<SetStateAction<boolean>>;
  setCandidates: Dispatch<SetStateAction<ServiceCandidate[] | null>>;
}

export function useDeployActions(deps: DeployDeps) {
  const {
    t,
    currentScope,
    scopeBlocked,
    scopeIsForeground,
    pauseAction,
    pushMessageTo,
    pushUserMessageTo,
    setNotice,
    setPlan,
    setPlanSession,
    updatePlan,
    patchMessageIn,
    patchWorkspaceContext,
    mergeFileChange,
    setAttachmentsIn,
    setExecutingFor,
    upsertTask,
    upsertReport,
    openPaneTab,
    planTaskIdRef,
    stopTasksRef,
    userConfirmedPlansRef,
    remoteRoot,
    setRemoteRoot,
    sessionId,
    uploading,
    setUploading,
    probing,
    setProbing,
    setCandidates,
  } = deps;

  const commitPlan = useCallback(
    (
      scope: ActionScope,
      context: TaskContext,
      planKind: PlanKind | null,
      built: { steps: DeployStep[]; result: string },
    ) => {
      const ready = built.steps.length > 0;
      const planned: TaskContext = ready
        ? planKind
          ? withPlan(context, planKind)
          : { ...context, phase: "confirming" }
        : { ...context, phase: "waiting" };
      const ownerMessages =
        useExtremeStore.getState().workspaces.find((entry) => entry.id === scope.workspaceId)
          ?.messages ?? [];
      const goal =
        ownerMessages.find((message) => message.id === planned.originMessageId)?.text ??
        planned.verifiedTarget?.root ??
        t("按附件生成部署计划");
      upsertTask(
        cardFromPlan({
          id: planned.taskId,
          plan: built.steps,
          server: planned.server,
          sessionId: planned.sessionId,
          // 归属：计划属于发起它的那条对话，切走也不会挂到别人身上。
          workspaceId: scope.workspaceId,
          serverId: scope.serverId,
          originMessageId: planned.originMessageId,
          goal,
          status: ready ? "confirming" : "waiting",
          result: built.result,
        }),
      );
      // 与卡片写入同处：任务只挂在发起它的那条消息下面。
      patchMessageIn(scope.workspaceId, planned.originMessageId, { taskId: planned.taskId });
      // 生成计划也是"平台替用户做的一步"：同样留一行执行结果（不另发气泡）。
      upsertReport(planned.taskId, planReport(t, { result: built.result, ready }));
      // 新计划（或重算过的计划）一律视为"未确认"：上一次的同意不能顺延。
      userConfirmedPlansRef.current.delete(planned.taskId);
      // 快照跟着更新：同一轮里的 `[[start]]` 要用这版计划。
      scope.plan = ready ? built.steps : null;
      scope.planSession = ready ? planned.sessionId : null;
      scope.planTaskId = planned.taskId;
      if (scopeIsForeground(scope)) {
        planTaskIdRef.current = planned.taskId;
        useExtremeStore.setState({ planTaskId: planned.taskId });
        setPlan(ready ? built.steps : null);
        setPlanSession(ready ? planned.sessionId : null);
        if (ready) {
          // 计划就是右栏「计划」标签的内容：生成后直接展开给人看。
          openPaneTab("plan");
        }
      } else {
        // 后台生成：写回它自己那条，切回来就能看到这版计划。
        patchWorkspaceContext(scope.workspaceId, {
          plan: ready ? built.steps : null,
          planSession: ready ? planned.sessionId : null,
          planTaskId: planned.taskId,
        });
      }
      if (ready) {
        pushMessageTo(scope.workspaceId, {
          id: `msg-${crypto.randomUUID()}`,
          role: "assistant",
          local: true,
          text: [
            t("已生成 {{n}} 个步骤，确认前不会改动服务器。", { n: built.steps.length }),
            planned.verifiedTarget?.root ? `${t("目标目录")} · \`${planned.verifiedTarget.root}\`` : "",
          ].filter(Boolean).join("\n\n"),
        });
      }
    },
    [
      openPaneTab,
      patchMessageIn,
      patchWorkspaceContext,
      pushMessageTo,
      scopeIsForeground,
      setPlan,
      setPlanSession,
      t,
      upsertReport,
      upsertTask,
    ],
  );

  /**
   * 依**实测事实**生成计划。
   *
   * 先只读确认「服务器上是不是静态站点、ZIP 在不在」，再由 `selectPlanKind`
   * 决定用哪一套计划；事实不足时返回 `null`，卡片显示「等待补充信息 / 重新
   * 检查」，而不是硬编一套 Compose 步骤。
   */
  const generatePlan = useCallback(
    async (scope: ActionScope, input: { originMessageId: string; taskId?: string }) => {
      const blocked = scopeBlocked(scope);
      if (blocked) {
        pauseAction(scope, blocked);
        return;
      }
      /*
       * 同一个任务再来一次（「开始吧」/ 卡片上的「重新检查」）时沿用**原来那条**
       * 消息：卡片的归属不变，不会在两句消息下面各渲染一次。
       */
      const existing = input.taskId
        ? useExtremeStore.getState().tasks[input.taskId]
        : undefined;
      const context = createTaskContext({
        taskId: input.taskId ?? `task-${Date.now()}`,
        originMessageId: existing?.originMessageId ?? input.originMessageId,
        server: scope.server || t("未绑定服务器"),
        sessionId: scope.sessionId,
        attachmentIds: scope.attachments.map((item) => item.id),
      });
      const zip = scope.attachments.find(
        (item) =>
          /\.zip$/i.test(item.name) &&
          Boolean(item.remotePath) &&
          (item.uploadState === "uploaded" || item.uploadState === "deployed"),
      );
      // 没有 ZIP 在服务器上时这个探测帮不上忙：不必为一次点击去打扰服务器。
      const staticTarget = zip?.remotePath ? await detectStaticSite(scope.sessionId) : null;
      // 探测期间归属失效（换服务器 / 断连）：这版计划不能落到别处。
      const blockedAfterProbe = scopeBlocked(scope);
      if (blockedAfterProbe) {
        pauseAction(scope, blockedAfterProbe);
        return;
      }
      const facts: PlanFacts = {
        staticSiteOnServer: staticTarget !== null,
        distZipOnServer: Boolean(zip?.remotePath),
        // 「服务器上已有 Compose 项目」只由「更新现有服务」入口确认（那里选定了服务）。
        composeProjectOnServer: false,
        composeInAttachments: scope.attachments.some((item) =>
          /(^|\/)(docker-)?compose\.ya?ml$/i.test(item.path ?? item.name),
        ),
      };
      const kind = selectPlanKind(facts);

      if (kind === "static-update" && staticTarget?.root && zip?.remotePath) {
        // 已定位到 Nginx 静态站点：替换文件即可，**不重启共享 Nginx**。
        commitPlan(scope, { ...context, verifiedTarget: staticTarget }, "static-update", {
          steps: buildStaticUpdatePlan({ root: staticTarget.root, zipPath: zip.remotePath }),
          result: t("静态站点更新：{{root}}（不重启共享 Nginx）", { root: staticTarget.root }),
        });
        return;
      }

      if (kind === "compose-create") {
        const built = buildDeployPlan(scope.attachments);
        commitPlan(scope, context, "compose-create", {
          steps: built.plan,
          result: built.blocked ?? t("等待确认后执行"),
        });
        return;
      }

      const reason = !zip ? t("服务器上还没有 ZIP") : t("没有在服务器上定位到静态站点");
      commitPlan(scope, context, null, {
        steps: [],
        result: t("等待补充信息：{{reason}}", { reason }),
      });
    },
    [commitPlan, pauseAction, scopeBlocked, t],
  );

  const resolveRemotePath = (path: string, home: string | null): string | null => {
    if (!path.startsWith("~/")) return path;
    return home ? `${home}/${path.slice(2)}` : null;
  };

  /**
   * 计划里的写文件登记成「文件变更」。
   *
   * 部署是最常改服务器文件的路径，以前这里完全不产记录，面板在部署流程里
   * 永远是"暂无变更"。`before` / `after` 由调用方在读写时拿到，后端复用
   * Agent 那一套 Diff 与脱敏。
   */
  const recordPlanChange = useCallback(
    async (
      scope: ActionScope,
      target: string,
      before: string | null,
      after: string | null,
      status: string,
      note: string | null,
      ownerTaskId?: string,
    ) => {
      // 后台计划也要归到**它自己**那次运行：不能借用前台正在跑的那条。
      const taskId = ownerTaskId ?? planTaskIdRef.current;
      if (!taskId) return;
      try {
        const summary = await opsApi.aiAgentFileChangeRecord({
          taskId,
          workspaceId: scope.workspaceId,
          server: scope.server,
          serverId: scope.serverId ?? null,
          tool: "plan_upload",
          path: target,
          before,
          after,
          status,
          note,
        });
        mergeFileChange(summary);
      } catch {
        // 审阅信息不能反过来让部署失败：记录失败就当作没有这一条。
      }
    },
    [mergeFileChange, planTaskIdRef],
  );

  const runStep = useCallback(
    async (
      scope: ActionScope,
      step: DeployStep,
      ownerTaskId?: string,
    ): Promise<{ ok: boolean; detail: string; stdout: string; stderr: string; exitCode: number | null }> => {
      if (!scope.sessionId) {
        return { ok: false, detail: t("会话已断开"), stdout: "", stderr: "", exitCode: null };
      }
      if (step.kind === "upload") {
        const target = step.remotePath ? resolveRemotePath(step.remotePath, scope.home) : null;
        if (!target) {
          return {
            ok: false,
            detail: t("拿不到家目录，无法写入文件"),
            stdout: "",
            stderr: "",
            exitCode: null,
          };
        }
        /*
         * **内容来源有三种，不能只看 `text`**。
         *
         * 之前这里是 `!step.text` —— 二进制上传（只有 `data`）、服务器内部
         * 复制（只有 `sourcePath`）、以及合法的**空文本文件**都会被拦下来，
         * 而且报的还是"拿不到家目录"，用户完全看不出真实原因。
         */
        const hasPayload =
          typeof step.data === "string" ||
          typeof step.sourcePath === "string" ||
          typeof step.text === "string";
        if (!hasPayload) {
          return {
            ok: false,
            detail: t("这一步没有可写入的内容（text / data / sourcePath 都为空）"),
            stdout: "",
            stderr: "",
            exitCode: null,
          };
        }
        const dir = target.slice(0, target.lastIndexOf("/"));
        const mkdir = await opsApi.sshExec(scope.sessionId, `mkdir -p '${dir.replace(/'/g, `'\\''`)}'`, 15_000);
        if (mkdir.exit_code !== 0) {
          return {
            ok: false,
            detail: mkdir.stderr || t("创建目录失败"),
            stdout: mkdir.stdout,
            stderr: mkdir.stderr,
            exitCode: mkdir.exit_code,
          };
        }
        /*
         * **覆盖前先备份**：目标文件已存在就复制一份带时间戳的副本。
         *
         * 直接覆盖是"不可见的删除"——用户只看到"已写入"，原来的内容已经没了。
         * 备份失败时**不覆盖**，宁可这一步失败也不静默丢文件。
         * 本任务自己上传的临时目录（`remoteRoot`）不在此列：它是我们自己建的。
         */
        const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
        const exists = await opsApi.sshExec(
          scope.sessionId,
          `test -e ${quote(target)} && echo yes || echo no`,
          10_000,
        );
        const targetExisted = exists.stdout.trim() === "yes";
        if (targetExisted) {
          const backup = `${target}.bak-${Date.now()}`;
          const copy = await opsApi.sshExec(
            scope.sessionId,
            `cp -a ${quote(target)} ${quote(backup)}`,
            30_000,
          );
          if (copy.exit_code !== 0) {
            return {
              ok: false,
              detail: t("备份失败，已取消覆盖：{{detail}}", {
                detail: copy.stderr.trim() || backup,
              }),
              stdout: copy.stdout,
              stderr: copy.stderr,
              exitCode: copy.exit_code,
            };
          }
        }
        /*
         * 变更审阅的"修改前"：新文件按空串算（全新增），读不到（二进制 /
         * 权限 / 超过编辑器上限）就交 null —— 面板会如实标"未采集"。
         */
        const beforeText = targetExisted
          ? await readTextOrNull(scope.sessionId, target)
          : "";
        /*
         * **服务器上已有副本就直接 `/bin/cp`**。
         *
         * 附件先上传过临时目录时，`sourcePath` 指向那份文件：服务器内部复制
         * 是磁盘到磁盘，几十兆的目录也是秒级；再走一次 base64 上传等于把
         * 同样的字节从本机重发一遍。
         */
        /*
         * 远端源**先核验再复制**：临时目录可能已经被清掉（退出Work、用户手动
         * 删除），直接 `cp` 会得到一句 `No such file`，用户不知道该怎么办。
         * 这里探测一次，不在就回退本地内容重写。
         */
        let copied = false;
        if (step.sourcePath) {
          const probe = await opsApi.sshExec(
            scope.sessionId,
            `test -e ${quote(step.sourcePath)} && echo yes || echo no`,
            8_000,
          );
          if (probe.stdout.trim() === "yes") {
            const copy = await opsApi.sshExec(
              scope.sessionId,
              `cp -a ${quote(step.sourcePath)} ${quote(target)}`,
              60_000,
            );
            if (copy.exit_code !== 0) {
              await recordPlanChange(
                scope,
                target,
                beforeText,
                null,
                "write_failed",
                copy.stderr.trim() || t("从临时目录复制失败"),
                ownerTaskId,
              );
              return {
                ok: false,
                detail: copy.stderr.trim() || t("从临时目录复制失败"),
                stdout: copy.stdout,
                stderr: copy.stderr,
                exitCode: copy.exit_code,
              };
            }
            copied = true;
          }
        }

        try {
          if (!copied) {
            if (step.data) {
              // 二进制（图片/字体/jar/归档）走 base64 通道。
              await opsApi.sftpWriteBytes(scope.sessionId, target, step.data);
            } else if (typeof step.text === "string") {
              await opsApi.sftpWriteFile(scope.sessionId, target, step.text);
            } else {
              return {
                ok: false,
                detail: t("临时目录里没有这个文件，本地也没有可写入的内容"),
                stdout: "",
                stderr: "",
                exitCode: null,
              };
            }
          }
        } catch (cause) {
          // 写入失败也留一条：目标可能被截断，用户要能看到"这次没写成功"。
          await recordPlanChange(
            scope,
            target,
            beforeText,
            null,
            "write_failed",
            toAppError(cause).message,
            ownerTaskId,
          );
          throw cause;
        }
        /*
         * 变更审阅的"修改后"：文本写的就是这次提交的内容；从临时目录拷来的
         * 回读一次。二进制没有正文可比，标成"未采集"。
         */
        let afterText: string | null =
          !copied && typeof step.text === "string" ? step.text : null;
        if (afterText === null && !step.data) {
          afterText = await readTextOrNull(scope.sessionId, target);
        }
        await recordPlanChange(
          scope,
          target,
          beforeText,
          afterText,
          "written",
          afterText === null ? t("二进制文件：只记录路径，不做逐行比较") : null,
          ownerTaskId,
        );
        /*
         * 上传成功才回填服务器路径：附件 chip 会显示 ✓，后续对话也能准确说
         * "这个文件已经在服务器上"，而不是一直标着"仅本机附件"。
         */
        // 回写**发起这条计划的那条对话**，不写当前镜像（可能已经切走）。
        setAttachmentsIn(scope.workspaceId, (current) =>
          current.map((entry) =>
            target.endsWith(`/${entry.path ?? entry.name}`)
              ? {
                  ...entry,
                  remotePath: target,
                  remoteError: undefined,
                  // 已经复制到目标目录：状态推到"已部署"，界面能看出这一步走完了。
                  uploadState: "deployed",
                }
              : entry,
          ),
        );
        return {
          ok: true,
          detail: t("已写入 {{path}}", { path: target }),
          stdout: t("已写入 {{path}}", { path: target }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (!step.command) {
        return { ok: false, detail: t("步骤缺少命令"), stdout: "", stderr: "", exitCode: null };
      }
      const result = await opsApi.sshExec(scope.sessionId, step.command, 120_000);
      if (step.kind === "verify") {
        /*
         * 静态站点计划用 HTTP 码验证（`curl -w '%{http_code}'`），Compose 计划
         * 读容器状态：两套输出不能共用同一个判定，否则 200 会被当成"没在跑"。
         */
        const verdict = step.id.startsWith("static-")
          ? verifyHttpStatus(result.stdout)
          : verifyPassed(result.stdout);
        return {
          ok: verdict.ok,
          detail: verdict.reason,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exit_code,
        };
      }
      return {
        ok: result.exit_code === 0,
        detail: result.truncated
          ? t("输出被截断，只保留前 8 MiB")
          : result.stderr.trim() || result.stdout.trim() || t("无输出"),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exit_code,
      };
    },
    [setAttachmentsIn, t],
  );

  /**
   * 执行计划。
   *
   * 进度、卡片与历史都绑在**发起时的会话**上：中途切到别的服务器，步骤结果
   * 仍写回这张卡与历史，但不会再改另一台上的计划、通知与执行标记。
   */
  const runPlan = async (targetId?: string, scopeIn?: ActionScope) => {
    /** 归属与数据全部来自快照（`[[start]]` 接力时可能已经在后台）。 */
    const scope = scopeIn ?? currentScope();
    const planAtStart = scope.plan;
    const sessionAtStart = scope.sessionId;
    const serverAtStart = scope.server;
    const workspaceAtStart = scope.workspaceId;
    const serverIdAtStart = scope.serverId;
    const foreground = () => scopeIsForeground(scope);
    const notify = (message: string) => {
      if (foreground()) setNotice(message);
      else pushMessageTo(workspaceAtStart, {
        id: `msg-${crypto.randomUUID()}`,
        role: "assistant",
        local: true,
        text: message,
      });
    };
    /**
     * 这条**对话**的部署是否已经在跑。
     *
     * `executing` 是前台镜像：后台对话的计划不能因为另一台正在跑就被拒绝，
     * 也不能因为前台空闲就重复执行。
     */
    const planRunning = () => {
      const state = useExtremeStore.getState();
      if (state.workspaceId === scope.workspaceId) return state.executing;
      return Boolean(
        state.workspaces.find((entry) => entry.id === scope.workspaceId)?.context?.executing,
      );
    };
    if (!planAtStart || !sessionAtStart || planRunning()) return;
    /*
     * **执行必须先有用户的明确表态**。
     *
     * 会话与任务 ID 只回答"发给哪台、哪一版"，回答不了"用户同意了没有"：
     * 模型输出 `[[start]]` 时如果把这里放过去，等于它自己按了执行键。
     */
    const approved = targetId ? userConfirmedPlansRef.current.has(targetId) : false;
    if (!approved) {
      notify(t("这一步还没得到你的确认：回复「开始吧」我再执行。"));
      return;
    }
    /*
     * 执行前重新核对归属：连接断了 / 换了服务器就停下来，把原因写回原对话。
     * 绝不拿当前前台的连接把这条计划发出去。
     */
    const blocked = scopeBlocked(scope);
    if (blocked) {
      pauseAction(scope, blocked);
      return;
    }
    // 计划与连接必须仍是同一版：重新生成 / 重连之后旧计划失效。
    if (!planValidFor(scope) || scope.planSession !== sessionAtStart) {
      notify(t("会话已变化，计划已失效。请重新生成计划。"));
      return;
    }
    if (!scope.home && planAtStart.some((step) => step.remotePath?.startsWith("~/"))) {
      notify(t("还没有取到家目录，先等待预检完成。"));
      return;
    }
    if (targetId && scope.planTaskId && scope.planTaskId !== targetId) {
      notify(t("这条任务属于上一次计划，请重新生成计划后再执行。"));
      return;
    }
    const taskId = targetId ?? scope.planTaskId ?? `task-${Date.now()}`;
    scope.planTaskId = taskId;
    if (foreground()) {
      planTaskIdRef.current = taskId;
      useExtremeStore.setState({ planTaskId: taskId });
    } else {
      patchWorkspaceContext(workspaceAtStart, { planTaskId: taskId });
    }
    const originMessageId = useExtremeStore.getState().tasks[taskId]?.originMessageId;
    /** 本地步骤副本：切服务器后 store 里的 `plan` 已经是另一台的计划了。 */
    const steps: DeployStep[] = planAtStart.map((step) => ({ ...step }));
    const syncProgress = () => {
      const progress = steps.map((step) => ({ ...step }));
      if (foreground()) {
        updatePlan(() => progress.map((step) => ({ ...step })));
      } else {
        // 后台推进也要写回它自己那条：切回来能接着看。
        patchWorkspaceContext(workspaceAtStart, { plan: progress });
      }
      /*
       * 任务卡按 taskId 更新（全局安全）：切到别的对话后，左栏与历史仍能看到
       * 这条部署在推进，不必等切回来才刷新。
       */
      const card = useExtremeStore.getState().tasks[taskId];
      if (card) {
        upsertTask({ ...card, steps: progress, updatedAt: Date.now() });
      }
    };

    if (workspaceAtStart) setExecutingFor(workspaceAtStart, true);
    if (foreground()) {
      // 执行期间用户要看的就是滚动输出：直接展开右栏的「终端 › 执行输出」。
      openPaneTab("terminal", "output");
      setNotice(null);
    }
    // 同一个 taskId 重新执行：清掉上一轮留下的停止标记，只影响这一条任务。
    stopTasksRef.current.delete(taskId);
    /** 删掉服务器上的临时目录（完成 / 取消 / 中止时都调）。 */
    const dropRemote = () => {
      const root = scope.remoteRoot;
      if (!root) return;
      scope.remoteRoot = null;
      if (foreground()) setRemoteRoot(null);
      void opsApi.sshExec(sessionAtStart, `rm -rf -- ${shellQuote(root)}`, 30_000).catch(() => undefined);
    };
    /**
     * 落一条任务历史到本地库，并同步刷新卡片。
     *
     * 只存任务，不存对话。写失败不影响部署结果（`.catch` 吞掉），历史是
     * 附加信息，不该因为它把一次成功的部署显示成失败。
     */
    const persistTask = (status: string, summary: string) => {
      const snapshot = steps.map((step) => ({ ...step }));
      // 类型固定为部署；用户目标与风险按本次任务单独记，历史里不靠步骤反推分类。
      const goal = useExtremeStore.getState().tasks[taskId]?.goal ?? "";
      const card = cardFromPlan({
        id: taskId,
        plan: snapshot,
        server: serverAtStart ?? "unknown",
        sessionId: sessionAtStart,
        workspaceId: workspaceAtStart,
        serverId: serverIdAtStart,
        originMessageId,
        goal,
        status: statusOf(status),
        result: summary,
      });
      upsertTask(card);
      // 部署循环的终态也是实时结果；窗口收起时才提醒一次。
      if (status === "success" || status === "failed") void notifyTaskOutcome(card);
      void opsApi
        .extremeTaskSave({
          id: taskId,
          kind: "deploy",
          server: serverAtStart ?? "unknown",
          sessionId: sessionAtStart,
          workspaceId: workspaceAtStart,
          serverId: serverIdAtStart,
          status,
          goal,
          risk: riskOfSteps(snapshot),
          summary,
          planJson: JSON.stringify(snapshot),
          createdAt: Date.now(),
        })
        .catch(() => undefined);
    };
    /*
     * **先落一条"执行中"**：收起面板 / 切服务器 / 重开应用时，历史里能立刻
     * 找回这条任务；结束时同一 id 覆盖成 success / failed / cancelled。
     */
    persistTask("running", t("执行中…"));

    for (let index = 0; index < steps.length; index += 1) {
      // 用户点了「取消任务」：停在当前进度，清掉临时文件，历史里记为中止。
      if (stopTasksRef.current.has(taskId)) {
        stopTasksRef.current.delete(taskId);
        if (workspaceAtStart) setExecutingFor(workspaceAtStart, false);
        dropRemote();
        persistTask("cancelled", t("任务已中止"));
        notify(t("任务已中止：服务器上的临时文件已清理。"));
        return;
      }
      /*
       * **每一步执行前核对归属**：原连接断了 / 换了服务器就停在这一步。
       * 后面的步骤不能借用当前前台的连接继续跑。
       */
      const blockedStep = scopeBlocked(scope);
      if (blockedStep) {
        steps[index] = { ...steps[index], state: "failed", stderr: blockedStep, exitCode: null };
        syncProgress();
        persistTask("failed", blockedStep);
        if (workspaceAtStart) setExecutingFor(workspaceAtStart, false);
        pauseAction(scope, blockedStep);
        stopTasksRef.current.delete(taskId);
        return;
      }
      const step = steps[index];
      if (step.state === "success") continue;
      steps[index] = { ...step, state: "running" };
      syncProgress();
      try {
        const outcome = await runStep(scope, step, taskId);
        steps[index] = {
          ...step,
          state: outcome.ok ? "success" : "failed",
          stdout: outcome.stdout,
          stderr: outcome.stderr || (outcome.ok ? "" : outcome.detail),
          exitCode: outcome.exitCode,
        };
        syncProgress();
        if (!outcome.ok) {
          // 失败也落历史：用户下次回来能看到卡在第几步、真实报错是什么。
          persistTask("failed", t("第 {{n}} 步失败：{{detail}}", { n: index + 1, detail: outcome.detail }));
          notify(t("第 {{n}} 步失败：{{detail}}", { n: index + 1, detail: outcome.detail }));
          if (workspaceAtStart) setExecutingFor(workspaceAtStart, false);
          stopTasksRef.current.delete(taskId);
          return;
        }
        // 关键节点落库：每步成功都覆盖同一条记录，历史面板据此实时推进。
        persistTask("running", t("已完成 {{n}}/{{total}} 步", { n: index + 1, total: steps.length }));
      } catch (cause) {
        steps[index] = {
          ...step,
          state: "failed",
          stderr: cause instanceof Error ? cause.message : String(cause),
          exitCode: null,
        };
        syncProgress();
        const reason = cause instanceof Error ? cause.message : t("执行失败");
        persistTask("failed", reason);
        notify(reason);
        if (workspaceAtStart) setExecutingFor(workspaceAtStart, false);
        stopTasksRef.current.delete(taskId);
        return;
      }
    }
    if (workspaceAtStart) setExecutingFor(workspaceAtStart, false);
    stopTasksRef.current.delete(taskId);
    // 部署成功 = 文件已经就位，临时副本没有继续存在的理由。
    dropRemote();
    notify(t("部署完成：全部步骤通过。"));
    persistTask("success", t("全部步骤通过"));
  };


  const cleanupRemote = useCallback(() => {
    const root = remoteRoot;
    if (!sessionId || !root) return;
    setRemoteRoot(null);
    void opsApi.sshExec(sessionId, `rm -rf -- ${shellQuote(root)}`, 30_000).catch(() => undefined);
  }, [remoteRoot, sessionId]);

  /**
   * 把附件按**原目录结构**写到服务器临时目录。
   *
   * 为什么需要这一步：模型只拿得到文本内容，二进制（图片、字体、jar）永远
   * 读不到；一个几百文件的站点也没法把全文都塞进上下文。落到服务器上之后，
   * 平台可以按路径 `head` 任意文件，部署时也能直接就地复制。
   */
  const uploadToServer = useCallback(async (scope: ActionScope, taskId?: string): Promise<ActionResult> => {
    /*
     * **先核对归属**：原对话没了 / 连接断了 / 重连换了会话，就停在这里。
     * 绝不拿当前前台对话的连接顶替 —— 那会把 A 的文件传到 B 的机器上。
     */
    const blocked = scopeBlocked(scope);
    if (blocked) {
      pauseAction(scope, blocked);
      return { receipt: t("这一步已暂停：{{reason}}", { reason: blocked }), paused: true };
    }
    if (uploading) return { receipt: "" };
    // 服务器上的文件（右键添加）本来就在服务器上，不参与"上传到临时目录"。
    const ready = scope.attachments.filter(
      (item) => item.state === "ready" && item.uploadState !== "uploaded",
    );
    if (ready.length === 0) {
      if (scopeIsForeground(scope)) setNotice(t("没有可上传的附件。"));
      return { receipt: t("没有需要上传的附件：已经在服务器上了。") };
    }
    setUploading(true);
    if (scopeIsForeground(scope)) setNotice(null);
    /**
     * 上传属于**发起时那条对话**：结果写回它自己，右栏也只在它在前台时动。
     */
    const workspaceAtStart = scope.workspaceId;
    const stillHere = () => scopeIsForeground(scope);
    const root = `${scope.home ?? "/tmp"}/.bls-ops/extreme-${workspaceAtStart || scope.sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    // 先占一行「已请求」：文件多、网慢时用户能立刻看到这一步在做什么。
    if (taskId) upsertReport(taskId, requestedUploadReport(t, { count: ready.length, root }));
    try {
      const mk = await opsApi.sshExec(scope.sessionId, `mkdir -p ${quote(root)}`, 20_000);
      if (mk.exit_code !== 0) throw new Error(mk.stderr || t("创建临时目录失败"));
      let written = 0;
      let reused = 0;
      const failures: string[] = [];
      for (const item of ready) {
        const relative = item.path ?? item.name;
        const target = `${root}/${relative}`;

        /*
         * **已经传过就核验复用**，不重传。
         *
         * 几十兆的目录重传一次很慢；但"我这边记着已上传"不等于服务器上还在
         * —— 用户可能手删了、或上次退出时临时目录被清掉。所以先 `test -e`
         * 确认，还在就跳过，不在就重新写。
         */
        if (item.uploadState === "uploaded" && item.remotePath) {
          const probe = await opsApi.sshExec(
            scope.sessionId,
            `test -e ${quote(item.remotePath)} && echo yes || echo no`,
            8_000,
          );
          if (probe.stdout.trim() === "yes") {
            reused += 1;
            continue;
          }
        }

        // 写回**原对话**的附件：切到 B 时镜像已经是 B 的，直接写会串。
        setAttachmentsIn(workspaceAtStart, (current) =>
          current.map((entry) =>
            entry.id === item.id
              ? { ...entry, uploadState: "uploading", remoteError: undefined }
              : entry,
          ),
        );
        try {
          const dir = target.slice(0, target.lastIndexOf("/"));
          // 子目录按需创建：`dist/static/css/…` 这种层级要一级级补。
          const mkdir = await opsApi.sshExec(scope.sessionId, `mkdir -p ${quote(dir)}`, 15_000);
          if (mkdir.exit_code !== 0) throw new Error(mkdir.stderr.trim() || t("创建目录失败"));
          if (item.binary && item.data) {
            await opsApi.sftpWriteBytes(scope.sessionId, target, item.data);
          } else if (typeof item.text === "string") {
            await opsApi.sftpWriteFile(scope.sessionId, target, item.text);
          } else {
            throw new Error(t("没有可写入的内容"));
          }
          written += 1;
          setAttachmentsIn(workspaceAtStart, (current) =>
            current.map((entry) =>
              entry.id === item.id
                ? { ...entry, remotePath: target, uploadState: "uploaded", remoteError: undefined }
                : entry,
            ),
          );
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          // 具体到"哪个文件、为什么"——只报一句"上传失败"等于没信息。
          failures.push(`${relative}：${reason}`);
          setAttachmentsIn(workspaceAtStart, (current) =>
            current.map((entry) =>
              entry.id === item.id
                ? { ...entry, uploadState: "local", remoteError: reason }
                : entry,
            ),
          );
        }
      }
      // 临时目录跟着快照走：同一轮里的「执行计划」要用它清理旧副本。
      scope.remoteRoot = root;
      if (stillHere()) {
        setRemoteRoot(root);
        // 传完要让用户看到服务器上那份：右侧文件标签直接展开到临时目录。
        openPaneTab("files");
      }
      /*
       * 用户看到的是**一行「执行结果」**（挂在发起上传的那条任务下面），
       * 不是一条 assistant 气泡；模型拿到的是同一份事实的文字回执。
       */
      if (taskId) {
        upsertReport(taskId, uploadReport(t, { written, reused, failures, root }));
      }
      const receipt = uploadReceipt(t, { written, reused, failures, root });
      if (!taskId) {
        // 没有归属任务（首屏直接点上传）：只能落在**原来那条**对话里。
        pushMessageTo(workspaceAtStart, {
          id: `msg-${crypto.randomUUID()}`,
          role: "assistant" as const,
          local: true,
          text: receipt,
        });
      }
      return { receipt };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : t("上传失败");
      // 失败原因写进那一行结果（步骤自己说清楚），不再另发通知条。
      if (taskId) {
        upsertReport(taskId, {
          id: "upload",
          status: "failed",
          title: t("上传失败：{{reason}}", { reason }),
        });
      } else if (stillHere()) {
        setNotice(reason);
      }
      return { receipt: t("上传失败：{{reason}}", { reason }) };
    } finally {
      setUploading(false);
    }
  }, [
    openPaneTab,
    pauseAction,
    pushMessageTo,
    scopeBlocked,
    scopeIsForeground,
    setAttachmentsIn,
    setNotice,
    t,
    uploading,
    upsertReport,
  ]);

  /**
   * 只读探测：列出这台机器上在跑的容器，并补齐挂载信息。
   *
   * 只用 `docker ps` 与 `docker inspect`，不写任何东西。探测失败（没装 Docker、
   * 没权限）直接把真实 stderr 抛给用户，不要笼统地说"探测失败"。
   */
  const probeServices = useCallback(async (scope: ActionScope): Promise<ServiceCandidate[]> => {
    const blocked = scopeBlocked(scope);
    if (blocked) {
      pauseAction(scope, blocked);
      return [];
    }
    if (probing) return [];
    if (scopeIsForeground(scope)) setProbing(true);
    if (scopeIsForeground(scope)) setNotice(null);
    try {
      const ps = await opsApi.sshExec(
        scope.sessionId,
        `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'`,
        20_000,
      );
      if (ps.exit_code !== 0) throw new Error(ps.stderr.trim() || t("docker ps 失败"));
      const services = parseDockerPs(ps.stdout);
      if (services.length === 0) {
        if (scopeIsForeground(scope)) setNotice(t("这台机器上没有正在运行的容器。"));
        return [];
      }
      // 逐个补挂载：替换哪个目录取决于容器的 bind mount，不能靠猜。
      for (const service of services) {
        const inspect = await opsApi.sshExec(
          scope.sessionId,
          `docker inspect --format '{{json .Mounts}}' '${service.name.replace(/'/g, `'\\''`)}'`,
          20_000,
        );
        if (inspect.exit_code === 0) service.mounts = parseInspectMounts(inspect.stdout);
      }
      scope.candidates = services;
      if (scopeIsForeground(scope)) setCandidates(services);
      // 返回结果：聊天里的 `[[plan]]` 要立刻拿到候选，不能等下一次渲染的 state。
      return services;
    } catch (cause) {
      if (scopeIsForeground(scope)) {
        setNotice(cause instanceof Error ? cause.message : t("探测失败"));
      }
      return [];
    } finally {
      if (scopeIsForeground(scope)) setProbing(false);
    }
  }, [pauseAction, probing, scopeBlocked, scopeIsForeground, setNotice, t]);

  /**
   * 选定服务 → 生成**更新计划**（校验 → 备份 → 解压 → 替换 → 重启 → 验证 → 清理）。
   *
   * 事实由这一步本身提供：`docker ps` + `docker inspect` 已经证明服务器上有这个
   * 容器、以及它真正在读哪个目录。缺 ZIP 或没有可写挂载时卡片停在「等待补充
   * 信息」，不再弹一句指向按钮的黄条。
   */
  const planUpdate = useCallback(
    (scope: ActionScope, service: ServiceCandidate, originMessageId?: string) => {
      const zip = scope.attachments.find(
        (item) => item.uploadState === "uploaded" && /\.zip$/i.test(item.name) && item.remotePath,
      );
      const deployDir = pickDeployDirs(service)[0];
      const facts: PlanFacts = {
        staticSiteOnServer: false,
        distZipOnServer: Boolean(zip?.remotePath),
        // 用户刚在这台机器上选定了一个真实在跑的容器。
        composeProjectOnServer: true,
        composeInAttachments: false,
      };
      const kind = selectPlanKind(facts);
      const origin =
        originMessageId ??
        pushUserMessageTo(scope.workspaceId, t("更新现有服务：{{name}}", { name: service.name })).id;
      const context = createTaskContext({
        taskId: `task-${Date.now()}`,
        originMessageId: origin,
        server: scope.server || "unknown",
        sessionId: scope.sessionId,
        attachmentIds: scope.attachments.map((item) => item.id),
        verifiedTarget: {
          kind: "compose-project",
          service: service.name,
          root: deployDir,
          evidence: `docker ps/inspect：${service.name}（${service.image || t("未知镜像")}）`,
        },
      });
      if (scopeIsForeground(scope)) setCandidates(null);
      if (kind !== "compose-update" || !zip?.remotePath || !deployDir) {
        const reason = !zip?.remotePath
          ? t("服务器上还没有 ZIP")
          : t("这个容器没有可写的挂载目录");
        commitPlan(scope, context, null, {
          steps: [],
          result: t("等待补充信息：{{reason}}", { reason }),
        });
        return;
      }
      commitPlan(scope, context, "compose-update", {
        steps: buildUpdatePlan({ service, zipPath: zip.remotePath, deployDir }),
        result: t("更新 {{name}}：备份 {{dir}} → 解压 → 替换 → 重启 → 验证", {
          name: service.name,
          dir: deployDir,
        }),
      });
    },
    [commitPlan, pushUserMessageTo, scopeIsForeground, t],
  );

  /**
   * 输入区 / 首屏的「生成计划」：先落一条用户消息，任务才有明确的来源。
   *
   * 没有附件时只回一句人话，不发通知条 —— 界面上不该有"点某个按钮"的指路
   * 文案，用户看到的是缺什么。
   */

  return {
    commitPlan,
    generatePlan,
    runStep,
    runPlan,
    uploadToServer,
    probeServices,
    planUpdate,
    cleanupRemote,
  };
}
