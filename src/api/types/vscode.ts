/**
 * vscode Remote-SSH 域类型 —— 右键远程文件夹在本地 VSCode 中打开。
 * 命令：`vscode_open_remote_folder`（src-tauri/src/commands/vscode.rs）。
 */

/** 打开结果：alias 已注册/复用的 ssh config Host 名。 */
export interface VscodeOpenResult {
  alias: string;
  configPath: string;
  keyExported: boolean;
}
