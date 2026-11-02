/* 临时截图预览页：真实组件 + 仿资产树/表格/SQL 编辑器背景，用于对拍玻璃材质。 */
import { useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ClipboardCopy,
  FolderInput,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import "@/i18n";
import "@/styles/globals.css";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const scene = params.get("scene") ?? "split";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.material = "solid";

const children: ContextMenuItem[] = [
  { id: "g0", label: "Ungrouped" },
  { id: "g1", label: "Production" },
  { id: "g2", label: "Staging（东京）" },
];

const items: ContextMenuItem[] = [
  { id: "open", label: "Open terminal", icon: SquareTerminal, hint: "↵" },
  { id: "edit", label: "Edit config", icon: Pencil },
  { id: "copy", label: "Copy path", icon: ClipboardCopy, hint: "⌘C" },
  { id: "sep", separator: true },
  { id: "move", label: "Move to group", icon: FolderInput, children },
  { id: "refresh", label: "Refresh", icon: RefreshCw, disabled: true },
  { id: "delete", label: "Delete", icon: Trash2, danger: true },
];

const positions: Record<string, { x: number; y: number }> = {
  tree: { x: 40, y: 120 },
  table: { x: 780, y: 150 },
  split: { x: 258, y: 300 },
  sql: { x: 520, y: 600 },
  submenu: { x: 258, y: 250 },
};

const treeRows = Array.from({ length: 34 }, (_, index) => ({
  depth: index % 3,
  label: ["servers", "nginx-pord-01", "compose.yaml", "ssl", "fullchain.pem"][index % 5],
  meta: ["/etc/nginx", "10.0.8.14", "—", "certs"][index % 4],
}));

const tableRows = Array.from({ length: 24 }, (_, index) => ({
  id: index + 1,
  name: ["id", "host", "port", "created_at", "status", "note"][index % 6],
  type: ["bigint", "varchar(64)", "int", "timestamp", "enum", "text"][index % 6],
  value: ["1", "'10.0.8.14'", "3306", "2026-10-31 09:12", "'online'", "'主库只读'"],
}));

function Frame({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-app text-fg">
      {children}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-surface-2">
        <div className="flex h-9 items-center gap-2 border-b border-line px-3 text-11 font-semibold text-fg-muted">
          ASSETS · 资产树
        </div>
        <div className="flex-1 overflow-hidden py-1">
          {treeRows.map((row, index) => (
            <div
              key={index}
              className="flex h-[26px] items-center gap-2 pr-2 text-12"
              style={{ paddingLeft: 10 + row.depth * 14 }}
            >
              <span className="h-1 w-1 rounded-full bg-fg-subtle/50" />
              <span className="min-w-0 flex-1 truncate text-fg">{row.label}</span>
              <span className="shrink-0 text-10 text-fg-subtle">{row.meta}</span>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-content">
        <div className="flex h-9 items-center gap-3 border-b border-line px-4 text-11 text-fg-muted">
          ops / mysql / prod-cluster / <span className="text-fg">users</span>
        </div>
        <div className="grid grid-cols-[52px_120px_1fr_150px_120px_1fr] border-b border-line bg-surface-1 text-11 font-semibold text-fg-subtle">
          {["#", "column", "type", "value", "null", "comment"].map((cell) => (
            <div key={cell} className="h-8 border-r border-line/60 px-3 leading-8">
              {cell}
            </div>
          ))}
        </div>
        <div className="flex-1 overflow-hidden bg-content font-mono text-11 leading-6">
          {tableRows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[52px_120px_1fr_150px_120px_1fr] border-b border-line/40"
            >
              <div className="border-r border-line/40 px-3 text-fg-subtle">{row.id}</div>
              <div className="border-r border-line/40 px-3 text-fg">{row.name}</div>
              <div className="border-r border-line/40 px-3 text-fg-muted">{row.type}</div>
              <div className="border-r border-line/40 px-3 text-fg-muted">{row.value[0]}</div>
              <div className="border-r border-line/40 px-3 text-fg-subtle">NULL</div>
              <div className="px-3 text-fg-subtle">comment {row.id}</div>
            </div>
          ))}
        </div>
        <section className="h-[290px] shrink-0 overflow-hidden bg-[#1b1d23] text-[#c8d3e0]">
          <div className="flex h-8 items-center gap-2 border-b border-white/10 px-3 text-11 text-white/70">
            SQL · query.sql
          </div>
          <pre className="m-0 p-3 font-mono text-11 leading-6">
{`SELECT  u.id, u.name, o.total
FROM    users u
JOIN    orders o ON o.user_id = u.id
WHERE   o.created_at >= '2026-01-01'
  AND   u.status = 'active'
ORDER BY o.total DESC
LIMIT   50;

-- 这里是一段较长的说明文字，用来观察背景文字是否透进菜单
-- 菜单覆盖在这块深色编辑器上时必须仍然保持浅色玻璃质感
SELECT COUNT(*) FROM audit_log WHERE actor = 'ops@example.com';`}
          </pre>
        </section>
      </main>
    </div>
  );
}

function Preview() {
  const pos = positions[scene] ?? positions.split;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (scene !== "submenu") return;
      const parent = document.querySelector<HTMLButtonElement>(
        '[role="menuitem"][aria-haspopup="true"]',
      );
      parent?.click();
    }, 120);
    const debugTimer = window.setTimeout(() => {
      const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'));
      const submenu = menus[menus.length - 1];
      if (!submenu) return;
      const rect = submenu.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const glass = submenu.querySelector<HTMLElement>(".glass");
      const content = submenu.querySelector<HTMLElement>(".menu-surface__content");
      const tint = submenu.querySelector<HTMLElement>(".menu-surface__tint");
      const read = (el: HTMLElement | null) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          rect: el.getBoundingClientRect().toJSON(),
          opacity: style.opacity,
          visibility: style.visibility,
          display: style.display,
          zIndex: style.zIndex,
          transform: style.transform,
          background: style.backgroundColor,
          textShadow: style.textShadow,
        };
      };
      const stack = document
        .elementsFromPoint(centerX, centerY)
        .slice(0, 6)
        .map((el) => `${el.tagName}.${(el as HTMLElement).className}`.slice(0, 80));
      const chain: Array<Record<string, unknown>> = [];
      let node: HTMLElement | null = submenu;
      while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        chain.push({
          tag: node.tagName,
          cls: String(node.className).slice(0, 48),
          vis: style.visibility,
          display: style.display,
          opacity: style.opacity,
          z: style.zIndex,
          inline: (node.getAttribute("style") ?? "").slice(0, 100),
        });
        node = node.parentElement;
      }
      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).slice(0, 4);
      const itemInfo = items.map((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
        return {
          text: el.textContent?.slice(0, 24),
          vis: getComputedStyle(el).visibility,
          topMost: top === el,
        };
      });
      const rootHost = menus[0];
      const rootContent = rootHost.querySelector<HTMLElement>(".menu-surface__content");
      const rootGlass = rootHost.querySelector<HTMLElement>(".glass");
      const debug = {
        rect: rect.toJSON(),
        menuCount: document.querySelectorAll('[role="menu"]').length,
        hostVisibility: getComputedStyle(submenu).visibility,
        glass: read(glass),
        content: read(content),
        tint: read(tint),
        stack,
        chain,
        itemInfo,
        parentOfSubmenu: submenu.parentElement?.className,
        root: {
          rect: rootHost.getBoundingClientRect().toJSON(),
          vis: getComputedStyle(rootHost).visibility,
          contentVis: rootContent ? getComputedStyle(rootContent).visibility : "none",
          contentInline: rootContent?.getAttribute("style") ?? "none",
          glassVis: rootGlass ? getComputedStyle(rootGlass).visibility : "none",
          check: rootHost.checkVisibility?.() ?? "n/a",
        },
        sheets: Array.from(document.styleSheets).map((sheet) => sheet.href?.split("/").pop() ?? "inline"),
      };
      const pre = document.createElement("pre");
      pre.id = "debug";
      pre.textContent = JSON.stringify(debug, null, 2);
      document.body.appendChild(pre);
    }, 1200);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(debugTimer);
    };
  }, []);

  return (
    <>
      <Frame>
        <span className="sr-only">preview</span>
      </Frame>
      <ContextMenu
        open
        x={pos.x}
        y={pos.y}
        items={items}
        title="nginx-pord-01 / compose.yaml"
        minWidth={216}
        onClose={() => undefined}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
