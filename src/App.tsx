import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useTrayLabels } from "@/hooks/use-tray-labels";
import { Workbench } from "@/workbench/Workbench";

/** App root — spec §72. */
export default function App() {
  // 托盘菜单文案跟随界面语言（点 X 隐藏到托盘，托盘里恢复/退出）。
  useTrayLabels();
  return (
    <ErrorBoundary>
      <Workbench />
    </ErrorBoundary>
  );
}
