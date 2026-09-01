/**
 * File-kind recognition for the remote file browser.
 *
 * Drives three things: which icon (+color) a listing row shows, whether a
 * double-click opens the in-app editor, and which CodeMirror language it gets.
 * Extension-based, case-insensitive; anything unknown falls back to a generic
 * file icon and stays unopenable.
 */
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Braces,
  Database,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Film,
  Music,
  Settings2,
} from "lucide-react";

export type FileCategory =
  | "code"
  | "text"
  | "image"
  | "pdf"
  | "sheet"
  | "doc"
  | "archive"
  | "video"
  | "audio"
  | "binary"
  | "other";

export interface FileKindInfo {
  category: FileCategory;
  /** Icon shown in listings and dialogs. */
  icon: LucideIcon;
  /** Tailwind text color for the icon. */
  color: string;
  /** Human-readable label, e.g. used in tooltips. */
  label: string;
  /** CodeMirror language id when the file is editable code. */
  language?: EditorLanguage;
}

export type EditorLanguage =
  | "sql"
  | "html"
  | "javascript"
  | "typescript"
  | "jsx"
  | "java"
  | "json"
  | "css"
  | "python"
  | "markdown";

const KINDS: Record<string, Omit<FileKindInfo, "category"> & { category: FileCategory }> = {
  // Code / config
  sql: { category: "code", icon: Database, color: "text-emerald-400", label: "SQL", language: "sql" },
  html: { category: "code", icon: FileCode2, color: "text-orange-400", label: "HTML", language: "html" },
  htm: { category: "code", icon: FileCode2, color: "text-orange-400", label: "HTML", language: "html" },
  xml: { category: "code", icon: Braces, color: "text-orange-300", label: "XML", language: "html" },
  vue: { category: "code", icon: FileCode2, color: "text-emerald-300", label: "Vue", language: "html" },
  js: { category: "code", icon: FileCode2, color: "text-yellow-400", label: "JavaScript", language: "javascript" },
  mjs: { category: "code", icon: FileCode2, color: "text-yellow-400", label: "JavaScript", language: "javascript" },
  cjs: { category: "code", icon: FileCode2, color: "text-yellow-400", label: "JavaScript", language: "javascript" },
  jsx: { category: "code", icon: FileCode2, color: "text-sky-400", label: "JSX", language: "jsx" },
  ts: { category: "code", icon: FileCode2, color: "text-blue-400", label: "TypeScript", language: "typescript" },
  tsx: { category: "code", icon: FileCode2, color: "text-blue-400", label: "TSX", language: "jsx" },
  json: { category: "code", icon: Braces, color: "text-amber-400", label: "JSON", language: "json" },
  java: { category: "code", icon: FileType2, color: "text-red-400", label: "Java", language: "java" },
  css: { category: "code", icon: FileCode2, color: "text-sky-300", label: "CSS", language: "css" },
  scss: { category: "code", icon: FileCode2, color: "text-pink-400", label: "SCSS", language: "css" },
  less: { category: "code", icon: FileCode2, color: "text-indigo-300", label: "Less", language: "css" },
  py: { category: "code", icon: FileCode2, color: "text-sky-400", label: "Python", language: "python" },
  sh: { category: "code", icon: Settings2, color: "text-neutral-300", label: "Shell" },
  bash: { category: "code", icon: Settings2, color: "text-neutral-300", label: "Shell" },
  yml: { category: "code", icon: Settings2, color: "text-violet-300", label: "YAML" },
  yaml: { category: "code", icon: Settings2, color: "text-violet-300", label: "YAML" },
  toml: { category: "code", icon: Settings2, color: "text-neutral-300", label: "TOML" },
  ini: { category: "code", icon: Settings2, color: "text-neutral-300", label: "INI" },
  conf: { category: "code", icon: Settings2, color: "text-neutral-300", label: "配置" },
  cfg: { category: "code", icon: Settings2, color: "text-neutral-300", label: "配置" },
  env: { category: "code", icon: Settings2, color: "text-neutral-300", label: "环境变量" },
  properties: { category: "code", icon: Settings2, color: "text-neutral-300", label: "Properties" },
  go: { category: "code", icon: FileCode2, color: "text-cyan-400", label: "Go" },
  rs: { category: "code", icon: FileCode2, color: "text-orange-400", label: "Rust" },
  c: { category: "code", icon: FileCode2, color: "text-blue-300", label: "C" },
  h: { category: "code", icon: FileCode2, color: "text-blue-300", label: "C 头文件" },
  cpp: { category: "code", icon: FileCode2, color: "text-blue-400", label: "C++" },
  hpp: { category: "code", icon: FileCode2, color: "text-blue-400", label: "C++ 头文件" },
  cs: { category: "code", icon: FileCode2, color: "text-green-400", label: "C#" },
  php: { category: "code", icon: FileCode2, color: "text-indigo-400", label: "PHP" },
  rb: { category: "code", icon: FileCode2, color: "text-red-400", label: "Ruby" },

  // Text / docs
  md: { category: "text", icon: FileText, color: "text-neutral-300", label: "Markdown", language: "markdown" },
  markdown: { category: "text", icon: FileText, color: "text-neutral-300", label: "Markdown", language: "markdown" },
  txt: { category: "text", icon: FileText, color: "text-neutral-400", label: "文本" },
  log: { category: "text", icon: FileText, color: "text-neutral-400", label: "日志" },
  csv: { category: "text", icon: FileSpreadsheet, color: "text-green-400", label: "CSV" },

  // Rich / binary categories
  pdf: { category: "pdf", icon: FileText, color: "text-red-400", label: "PDF" },
  xls: { category: "sheet", icon: FileSpreadsheet, color: "text-green-500", label: "Excel" },
  xlsx: { category: "sheet", icon: FileSpreadsheet, color: "text-green-500", label: "Excel" },
  doc: { category: "doc", icon: FileText, color: "text-blue-400", label: "Word" },
  docx: { category: "doc", icon: FileText, color: "text-blue-400", label: "Word" },
  ppt: { category: "doc", icon: FileText, color: "text-orange-400", label: "PPT" },
  pptx: { category: "doc", icon: FileText, color: "text-orange-400", label: "PPT" },
  png: { category: "image", icon: FileImage, color: "text-purple-400", label: "图片" },
  jpg: { category: "image", icon: FileImage, color: "text-purple-400", label: "图片" },
  jpeg: { category: "image", icon: FileImage, color: "text-purple-400", label: "图片" },
  gif: { category: "image", icon: FileImage, color: "text-purple-400", label: "图片" },
  svg: { category: "image", icon: FileImage, color: "text-purple-400", label: "SVG" },
  webp: { category: "image", icon: FileImage, color: "text-purple-400", label: "图片" },
  ico: { category: "image", icon: FileImage, color: "text-purple-400", label: "图标" },
  zip: { category: "archive", icon: FileArchive, color: "text-amber-400", label: "压缩包" },
  tar: { category: "archive", icon: FileArchive, color: "text-amber-400", label: "压缩包" },
  gz: { category: "archive", icon: FileArchive, color: "text-amber-400", label: "压缩包" },
  tgz: { category: "archive", icon: FileArchive, color: "text-amber-400", label: "压缩包" },
  rar: { category: "archive", icon: FileArchive, color: "text-amber-400", label: "压缩包" },
  "7z": { category: "archive", icon: FileArchive, color: "text-amber-400", label: "压缩包" },
  jar: { category: "archive", icon: Archive, color: "text-red-300", label: "JAR" },
  war: { category: "archive", icon: Archive, color: "text-red-300", label: "WAR" },
  mp4: { category: "video", icon: Film, color: "text-rose-400", label: "视频" },
  mkv: { category: "video", icon: Film, color: "text-rose-400", label: "视频" },
  mov: { category: "video", icon: Film, color: "text-rose-400", label: "视频" },
  avi: { category: "video", icon: Film, color: "text-rose-400", label: "视频" },
  mp3: { category: "audio", icon: Music, color: "text-pink-400", label: "音频" },
  wav: { category: "audio", icon: Music, color: "text-pink-400", label: "音频" },
  flac: { category: "audio", icon: Music, color: "text-pink-400", label: "音频" },
};

const GENERIC: FileKindInfo = {
  category: "other",
  icon: FileIcon,
  color: "text-fg-subtle",
  label: "文件",
};

/** Dotfiles like `.env` / `.gitignore` map by their full name first. */
const DOTFILE_KINDS: Record<string, FileKindInfo> = {
  ".env": KINDS.env,
  ".gitignore": { ...KINDS.txt, label: "Git" },
  ".gitattributes": { ...KINDS.txt, label: "Git" },
  ".bashrc": { ...KINDS.sh, label: "Shell 配置" },
  ".zshrc": { ...KINDS.sh, label: "Shell 配置" },
  ".profile": { ...KINDS.sh, label: "Shell 配置" },
  dockerfile: { ...KINDS.sh, label: "Dockerfile" },
  makefile: { category: "code", icon: Settings2, color: "text-neutral-300", label: "Makefile" },
};

/** Recognizes a file name (e.g. from a listing row). */
export function fileKind(name: string): FileKindInfo {
  const lower = name.toLowerCase();

  // Full-name matches first (Dockerfile, .env, Makefile, …).
  const full = DOTFILE_KINDS[lower];
  if (full) return full;

  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return GENERIC; // no extension (or dotfile with no table entry)
  return KINDS[lower.slice(dot + 1)] ?? GENERIC;
}

/** True when double-click should open the in-app editor. */
export function isEditableKind(name: string): boolean {
  const kind = fileKind(name);
  return kind.category === "code" || kind.category === "text";
}
