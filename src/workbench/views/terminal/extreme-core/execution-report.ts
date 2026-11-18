/**
 * 平台替用户执行的**动作结果**（上传 / 生成计划 / 执行）。
 *
 * 以前这些结果是往对话里塞一条 assistant 气泡（"已上传 3 个文件…"），看着
 * 像模型说了句话，而且会改会话标题。现在收敛成「执行结果」：挂在发起它的那条
 * 任务的操作链下面，**同一步只用同一个 id 更新**，不会越点越多。
 *
 * 纯数据 + 纯函数：文案、状态判定都能单测。
 */

export type ReportStatus = "requested" | "success" | "partial" | "failed";

export interface ExecutionReport {
  /** 同一个动作复用一个 id（`upload` / `plan` / `run`）。 */
  id: string;
  /** 一行结论，例如「已上传 3 个文件到服务器临时目录」。 */
  title: string;
  /** 明细：失败原因、复用了几个文件… */
  detail?: string;
  /** 可点击打开的目录（上传落盘的临时目录）。 */
  path?: string;
  status: ReportStatus;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function reportStatusLabel(status: ReportStatus, t: Translate): string {
  switch (status) {
    case "requested":
      return t("已请求");
    case "success":
      return t("已成功");
    case "partial":
      return t("部分成功");
    case "failed":
      return t("失败");
  }
}

/** 动还没开始（或刚发出去）：先占一行，执行完用同一个 id 覆盖。 */
export function requestedUploadReport(
  t: Translate,
  input: { count: number; root: string },
): ExecutionReport {
  return {
    id: "upload",
    status: "requested",
    title: t("已请求上传 {{n}} 个文件到服务器临时目录", { n: input.count }),
    path: input.root,
  };
}

/**
 * 上传结果：**按实际返回**区分成功 / 部分成功 / 失败。
 *
 * * 全部写成功（含复用已存在的）→ 已成功；
 * * 有失败但也有落盘的 → 部分成功；
 * * 一个都没落盘 → 失败，标题里带第一条原因。
 */
export function uploadReport(
  t: Translate,
  input: { written: number; reused: number; failures: string[]; root: string },
): ExecutionReport {
  const { written, reused, failures, root } = input;
  const landed = written + reused;
  const status: ReportStatus =
    failures.length === 0 ? "success" : landed > 0 ? "partial" : "failed";
  const detail = failures.length > 0 ? failures.slice(0, 6).join("\n") : undefined;

  if (status === "failed") {
    return {
      id: "upload",
      status,
      title: t("上传失败：{{n}} 个文件都没有写成功", { n: failures.length }),
      detail,
    };
  }
  if (status === "partial") {
    return {
      id: "upload",
      status,
      title:
        written > 0
          ? t("已上传 {{n}} 个文件，{{failed}} 个失败", { n: written, failed: failures.length })
          : t("已复用 {{n}} 个文件，{{failed}} 个失败", { n: reused, failed: failures.length }),
      detail,
      path: root,
    };
  }
  return {
    id: "upload",
    status,
    title:
      reused > 0
        ? t("已上传 {{n}} 个文件（复用 {{reused}} 个）到服务器临时目录", { n: written, reused })
        : t("已上传 {{n}} 个文件到服务器临时目录", { n: written }),
    detail: reused > 0 ? t("复用 {{n}} 个已存在的文件", { n: reused }) : undefined,
    path: root,
  };
}

/**
 * 回给**模型**的上传回执。
 *
 * 模型拿到的是真话：写到哪个目录、几个成功、失败原因是什么，最后一句告诉它
 * 「已经落盘、部署时不必重传」，它才不会又规划一次上传。
 */
export function uploadReceipt(
  t: Translate,
  input: { written: number; reused: number; failures: string[]; root: string },
): string {
  const { written, reused, failures, root } = input;
  const parts = [
    t("已上传 {{n}} 个文件到 {{root}}", { n: written, root }),
    reused > 0 ? t("复用 {{n}} 个已存在的文件", { n: reused }) : "",
    failures.length > 0
      ? t("失败 {{n}} 个：{{detail}}", { n: failures.length, detail: failures.slice(0, 6).join("；") })
      : "",
  ].filter(Boolean);
  if (failures.length > 0) {
    return `${parts.join(t("；"))}\n${t("失败的文件仍只在用户本机，需要的话先修权限/路径再重试。")}`;
  }
  return `${parts.join(t("；"))}\n${t("文件已按原目录结构落盘，部署时可直接复制，不必重传。")}`;
}

/** 生成计划：有步骤才算成功，停在「等待补充」算部分成功。 */
export function planReport(
  t: Translate,
  input: { result: string; ready: boolean },
): ExecutionReport {
  return {
    id: "plan",
    status: input.ready ? "success" : "partial",
    title: input.result || (input.ready ? t("已生成计划") : t("计划缺少执行所需的信息")),
  };
}

/** 执行 / 验证：按步骤的最终状态给出结论。 */
export function runReport(
  t: Translate,
  steps: { state: string; title?: string }[],
): ExecutionReport {
  const done = steps.filter((step) => step.state === "success").length;
  const failed = steps.filter((step) => step.state === "failed").length;
  if (steps.length === 0) {
    return { id: "run", status: "failed", title: t("没有可执行的步骤") };
  }
  if (failed === 0) {
    return { id: "run", status: "success", title: t("{{n}} 个步骤全部通过", { n: done }) };
  }
  return {
    id: "run",
    status: done > 0 ? "partial" : "failed",
    title:
      done > 0
        ? t("{{ok}} 个步骤通过，{{failed}} 个失败", { ok: done, failed })
        : t("{{failed}} 个步骤失败", { failed }),
    detail:
      steps
        .filter((step) => step.state === "failed")
        .slice(0, 4)
        .map((step) => step.title ?? "")
        .filter(Boolean)
        .join("\n") || undefined,
  };
}
