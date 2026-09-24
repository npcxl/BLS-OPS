import { useState } from "react";
import { useTranslation } from "react-i18next";

import { selectClass } from "@/components/ui/modal";
import { useTerminalFont } from "@/hooks/use-terminal-font";
import { cn } from "@/lib/cn";
import { Group, ListGroup, Switch } from "./settings-parts";
import { TERMINAL_FONTS, resolveFontStack } from "./views/terminal/terminal-font";
import { readCompactPrompt, saveCompactPrompt } from "./views/terminal/terminal-prompt";

/**
 * 预览样张。
 *
 * 刻意**不翻译**：这是字体样张（跟"远程输出快照"同类），不是界面文案 ——
 * 它要展示的正是"等宽对齐 + 数字列 + 中英混排"这几种最容易露馅的内容，
 * 顺带让用户一眼看出所选字体能不能渲染中文。
 */
const PREVIEW_LINES = [
  "root@web-01:/opt/bls-kox# docker ps --format '{{.Names}}'",
  "api-gateway    Up 3 days   0.0.0.0:8080->80/tcp",
  "worker-01      Up 3 days   10.0.0.12",
  "序号   服务名         状态       吞吐",
  "01     api-gateway    running    12.5 MB/s",
];

/**
 * 终端设置组：字体（含**实时预览**）+ 提示符精简开关。
 *
 * 项目不打包字体文件（体积考虑），只切 CSS font stack —— 所以"选了什么、
 * 本机到底渲染成什么样"必须当场看得见，否则用户只能连上服务器去猜。
 * 预览块用的是与终端**完全相同**的那套栈（`resolveFontStack`）。
 *
 * 提示符精简是**会话级**的：连接成功后向远程 shell 发一条赋值命令，不写
 * 服务器任何配置文件（细节见 `terminal-prompt.ts`）。默认关 —— 它毕竟改变
 * 了远程会话行为，得用户自己点头。
 */
export function TerminalSettingsGroup() {
  const { t } = useTranslation();
  const { fontId, setFontId } = useTerminalFont();
  // 提示符精简不需要跨界面共享：它只在**连接成功那一刻**读一次（见
  // TerminalView 的注入点），设置变更从下一次连接生效。
  const [compactPrompt, setCompactPromptState] = useState(readCompactPrompt);

  return (
    <Group
      title={t("Terminal")}
      hint={t("The font is shared by the terminal and the command output panel.")}
    >
      <ListGroup>
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="shrink-0 text-12 text-fg">{t("Font")}</span>
          <select
            className={cn(selectClass, "max-w-40")}
            value={fontId}
            aria-label={t("Font")}
            onChange={(event) => setFontId(event.target.value)}
          >
            {TERMINAL_FONTS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="px-3 py-2">
          <pre
            data-testid="terminal-font-preview"
            aria-hidden
            className="overflow-x-auto whitespace-pre rounded-[8px] border border-line bg-surface-2 px-2 py-1.5 text-11 leading-relaxed text-fg-muted"
            style={{ fontFamily: resolveFontStack(fontId) }}
          >
            {PREVIEW_LINES.join("\n")}
          </pre>
        </div>
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <span className="block text-12 text-fg">{t("Compact prompt")}</span>
            <span className="block text-11 leading-relaxed text-fg-subtle">
              {t(
                "Shows only the current directory (~#, /#). One command is sent to the remote shell after connecting — session only, no server config file is touched.",
              )}
            </span>
          </div>
          <Switch
            checked={compactPrompt}
            label={t("Compact prompt")}
            onChange={(next) => {
              setCompactPromptState(next);
              saveCompactPrompt(next);
            }}
          />
        </div>
      </ListGroup>
    </Group>
  );
}

