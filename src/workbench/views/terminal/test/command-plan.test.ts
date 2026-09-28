import { describe, expect, it } from "vitest";
import { blocksCapture, planCommandSubmission } from "../command-plan";
import {
  CommandBoundaryParser,
  INJECTED_LINES,
  MARKER_C_LINE,
  MARKER_D_LINE,
} from "../command-boundary";

describe("planCommandSubmission", () => {
  it("普通命令注入受控标记，且**不改写命令本身**", () => {
    const plan = planCommandSubmission("df -h", "full");
    expect(plan.capture).toBe(true);
    expect(plan.markers).toEqual(INJECTED_LINES);
    expect(plan.write).toContain("df -h");
    expect(plan.write).toContain(MARKER_C_LINE);
    expect(plan.write).toContain(MARKER_D_LINE);
    // 顺序：输出开始标记 → 命令 → 结束标记（shell 按行顺序执行）。
    const lines = plan.write.split("\n").map((line) => line.trim());
    expect(lines[0]).toBe(MARKER_C_LINE);
    expect(lines[1]).toBe("df -h");
    expect(lines[2]).toBe(MARKER_D_LINE);
  });

  it("line-ready 只补结束标记（命令行已经在终端上）", () => {
    const plan = planCommandSubmission("docker ps -a", "line-ready");
    expect(plan.capture).toBe(true);
    expect(plan.write).toBe(` ${MARKER_D_LINE}\n`);
    // 不能重复写一遍命令（命令行已经在终端上了）。
    expect(plan.write).not.toContain("docker ps -a");
  });

  it("管道命令照常捕获（输出按最终形态自动识别）", () => {
    const plan = planCommandSubmission("ps aux | grep nginx", "full");
    expect(plan.capture).toBe(true); // 带管道也应尝试自动识别
    expect(plan.write).toContain("ps aux | grep nginx");
  });

  it("交互式程序留在原生终端，不注入标记", () => {
    for (const command of ["vim /etc/hosts", "top", "htop", "less /var/log/x", "nano a.txt", "watch -n1 uptime"]) {
      const plan = planCommandSubmission(command, "full");
      expect(plan.capture).toBe(false);
      // 命令照发，只是不捕获。
      expect(plan.write).toBe(`${command}\n`);
      expect(plan.markers).toEqual([]);
    }
  });

  it("会吞 stdin 的程序不注入标记（否则标记会被当输入吃掉）", () => {
    expect(blocksCapture("cat")).toBe(true);
    expect(blocksCapture("grep foo")).toBe(true);
    expect(blocksCapture("python3")).toBe(true);
    expect(blocksCapture("mysql -u root")).toBe(true);
    // 有文件参数 → 不读 stdin，可以捕获。
    expect(blocksCapture("cat /etc/hosts")).toBe(false);
    expect(blocksCapture("tail -n 50 /var/log/nginx/error.log")).toBe(false);
    // `-f` 永不结束 → 不能捕获。
    expect(blocksCapture("tail -f /var/log/nginx/access.log")).toBe(true);
  });

  it("管道只有第一段可能读 stdin", () => {
    // 管道只有第一段可能读 stdin。
    expect(blocksCapture("ps aux | grep nginx")).toBe(false); // grep 不是第一段
    expect(blocksCapture("cat | grep x")).toBe(true); // 第一段是 cat
  });

  it("cd 家族：不弹结果面板，但**必须**注入结束标记（cwd 追踪要退出码）", () => {
    for (const command of ["cd /tmp", "cd", "cd ..", "pushd /var"]) {
      const full = planCommandSubmission(command, "full");
      expect(full.capture).toBe(false);
      expect(full.write).toContain(command);
      expect(full.write).toContain(MARKER_D_LINE);
      expect(full.markers).toEqual([MARKER_D_LINE]);
      // 不需要 C 标记（没有输出要捕获）。
      expect(full.write).not.toContain(MARKER_C_LINE);

      // line-ready：命令行已经在终端上了 → 只补结束标记。
      const ready = planCommandSubmission(command, "line-ready");
      expect(ready.capture).toBe(false);
      expect(ready.write).toBe(` ${MARKER_D_LINE}\n`);
      expect(ready.markers).toEqual([MARKER_D_LINE]);
    }
  });

  it("其余无输出内建命令一个标记都不写（不给用户多加空提示符行）", () => {
    // `fg` / `bg` 尤其不能注入：命令交给前台作业后，注入的文本会变成它的输入。
    for (const command of ["export FOO=1", "alias ll='ls -l'", "unset FOO", "fg", "jobs"]) {
      const full = planCommandSubmission(command, "full");
      expect(full.capture).toBe(false);
      expect(full.write).toBe(`${command}\n`);
      expect(full.markers).toEqual([]);
      // line-ready：命令行已经敲好了，什么都不补。
      expect(planCommandSubmission(command, "line-ready").write).toBe("");
    }
  });

  it("cd 的结束标记能一路解析出退出码（cwd 追踪的完整闭环）", () => {
    // 这条链路是回归防线：cd → 注入 D 标记 → 解析出 output_end(0) →
    // `onCommandEnd` 才能把"待确认目录"落实。断了就退化成
    // "tracked cwd 永远停在登录目录"，相对路径全部解析错。
    const plan = planCommandSubmission("cd opt", "line-ready");
    const parser = new CommandBoundaryParser();
    parser.expect(plan.markers);
    const parsed = parser.feed(`\x1b]133;D;0\x07`);
    expect(parsed.events).toEqual([{ type: "output_end", exitCode: 0 }]);
  });

  it("空命令不写任何东西", () => {
    expect(planCommandSubmission("   ").write).toBe("");
    expect(planCommandSubmission("").capture).toBe(false);
  });
});
