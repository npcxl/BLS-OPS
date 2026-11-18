import { describe, expect, it } from "vitest";
import { approvalIntent, isRetryIntent, isStartIntent, routeIntent } from "../intent";
import { createTaskContext, withPlan, withVerifiedTarget } from "../task-context";

const base = () =>
  createTaskContext({
    taskId: "task-1",
    originMessageId: "msg-1",
    server: "prod",
    sessionId: "ssh-1",
  });

describe("是不是「继续」", () => {
  it("识别简短肯定", () => {
    for (const text of ["开始吧", "开始", "继续", "确认执行", "可以", "OK", "go ahead"]) {
      expect(isStartIntent(text), text).toBe(true);
    }
  });

  it("正常提问不算", () => {
    for (const text of ["这是什么文件？", "开始部署前先看看端口", "帮我看看 dist.zip"]) {
      expect(isStartIntent(text), text).toBe(false);
    }
  });
});

describe("是不是「重试」", () => {
  it("三种常见说法都认", () => {
    for (const text of [
      "重试",
      "重试一下",
      "再试一次",
      "重新跑一次",
      "刚才那步再跑一下",
      "上一步再执行一下",
      "retry",
    ]) {
      expect(isRetryIntent(text), text).toBe(true);
    }
  });

  it("带提问语气的长句不算", () => {
    for (const text of [
      "重试按钮为什么没反应？",
      "刚才那步再跑一下会不会把文件写坏",
      "我想知道上次为什么失败",
      "先重试一下再说吧",
    ]) {
      expect(isRetryIntent(text), text).toBe(false);
    }
  });

  it("「开始吧」不会被当成重试", () => {
    expect(isRetryIntent("开始吧")).toBe(false);
    expect(isRetryIntent("")).toBe(false);
  });
});

describe("待确认写操作的口头答复", () => {
  it("「按你说的改」类直接放行", () => {
    for (const text of ["按你说的改", "按你说的做", "就这么改", "改吧", "可以", "同意", "确认", "执行吧", "go ahead"]) {
      expect(approvalIntent(text), text).toBe("allow");
    }
  });

  it("「先别动」类一律拒绝", () => {
    for (const text of ["先别动", "别动", "不要改", "先不要", "暂停", "取消", "拒绝", "算了", "no", "stop"]) {
      expect(approvalIntent(text), text).toBe("deny");
    }
  });

  it("问影响 → 用卡片事实回答，不是表态", () => {
    for (const text of ["会影响什么", "有什么风险", "会改哪些文件", "为什么要改这个"]) {
      expect(approvalIntent(text), text).toBe("explain");
    }
  });

  it("长句确认（带理由）也算允许", () => {
    for (const text of ["可以，按你说的改吧", "没问题，就这样改，改完告诉我"]) {
      expect(approvalIntent(text), text).toBe("allow");
    }
  });

  /*
   * 条件是**放行前必须满足的东西**：句子整体是肯定，但带了「但 / 先 / 再 /
   * 如果 / 确认…」这类限制时，按允许处理会在前提没满足时就执行。
   */
  it("句子里带条件 / 限制时不表态（交给对话先处理条件）", () => {
    for (const text of [
      "可以，但先别重启",
      "可以，先确认备份存在，存在再执行",
      "同意，按你说的做，先把标题换掉",
      "好的，先备份再改",
      "行，但改完要能回滚",
      "可以，如果 nginx -t 通过就重载",
      "可以用测试环境验证一下",
      "好像项目名写错了",
    ]) {
      expect(approvalIntent(text), text).not.toBe("allow");
    }
  });

  it("带问句的长句先回答，不当作允许", () => {
    for (const text of ["可以吗？会影响到线上吗", "按你说的改，会不会把 nginx 弄挂？"]) {
      expect(approvalIntent(text), text).not.toBe("allow");
    }
  });

  it("正常提问不会被当成「允许执行」", () => {
    for (const text of [
      "这个站点的端口是多少",
      "先看看现在的配置再改",
      "确认一下 nginx 的版本",
      "帮我把日志备份一下再改",
    ]) {
      expect(approvalIntent(text), text).toBeNull();
    }
  });
});

describe("意图路由", () => {
  it("唯一待确认任务 → 直接执行那张卡", () => {
    const task = withPlan(base(), "static-update");
    expect(routeIntent("开始吧", [task])).toEqual({
      kind: "continue",
      taskId: "task-1",
      action: "run",
    });
  });

  it("唯一任务但还没计划 → 原地生成计划（不是执行、也不是新任务）", () => {
    const task = withVerifiedTarget(base(), {
      kind: "static-site",
      root: "/var/www/app",
      evidence: "nginx root 指向该目录",
    });
    expect(routeIntent("继续", [task])).toEqual({
      kind: "continue",
      taskId: "task-1",
      action: "plan",
    });
  });

  it("多个待确认 → 让用户选，不新起任务", () => {
    const a = withPlan(base(), "static-update");
    const b = withPlan({ ...base(), taskId: "task-2", originMessageId: "msg-2" }, "query");
    expect(routeIntent("开始", [a, b])).toEqual({ kind: "choose", taskIds: ["task-1", "task-2"] });
  });

  it("没有可继续的任务 → 普通问答", () => {
    expect(routeIntent("开始吧", [])).toEqual({ kind: "chat" });
    expect(routeIntent("开始吧", [{ ...base(), phase: "done" }])).toEqual({ kind: "chat" });
  });

  it("非继续语句一律走问答（不会误触发任务）", () => {
    const task = withPlan(base(), "static-update");
    expect(routeIntent("这个站点用的哪个端口", [task])).toEqual({ kind: "chat" });
  });
});
