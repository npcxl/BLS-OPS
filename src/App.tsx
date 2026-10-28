import { useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SplashScreen } from "@/components/ui/SplashScreen";
import { useTrayLabels } from "@/hooks/use-tray-labels";
import { Workbench } from "@/workbench/Workbench";
import { DetachedSqlWindow } from "@/workbench/views/database/DetachedSqlWindow";
import { isDetachedSqlWindow } from "@/workbench/views/database/detached-sql";

/** App root — spec §72. */
export default function App() {
  // 独立 SQL 窗口只渲染查询页，不加载整个工作台。
  if (isDetachedSqlWindow()) {
    return (
      <ErrorBoundary>
        <DetachedSqlWindow />
      </ErrorBoundary>
    );
  }
  return <MainApp />;
}

function MainApp() {
  // 托盘菜单文案跟随界面语言（点 X 隐藏到托盘，托盘里恢复/退出）。
  useTrayLabels();
  // 开屏动画盖在 Workbench 上：Workbench 照常挂载加载数据，动画结束淡出
  // 后卸载 Splash，不阻塞启动。
  const [splash, setSplash] = useState(true);
  return (
    <ErrorBoundary>
      {splash && <SplashScreen onFinished={() => setSplash(false)} />}
      <Workbench />
    </ErrorBoundary>
  );
}
