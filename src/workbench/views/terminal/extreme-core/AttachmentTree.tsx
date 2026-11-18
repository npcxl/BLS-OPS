import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FileText, FolderOpen } from "@/components/icons";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { ExtremeAttachment } from "@/stores/extreme-store";
import { EC } from "./theme";

interface TreeDir {
  kind: "dir";
  /** 相对路径前缀，同时用作展开标识。 */
  path: string;
  name: string;
  depth: number;
  children: TreeNode[];
  /** 子树里的文件数（展开前也能看到规模）。 */
  count: number;
}

interface TreeFile {
  kind: "file";
  attachment: ExtremeAttachment;
  name: string;
  depth: number;
}

type TreeNode = TreeDir | TreeFile;

/**
 * 把附件按 `/` 拆成目录树。
 *
 * 目录用**路径前缀**做标识（同一目录只出现一次），文件直接挂附件对象 ——
 * 渲染时不再按 id 反查，避免几百个文件时的重复扫描。
 */
function buildTree(attachments: ExtremeAttachment[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeDir>();

  const ensureDir = (segments: string[]): TreeNode[] => {
    let level = roots;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let dir = dirs.get(prefix);
      if (!dir) {
        dir = { kind: "dir", path: prefix, name: segment, depth: segments.length - 1, children: [], count: 0 };
        // depth 由调用方修正：目录层级 = 已经进入的段数 - 1。
        dirs.set(prefix, dir);
        level.push(dir);
      }
      level = dir.children;
    }
    return level;
  };

  for (const item of attachments) {
    const path = item.path ?? item.name;
    const parts = path.split("/").filter(Boolean);
    const file: TreeFile = {
      kind: "file",
      attachment: item,
      name: parts[parts.length - 1] ?? path,
      depth: parts.length - 1,
    };
    const container = ensureDir(parts.slice(0, -1));
    container.push(file);
    // 逐级累加文件数，折叠时也能显示规模。
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      const dir = dirs.get(prefix);
      if (dir) {
        dir.count += 1;
        dir.depth = i;
      }
    }
  }

  // 目录在前、文件在后，各自按名字排。
  const sortLevel = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) if (node.kind === "dir") sortLevel(node.children);
  };
  sortLevel(roots);
  return roots;
}

/**
 * 左侧附件树 —— **项目自己的文件面板风格**（不用 antd Tree）。
 *
 * 为什么换掉：antd 的 `DirectoryTree` 在几百个文件时要么卡、要么虚拟滚动
 * 与选中/右键状态对不上。这里自己维护展开集合，**只渲染展开可见的行**，
 * 366 个文件时 DOM 里只有根层那几行。
 */
export const AttachmentTree = memo(function AttachmentTree({
  attachments,
  preview,
  onPreview,
  onRemove,
  onAddToChat,
}: {
  attachments: ExtremeAttachment[];
  preview: string | null;
  onPreview: (id: string) => void;
  onRemove: (id: string) => void;
  onAddToChat: (id: string) => void;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildTree(attachments), [attachments]);
  /** 展开的目录路径集合。默认只展开根层。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const roots = new Set<string>();
    for (const node of tree) if (node.kind === "dir") roots.add(node.path);
    return roots;
  });
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  // 点别处 / 滚动就关掉右键菜单。
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /** 拍平成"当前可见的行"：折叠的目录不进去。 */
  const rows = useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        out.push(node);
        if (node.kind === "dir" && expanded.has(node.path)) walk(node.children);
      }
    };
    walk(tree);
    return out;
  }, [expanded, tree]);

  if (attachments.length === 0) return null;

  return (
    <aside
      className="flex w-[216px] shrink-0 flex-col overflow-hidden px-1.5 py-2"
      style={{ background: EC.surface, borderRight: `1px solid ${EC.border}` }}
    >
      <div className="mb-1 px-1 text-10" style={{ color: EC.fgSubtle }}>
        {t("附件")} · {attachments.length}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((node) =>
          node.kind === "dir" ? (
            <li key={`dir:${node.path}`}>
              <button
                type="button"
                onClick={() => toggle(node.path)}
                className="flex w-full items-center gap-1 rounded-[3px] px-1 py-[3px] text-left text-11"
                style={{ paddingLeft: 4 + node.depth * 12, color: EC.fgMuted }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = EC.surfaceHover;
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                }}
              >
                <ChevronRight
                  size={11}
                  className={cn("shrink-0 transition-transform", expanded.has(node.path) && "rotate-90")}
                />
                <FolderOpen size={12} className="shrink-0" style={{ color: EC.accentSoft }} />
                <span className="truncate">{node.name}</span>
                <span className="ml-auto shrink-0 text-10" style={{ color: EC.fgSubtle }}>
                  {node.count}
                </span>
              </button>
            </li>
          ) : (
            <li key={node.attachment.id}>
              <button
                type="button"
                title={`${node.attachment.path ?? node.attachment.name} · ${formatSize(node.attachment.size)}`}
                onClick={() => onPreview(node.attachment.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, id: node.attachment.id });
                }}
                className="flex w-full items-center gap-1 rounded-[3px] px-1 py-[3px] text-left text-11"
                style={{
                  paddingLeft: 16 + node.depth * 12,
                  color: node.attachment.state === "failed" ? EC.danger : EC.fgMuted,
                  background: preview === node.attachment.id ? EC.surfaceHover : "transparent",
                }}
                onMouseEnter={(event) => {
                  if (preview !== node.attachment.id) event.currentTarget.style.background = EC.surfaceHover;
                }}
                onMouseLeave={(event) => {
                  if (preview !== node.attachment.id) event.currentTarget.style.background = "transparent";
                }}
              >
                <FileText size={11} className="shrink-0" />
                <span className="truncate">{node.name}</span>
                {/* 三态分开显示：只有"已部署"才是最终完成。 */}
                {node.attachment.uploadState === "uploading" && (
                  <span className="shrink-0 text-10" style={{ color: EC.fgSubtle }} title={t("上传中…")}>
                    ⋯
                  </span>
                )}
                {node.attachment.uploadState === "uploaded" && (
                  <span
                    className="shrink-0 text-10"
                    style={{ color: EC.accentSoft }}
                    title={t("已上传到临时目录")}
                  >
                    ↑
                  </span>
                )}
                {node.attachment.uploadState === "deployed" && (
                  <span className="shrink-0 text-10" style={{ color: EC.success }} title={t("已部署")}>
                    ✓
                  </span>
                )}
                {node.attachment.remoteError && (
                  <span
                    className="shrink-0 text-10"
                    style={{ color: EC.danger }}
                    title={node.attachment.remoteError}
                  >
                    !
                  </span>
                )}
                {node.attachment.state === "failed" && <span className="shrink-0 text-10">!</span>}
              </button>
            </li>
          ),
        )}
      </ul>

      {menu && (
        <div
          className="fixed z-[70] min-w-[132px] overflow-hidden rounded-[6px] py-1 text-11 shadow-[0_8px_24px_rgb(0_0_0/0.5)]"
          style={{
            left: menu.x,
            top: menu.y,
            background: EC.surfaceRaised,
            border: `1px solid ${EC.border}`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="block w-full px-3 py-1 text-left"
            style={{ color: EC.fgMuted }}
            onClick={() => {
              onAddToChat(menu.id);
              setMenu(null);
            }}
          >
            {t("添加到对话")}
          </button>
          <button
            type="button"
            className="block w-full px-3 py-1 text-left"
            style={{ color: EC.danger }}
            onClick={() => {
              onRemove(menu.id);
              setMenu(null);
            }}
          >
            {t("删除")}
          </button>
        </div>
      )}
    </aside>
  );
});
