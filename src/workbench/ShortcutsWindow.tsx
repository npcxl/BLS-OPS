/**
 * 独立快捷键窗口（`index.html?view=shortcuts`）。
 *
 * 边操作边查的组合最常用，所以做成独立窗口而不是设置里的一个区块：
 * 主窗口全屏操作时，这个窗口可以放在旁边一直开着。
 */
import { useTranslation } from "react-i18next";
import { PageHeader, PageScroll, PageSurface } from "./page-layout";
import { ShortcutSettingsGroup } from "./settings-shortcuts";

export function ShortcutsWindow() {
  const { t } = useTranslation();
  return (
    <PageSurface>
      <PageHeader
        title={t("Keyboard shortcuts")}
        description={t("The same shortcuts apply in the main window.")}
      />
      <PageScroll width="reading">
        <ShortcutSettingsGroup />
      </PageScroll>
    </PageSurface>
  );
}
