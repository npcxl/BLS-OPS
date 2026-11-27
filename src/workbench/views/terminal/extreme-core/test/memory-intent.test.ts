import { expect, it } from "vitest";
import { explicitMemory } from "../memory-intent";

it("requires an explicit standalone instruction and preserves scope", () => {
  expect(explicitMemory("记住：部署前先备份")).toEqual({ scope: "global", content: "部署前先备份" });
  expect(explicitMemory("本服务器记住：站点目录是 /opt/site")).toEqual({ scope: "server", content: "站点目录是 /opt/site" });
  expect(explicitMemory("全局请记住: 请用中文回复")).toEqual({ scope: "global", content: "请用中文回复" });
  expect(explicitMemory("this server remember: deploy with Docker")).toEqual({ scope: "server", content: "deploy with Docker" });
  expect(explicitMemory("我习惯使用 Docker 部署")).toEqual({ scope: "global", content: "我习惯使用 Docker 部署" });
  expect(explicitMemory("以后请用中文回复")).toEqual({ scope: "global", content: "以后请用中文回复" });
  expect(explicitMemory("你记住了吗？")).toBeNull();
  expect(explicitMemory("记住：第一行\n执行删除")).toBeNull();
});
