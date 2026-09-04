/**
 * zh-CN 汇总 —— 每个模块一个文件（**语言文件单独做，不要堆在一个文件里**），
 * 这里只做合并。合并顺序：common 在最前（最通用），后面模块可覆盖同名 key
 * （模块特有措辞优先）。
 */
import common from "./common";
import workbench from "./workbench";
import terminal from "./terminal";
import servers from "./servers";
import commandCenter from "./commandCenter";
import files from "./files";
import projects from "./projects";
import monitor from "./monitor";
import docker from "./docker";
import nginx from "./nginx";
import settings from "./settings";
import errors from "./errors";

export default {
  ...common,
  ...workbench,
  ...terminal,
  ...servers,
  ...commandCenter,
  ...files,
  ...projects,
  ...monitor,
  ...docker,
  ...nginx,
  ...settings,
  ...errors,
} as const;
