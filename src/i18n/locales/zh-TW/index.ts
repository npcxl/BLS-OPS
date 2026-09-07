/**
 * zh-TW 彙總 —— 每個模組一個檔案（**語言檔案單獨做，不要堆在一個檔案裡**），
 * 這裡只做合併。合併順序：common 在最前（最通用），後面模組可覆蓋同名 key
 * （模組特有措辭優先）。
 *
 * 由 `zh-CN` 經 OpenCC（s2twp）轉換產生：簡→繁 + 台灣慣用語。
 * 結構與 `zh-CN` 一一對應，新增模組時兩邊同時加。
 */
import common from "./common";
import workbench from "./workbench";
import terminal from "./terminal";
import servers from "./servers";
import commandCenter from "./commandCenter";
import commandResult from "./commandResult";
import files from "./files";
import projects from "./projects";
import monitor from "./monitor";
import docker from "./docker";
import nginx from "./nginx";
import settings from "./settings";
import updater from "./updater";
import errors from "./errors";

export default {
  ...common,
  ...workbench,
  ...terminal,
  ...servers,
  ...commandCenter,
  ...commandResult,
  ...files,
  ...projects,
  ...monitor,
  ...docker,
  ...nginx,
  ...settings,
  ...updater,
  ...errors,
} as const;
