import { describe, expect, it } from "vitest";
import { describeAction, parseActions } from "../extreme-core/chat-actions";

/**
 * 动作标记是"删掉所有任务按钮"之后**唯一的执行入口**：
 * 用户只说话，模型用标记请求执行，前端按白名单解析。
 *
 * 这些用例覆盖的正是验收场景里那两句：
 * 「用这个更新 OPS」→ 模型回 `[[upload]]` + `[[plan:ops]]`
 * 「开始吧」→ 模型回 `[[start]]`
 */
describe("parseActions", () => {
  it("解析上传与生成计划，并从正文里删掉标记", () => {
    const { clean, actions } = parseActions(
      "定位到容器 ops，挂载 /srv/ops。\n我会先上传附件，再生成更新计划。\n[[upload]][[plan:ops]]",
    );
    expect(actions).toEqual([{ kind: "upload" }, { kind: "plan", service: "ops" }]);
    expect(clean).toBe("定位到容器 ops，挂载 /srv/ops。\n我会先上传附件，再生成更新计划。");
    expect(clean).not.toContain("[[");
  });

  it("解析执行标记（用户说「开始吧」之后）", () => {
    const { clean, actions } = parseActions("备份到 /srv/ops.bak-xxx。\n[[start]]");
    expect(actions).toEqual([{ kind: "start" }]);
    expect(clean).toBe("备份到 /srv/ops.bak-xxx。");
  });

  it("正文只有执行标记时返回空正文", () => {
    const { clean, actions } = parseActions("[[start]]");
    expect(actions).toEqual([{ kind: "start" }]);
    expect(clean).toBe("");
  });

  it("多个动作按出现顺序保留", () => {
    const { actions } = parseActions("[[upload]][[plan]][[start]]");
    expect(actions.map((action) => action.kind)).toEqual(["upload", "plan", "start"]);
  });

  it("服务名只接受安全字符，非法时退化为「生成计划」", () => {
    // 路径、命令、引号都不该被当成服务名带走。
    for (const payload of ["../etc/passwd", "ops;rm -rf /", "a b", "\"ops\""]) {
      const { actions } = parseActions(`[[plan:${payload}]]`);
      expect(actions).toEqual([{ kind: "plan" }]);
    }
  });

  it("白名单之外的大括号标记原样保留（避免误伤正常文本）", () => {
    const { clean, actions } = parseActions("部署脚本里写着 [[deploy]] 和 [[restart]]。");
    expect(actions).toEqual([]);
    expect(clean).toContain("[[deploy]]");
    expect(clean).toContain("[[restart]]");
  });

  it("大小写不敏感", () => {
    expect(parseActions("[[UPLOAD]][[START]]").actions.map((action) => action.kind)).toEqual([
      "upload",
      "start",
    ]);
  });

  it("标记被代码块包起来也能识别（模型常这么写）", () => {
    const { clean, actions } = parseActions("```\n[[start]]\n```");
    expect(actions).toEqual([{ kind: "start" }]);
    expect(clean).not.toContain("[[");
    expect(clean.startsWith("```")).toBe(true);
  });
});

describe("describeAction", () => {
  it("每个动作都有一句可读回执", () => {
    expect(describeAction({ kind: "upload" })).toContain("上传");
    expect(describeAction({ kind: "plan", service: "ops" })).toContain("ops");
    expect(describeAction({ kind: "plan" })).toContain("部署计划");
    expect(describeAction({ kind: "start" })).toContain("执行");
  });
});
