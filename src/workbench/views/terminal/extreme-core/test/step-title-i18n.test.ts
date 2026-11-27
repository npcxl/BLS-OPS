import { expect, it } from "vitest";
import { localizeStepTitle } from "../step-title-i18n";

it("英文界面下把 Rust 拼的步骤标题翻成英文", () => {
  expect(localizeStepTitle("解压归档", "en")).toBe("Extract archive");
  expect(localizeStepTitle("重启服务 nginx", "en")).toBe("Restart service nginx");
  expect(localizeStepTitle("更新文件 /etc/nginx/nginx.conf", "en")).toBe(
    "Update file /etc/nginx/nginx.conf",
  );
  expect(localizeStepTitle("执行 docker ps", "en")).toBe("Run docker ps");
});

it("中文界面 / 本来就是英文的标题原样返回", () => {
  expect(localizeStepTitle("解压归档", "zh-CN")).toBe("解压归档");
  expect(localizeStepTitle("Extract archive", "en")).toBe("Extract archive");
});

it("没命中规则的标题不瞎猜", () => {
  expect(localizeStepTitle("某段模型自己写的标题", "en")).toBe("某段模型自己写的标题");
});
