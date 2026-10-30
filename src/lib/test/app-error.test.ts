import "@/i18n";
import { describe, expect, it } from "vitest";
import {
  canRetry,
  formatErrorForCopy,
  stageLabel,
  toAppError,
} from "@/lib/app-error";

/**
 * 错误归一化的约定。
 *
 * 前端不允许把 `String(cause)` 直接渲染出去：结构化错误会被 toString 成
 * `[object Object]`，后端原文则可能是一段几百行的 SQL。这组用例锁死
 * "阶段 + 一行摘要 + 详情 + 恢复建议"的形状。
 */
describe("toAppError", () => {
  it("结构化错误保留 stage / code / detail 与重试语义", () => {
    const info = toAppError({
      stage: "auth",
      code: 1045,
      sql_state: "28000",
      message: "Access denied for user 'root'",
      detail: "plugin: caching_sha2_password",
      retryable: false,
    });

    expect(info.stage).toBe("auth");
    expect(info.code).toBe("1045 28000");
    expect(info.message).toBe("Access denied for user 'root'");
    expect(info.detail).toBe("plugin: caching_sha2_password");
    // 认证失败重试同样的密码只会再失败一次：不给"重试"入口。
    expect(info.retryable).toBe(false);
    expect(canRetry(info, () => undefined)).toBe(true); // 提供入口时允许手动重试
    expect(info.hint).toContain("username and password");
  });

  it("结果未知必须显式标记，且禁止自动重试", () => {
    const info = toAppError({
      stage: "outcome_unknown",
      message: "COMMIT 期间连接中断",
      retryable: true,
    });

    expect(info.outcomeUnknown).toBe(true);
    expect(info.hint).toContain("Do not retry blindly");
    // 即使调用方给了 retry，也不该出现重试按钮：可能已经写进去了。
    expect(canRetry(info, () => undefined)).toBe(false);
  });

  it("多行原文拆成摘要 + 详情，不让一行撑爆界面", () => {
    const info = toAppError("Error 1064: syntax error\nline 1: SELECT * FROM\nline 3: near 'x'");

    expect(info.message).toBe("Error 1064: syntax error");
    expect(info.detail).toContain("line 3");
  });

  it("JSON 字符串里的结构化错误会被解开", () => {
    const info = toAppError(
      JSON.stringify({ stage: "tcp", message: "Connection refused", detail: "127.0.0.1:3306" }),
    );

    expect(info.stage).toBe("tcp");
    expect(info.message).toBe("Connection refused");
    expect(info.detail).toBe("127.0.0.1:3306");
  });

  it("普通 Error 与未知值都能渲染成人话", () => {
    expect(toAppError(new Error("boom")).message).toBe("boom");
    expect(toAppError(undefined).message).toBe("Unknown error");
    expect(toAppError(null).message).toBe("Unknown error");
    expect(toAppError({ weird: true }).message).toBe("Unknown error");
  });

  it("超长摘要被裁剪，详情单独保留", () => {
    const info = toAppError("x".repeat(5_000));
    expect(info.message.length).toBeLessThanOrEqual(601);
  });
});

describe("展示辅助", () => {
  it("stage 有本地化标题，未知阶段原样回退", () => {
    expect(stageLabel("ssh_tunnel")).toBe("SSH tunnel");
    expect(stageLabel("brand_new_stage")).toBe("brand_new_stage");
    expect(stageLabel(null)).toBeNull();
  });

  it("复制的错误信息包含阶段、错误码与详情", () => {
    const text = formatErrorForCopy(
      toAppError({ stage: "query", code: 1213, message: "Deadlock found", detail: "waiting for lock" }),
      "订单库 · 更新",
    );

    expect(text).toContain("## 订单库 · 更新");
    expect(text).toContain("stage: query");
    expect(text).toContain("code: 1213");
    expect(text).toContain("Deadlock found");
    expect(text).toContain("waiting for lock");
  });
});
