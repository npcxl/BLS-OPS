/**
 * 全局图标唯一入口。
 *
 * 规则：
 * 1. 优先用 itshover 动画图标（https://www.itshover.com/icons）。src 里任何地方都不得
 *    再直接 `import ... from "lucide-react"`。
 * 2. itshover 确实没有的功能图标，统一从 ./lucide（白名单）导出，在这里 re-export。
 * 3. 导出名沿用原 lucide 名，业务侧只改 import 路径，JSX 不动。
 */
import type { ComponentType } from "react";
import { cn } from "@/lib/cn";
import {
  ArrowNarrowRightIcon,
  CameraOffIcon,
  CheckedIcon,
  ClockIcon,
  CodeXmlIcon,
  CopyIcon,
  CpuIcon,
  DockerIcon,
  DotsHorizontalIcon,
  DownChevron,
  DownloadIcon,
  ExpandIcon,
  EyeIcon,
  EyeOffIcon,
  FileDescriptionIcon,
  FilterIcon,
  GaugeIcon,
  GearIcon,
  GlobeIcon,
  HistoryCircleIcon,
  HomeIcon,
  InfoCircleIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LayoutSidebarRightCollapseIcon,
  LayoutSidebarRightIcon,
  LockIcon,
  MagnifierIcon,
  MoonIcon,
  PenIcon,
  PlayerIcon,
  PlugConnectedIcon,
  PlugConnectedXIcon,
  QuestionMark,
  RefreshIcon,
  RightChevron,
  RocketIcon,
  SaveIcon,
  ShieldCheck as ShieldCheckBase,
  SparklesIcon,
  StackIcon,
  StarIcon,
  TerminalIcon,
  TrashIcon,
  TriangleAlertIcon,
  UnorderedListIcon,
  UploadIcon,
  WifiOffIcon,
  XIcon,
} from "@/components/its-hover";
import type { AnimatedIconProps } from "@/components/its-hover";

/** 统一图标 props：itshover 图标与 lucide 白名单图标都满足此契约。 */
export type IconProps = AnimatedIconProps;
/** 统一图标组件类型，用于「图标作为值」的场景（导航表、页签表等）。 */
export type IconComponent = ComponentType<IconProps>;
export type { AnimatedIconHandle } from "@/components/its-hover";

/** itshover 没有对应图形的功能图标白名单。 */
export * from "./lucide";

// ---------------------------------------------------------------------------
// itshover 图标（导出名保持与 lucide 一致）
// ---------------------------------------------------------------------------

export const X: IconComponent = XIcon;
export const Copy: IconComponent = CopyIcon;
export const ClipboardCopy: IconComponent = CopyIcon;
export const RefreshCw: IconComponent = RefreshIcon;
export const RotateCw: IconComponent = RefreshIcon;
export const RotateCcw: IconComponent = RefreshIcon;
export const ChevronRight: IconComponent = RightChevron;
export const ChevronDown: IconComponent = DownChevron;
export const Check: IconComponent = CheckedIcon;
export const CheckCircle2: IconComponent = CheckedIcon;
export const CircleCheck: IconComponent = CheckedIcon;
export const SquareCheck: IconComponent = CheckedIcon;
export const SquareCheckBig: IconComponent = CheckedIcon;
export const Trash2: IconComponent = TrashIcon;
export const Search: IconComponent = MagnifierIcon;
export const Pencil: IconComponent = PenIcon;
export const TriangleAlert: IconComponent = TriangleAlertIcon;
export const AlertTriangle: IconComponent = TriangleAlertIcon;
export const AlertCircle: IconComponent = TriangleAlertIcon;
export const PlugZap: IconComponent = PlugConnectedIcon;
export const Plug: IconComponent = PlugConnectedIcon;
export const Unplug: IconComponent = PlugConnectedXIcon;
export const FileCode2: IconComponent = CodeXmlIcon;
export const FileJson: IconComponent = CodeXmlIcon;
export const History: IconComponent = HistoryCircleIcon;
export const SquareTerminal: IconComponent = TerminalIcon;
export const Terminal: IconComponent = TerminalIcon;
export const TerminalSquare: IconComponent = TerminalIcon;
export const Boxes: IconComponent = StackIcon;
export const Box: IconComponent = StackIcon;
export const Play: IconComponent = PlayerIcon;
export const ShieldCheck: IconComponent = ShieldCheckBase;
export const Star: IconComponent = StarIcon;
export const Eye: IconComponent = EyeIcon;
export const EyeOff: IconComponent = EyeOffIcon;
export const FileDown: IconComponent = DownloadIcon;
export const Download: IconComponent = DownloadIcon;
export const ArrowDownToLine: IconComponent = DownloadIcon;
export const House: IconComponent = HomeIcon;
export const Save: IconComponent = SaveIcon;
export const WifiOff: IconComponent = WifiOffIcon;
export const Cpu: IconComponent = CpuIcon;
export const Globe: IconComponent = GlobeIcon;
export const Maximize2: IconComponent = ExpandIcon;
export const Rocket: IconComponent = RocketIcon;
export const Settings: IconComponent = GearIcon;
export const Sparkles: IconComponent = SparklesIcon;
export const ArrowRight: IconComponent = ArrowNarrowRightIcon;
export const ArrowUpFromLine: IconComponent = UploadIcon;
export const Upload: IconComponent = UploadIcon;
export const FileUp: IconComponent = UploadIcon;
export const CircleHelp: IconComponent = QuestionMark;
export const Clock: IconComponent = ClockIcon;
export const Container: IconComponent = DockerIcon;
export const Gauge: IconComponent = GaugeIcon;
export const Info: IconComponent = InfoCircleIcon;
export const Layers: IconComponent = LayersIcon;
export const LayoutGrid: IconComponent = LayoutDashboardIcon;
export const ListOrdered: IconComponent = UnorderedListIcon;
export const Lock: IconComponent = LockIcon;
export const Moon: IconComponent = MoonIcon;
export const MoreHorizontal: IconComponent = DotsHorizontalIcon;
export const PanelRightClose: IconComponent = LayoutSidebarRightCollapseIcon;
export const PanelLeftOpen: IconComponent = LayoutSidebarRightIcon;
export const VideoOff: IconComponent = CameraOffIcon;
export const FileText: IconComponent = FileDescriptionIcon;
export const Filter: IconComponent = FilterIcon;

// ---------------------------------------------------------------------------
// 手写 SVG 图标：itshover / lucide 均无同风格图形的自有图标
// ---------------------------------------------------------------------------

export { DatabaseDuotoneIcon } from "./database-duotone-icon";
import { DatabaseDuotoneIcon } from "./database-duotone-icon";
export const DatabaseDuotone: IconComponent = DatabaseDuotoneIcon;

// ---------------------------------------------------------------------------
// 方向变体：itshover 只提供 `right-chevron` / `down-chevron`，左/上方向由旋转得到
// ---------------------------------------------------------------------------

export const ChevronLeft: IconComponent = ({ className, ...rest }) => (
  <RightChevron className={cn("rotate-180", className)} {...rest} />
);
export const ChevronsLeft: IconComponent = ({ className, ...rest }) => (
  <RightChevron className={cn("rotate-180", className)} {...rest} />
);
export const ChevronUp: IconComponent = ({ className, ...rest }) => (
  <DownChevron className={cn("rotate-180", className)} {...rest} />
);

// ---------------------------------------------------------------------------
// 导航/模块专属图标：itshover 命名语义更准（一个图标可能对应多个业务名），
// 需要原名的场景从同一入口取，避免再直接引 @/components/its-hover。
// ---------------------------------------------------------------------------

export {
  CommandCenterIcon,
  FileDescriptionIcon,
  GearIcon,
  RocketIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Stack3Icon,
  StackIcon,
  TerminalIcon,
  UnorderedListIcon,
  WorldIcon,
} from "@/components/its-hover";
