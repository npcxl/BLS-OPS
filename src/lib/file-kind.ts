/**
 * File-kind recognition for the remote file browser.
 *
 * Drives three things: which icon a listing row shows, whether a double-click
 * opens the in-app editor, and which CodeMirror language it gets.
 *
 * Recognition is decoupled from rendering: a kind carries a stable `iconKey`
 * (`FileIconKey`) and the icon layer resolves that key against the bundled,
 * fully-offline vscode-icons set (`src/lib/icons/vscode-file-icons.ts`).
 * Swapping icon libraries never touches this file.
 *
 * `label` 是英文 key（natural keys，模块级常量不能调 hook），渲染处统一
 * `t(label)` —— 未命中的 key（如 "Dockerfile"）原样返回。
 *
 * Matching is case-insensitive. Files (`kind !== "directory"`) match in order:
 *   1. exact file name — Dockerfile, .env, package.json, … and `.ssh` **as a
 *      file**
 *   2. name rules — `*.ssh`, `dockerfile.*`, `compose*.yml`, `id_*`, `.env.*`
 *   3. extension table
 *   4. generic fallback
 * Directories match by exact name against special folders only; `.ssh` the
 * *directory* deliberately stays a plain folder. Which path runs is decided
 * by the backend's `entry.kind`, never by the name alone.
 */

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

/**
 * Stable icon identifiers.
 *
 * Rendering data lives in `src/lib/icons/vscode-file-icons.ts` (generated),
 * which must provide an entry for every key — enforced by
 * `Record<FileIconKey, …>` at build time.
 */
export type FileIconKey =
  // generic
  | "file"
  | "folder"
  // special folders
  | "folder-git"
  | "folder-github"
  | "folder-node"
  | "folder-src"
  | "folder-dist"
  | "folder-docker"
  | "folder-nginx"
  | "folder-logs"
  | "folder-config"
  | "folder-backup"
  // ssh & security
  | "ssh"
  | "ssh-key"
  | "ssh-config"
  | "key"
  | "certificate"
  // ops & deployment
  | "docker"
  | "nginx"
  | "systemd"
  | "config"
  | "makefile"
  // package managers & build
  | "npm"
  | "yarn"
  | "pnpm"
  | "lock"
  | "git"
  | "nodejs"
  | "maven"
  | "gradle"
  | "cmake"
  // languages
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "java"
  | "rust"
  | "go"
  | "python"
  | "php"
  | "ruby"
  | "csharp"
  | "c"
  | "cpp"
  | "vue"
  | "html"
  | "css"
  // structured data
  | "json"
  | "xml"
  | "yaml"
  | "toml"
  | "ini"
  | "env"
  // text & docs
  | "shell"
  | "markdown"
  | "sql"
  | "text"
  | "log"
  | "csv"
  | "pdf"
  | "sheet"
  | "doc"
  | "slides"
  // media & binaries
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "jar"
  | "package"
  | "binary"
  | "database";

export interface FileKindInfo {
  iconKey: FileIconKey;
  category: FileCategory;
  /** Human-readable label, e.g. used in tooltips. */
  label: string;
  /** CodeMirror language id when the file is editable code. */
  language?: EditorLanguage;
}

/** What recognition needs: a slice of the backend listing entry. */
export interface FileKindInput {
  name: string;
  /** Backend entry kind: `directory` | `file` | `symlink` | `other`. */
  kind: string;
  /** Absolute path when the caller has one (reserved for path-aware rules). */
  path?: string;
}

// -- fallbacks & shared kinds -------------------------------------------------

const GENERIC: FileKindInfo = { iconKey: "file", category: "other", label: "File" };
const GENERIC_DIR: FileKindInfo = { iconKey: "folder", category: "other", label: "Folder" };

const SSH_FILE: FileKindInfo = { iconKey: "ssh", category: "code", label: "SSH" };
const SSH_KEY: FileKindInfo = { iconKey: "ssh-key", category: "code", label: "SSH Key" };
const ENV_KIND: FileKindInfo = { iconKey: "env", category: "code", label: "Environment Variables" };
const DOCKER_KIND: FileKindInfo = { iconKey: "docker", category: "code", label: "Docker" };

// -- extension table -----------------------------------------------------------

const EXT_KINDS: Record<string, FileKindInfo> = {
  // Code / config
  sql: { iconKey: "sql", category: "code", label: "SQL", language: "sql" },
  html: { iconKey: "html", category: "code", label: "HTML", language: "html" },
  htm: { iconKey: "html", category: "code", label: "HTML", language: "html" },
  xml: { iconKey: "xml", category: "code", label: "XML", language: "html" },
  vue: { iconKey: "vue", category: "code", label: "Vue", language: "html" },
  js: { iconKey: "javascript", category: "code", label: "JavaScript", language: "javascript" },
  mjs: { iconKey: "javascript", category: "code", label: "JavaScript", language: "javascript" },
  cjs: { iconKey: "javascript", category: "code", label: "JavaScript", language: "javascript" },
  jsx: { iconKey: "jsx", category: "code", label: "JSX", language: "jsx" },
  ts: { iconKey: "typescript", category: "code", label: "TypeScript", language: "typescript" },
  tsx: { iconKey: "tsx", category: "code", label: "TSX", language: "jsx" },
  json: { iconKey: "json", category: "code", label: "JSON", language: "json" },
  java: { iconKey: "java", category: "code", label: "Java", language: "java" },
  css: { iconKey: "css", category: "code", label: "CSS", language: "css" },
  scss: { iconKey: "css", category: "code", label: "SCSS", language: "css" },
  less: { iconKey: "css", category: "code", label: "Less", language: "css" },
  py: { iconKey: "python", category: "code", label: "Python", language: "python" },
  sh: { iconKey: "shell", category: "code", label: "Shell" },
  bash: { iconKey: "shell", category: "code", label: "Shell" },
  yml: { iconKey: "yaml", category: "code", label: "YAML" },
  yaml: { iconKey: "yaml", category: "code", label: "YAML" },
  toml: { iconKey: "toml", category: "code", label: "TOML" },
  ini: { iconKey: "ini", category: "code", label: "INI" },
  conf: { iconKey: "config", category: "code", label: "Config" },
  cfg: { iconKey: "config", category: "code", label: "Config" },
  env: ENV_KIND,
  properties: { iconKey: "ini", category: "code", label: "Properties" },
  go: { iconKey: "go", category: "code", label: "Go" },
  rs: { iconKey: "rust", category: "code", label: "Rust" },
  c: { iconKey: "c", category: "code", label: "C" },
  h: { iconKey: "c", category: "code", label: "C Header" },
  cpp: { iconKey: "cpp", category: "code", label: "C++" },
  hpp: { iconKey: "cpp", category: "code", label: "C++ Header" },
  cs: { iconKey: "csharp", category: "code", label: "C#" },
  php: { iconKey: "php", category: "code", label: "PHP" },
  rb: { iconKey: "ruby", category: "code", label: "Ruby" },
  lock: { iconKey: "lock", category: "code", label: "Lock File" },

  // SSH & security
  pub: { iconKey: "ssh-key", category: "code", label: "SSH Public Key" },
  pem: { iconKey: "key", category: "code", label: "PEM" },
  key: { iconKey: "key", category: "code", label: "Key" },
  crt: { iconKey: "certificate", category: "code", label: "Certificate" },
  cer: { iconKey: "certificate", category: "code", label: "Certificate" },
  pfx: { iconKey: "certificate", category: "code", label: "Certificate" },
  p12: { iconKey: "certificate", category: "code", label: "Certificate" },

  // systemd units
  service: { iconKey: "systemd", category: "code", label: "systemd Service" },
  socket: { iconKey: "systemd", category: "code", label: "systemd Socket" },
  timer: { iconKey: "systemd", category: "code", label: "systemd Timer" },

  // Text / docs
  md: { iconKey: "markdown", category: "text", label: "Markdown", language: "markdown" },
  markdown: { iconKey: "markdown", category: "text", label: "Markdown", language: "markdown" },
  txt: { iconKey: "text", category: "text", label: "Text" },
  log: { iconKey: "log", category: "text", label: "Log" },
  csv: { iconKey: "csv", category: "text", label: "CSV" },

  // Rich / binary categories
  pdf: { iconKey: "pdf", category: "pdf", label: "PDF" },
  xls: { iconKey: "sheet", category: "sheet", label: "Excel" },
  xlsx: { iconKey: "sheet", category: "sheet", label: "Excel" },
  doc: { iconKey: "doc", category: "doc", label: "Word" },
  docx: { iconKey: "doc", category: "doc", label: "Word" },
  ppt: { iconKey: "slides", category: "doc", label: "PPT" },
  pptx: { iconKey: "slides", category: "doc", label: "PPT" },
  ods: { iconKey: "sheet", category: "sheet", label: "OpenDocument Spreadsheet" },
  odt: { iconKey: "doc", category: "doc", label: "OpenDocument Document" },
  odp: { iconKey: "slides", category: "doc", label: "OpenDocument Presentation" },
  rtf: { iconKey: "doc", category: "doc", label: "RTF" },
  png: { iconKey: "image", category: "image", label: "Image" },
  jpg: { iconKey: "image", category: "image", label: "Image" },
  jpeg: { iconKey: "image", category: "image", label: "Image" },
  jfif: { iconKey: "image", category: "image", label: "Image" },
  gif: { iconKey: "image", category: "image", label: "Image" },
  svg: { iconKey: "image", category: "image", label: "SVG" },
  webp: { iconKey: "image", category: "image", label: "Image" },
  bmp: { iconKey: "image", category: "image", label: "Bitmap" },
  avif: { iconKey: "image", category: "image", label: "Image" },
  tif: { iconKey: "image", category: "image", label: "TIFF" },
  tiff: { iconKey: "image", category: "image", label: "TIFF" },
  ico: { iconKey: "image", category: "image", label: "Icon" },
  zip: { iconKey: "archive", category: "archive", label: "Archive" },
  tar: { iconKey: "archive", category: "archive", label: "Archive" },
  gz: { iconKey: "archive", category: "archive", label: "Archive" },
  tgz: { iconKey: "archive", category: "archive", label: "Archive" },
  rar: { iconKey: "archive", category: "archive", label: "Archive" },
  "7z": { iconKey: "archive", category: "archive", label: "Archive" },
  jar: { iconKey: "jar", category: "archive", label: "JAR" },
  war: { iconKey: "jar", category: "archive", label: "WAR" },
  iso: { iconKey: "package", category: "archive", label: "Disc Image" },
  deb: { iconKey: "package", category: "archive", label: "Debian Package" },
  rpm: { iconKey: "package", category: "archive", label: "RPM Package" },
  mp4: { iconKey: "video", category: "video", label: "Video" },
  m4v: { iconKey: "video", category: "video", label: "Video" },
  mkv: { iconKey: "video", category: "video", label: "Video" },
  mov: { iconKey: "video", category: "video", label: "Video" },
  avi: { iconKey: "video", category: "video", label: "Video" },
  webm: { iconKey: "video", category: "video", label: "Video" },
  flv: { iconKey: "video", category: "video", label: "Video" },
  mp3: { iconKey: "audio", category: "audio", label: "Audio" },
  wav: { iconKey: "audio", category: "audio", label: "Audio" },
  ogg: { iconKey: "audio", category: "audio", label: "Audio" },
  oga: { iconKey: "audio", category: "audio", label: "Audio" },
  m4a: { iconKey: "audio", category: "audio", label: "Audio" },
  aac: { iconKey: "audio", category: "audio", label: "Audio" },
  opus: { iconKey: "audio", category: "audio", label: "Audio" },
  flac: { iconKey: "audio", category: "audio", label: "Audio" },
  exe: { iconKey: "binary", category: "binary", label: "Executable" },
  dll: { iconKey: "binary", category: "binary", label: "Shared Library" },
  so: { iconKey: "binary", category: "binary", label: "Shared Library" },
  dylib: { iconKey: "binary", category: "binary", label: "Shared Library" },
  bin: { iconKey: "binary", category: "binary", label: "Binary" },
  db: { iconKey: "database", category: "binary", label: "Database" },
  sqlite: { iconKey: "database", category: "binary", label: "SQLite" },
  sqlite3: { iconKey: "database", category: "binary", label: "SQLite" },
};

// -- exact file names (files only; directories never reach this table) ---------

const EXACT_KINDS: Record<string, FileKindInfo> = {
  // A file literally named `.ssh` — some tools store connection profiles as
  // `.ssh` files. The *directory* named `.ssh` never gets here: `fileKind`
  // routes directories by `kind` first, and it stays a plain folder.
  ".ssh": SSH_FILE,
  ".env": ENV_KIND,
  ".gitignore": { iconKey: "git", category: "text", label: "Git" },
  ".gitattributes": { iconKey: "git", category: "text", label: "Git" },
  ".dockerignore": { iconKey: "docker", category: "text", label: "Docker" },
  ".bashrc": { iconKey: "shell", category: "code", label: "Shell Config" },
  ".zshrc": { iconKey: "shell", category: "code", label: "Shell Config" },
  ".profile": { iconKey: "shell", category: "code", label: "Shell Config" },
  makefile: { iconKey: "makefile", category: "code", label: "Makefile" },
  ssh_config: { iconKey: "ssh-config", category: "code", label: "SSH Config" },
  sshd_config: { iconKey: "ssh-config", category: "code", label: "sshd Config" },
  authorized_keys: { iconKey: "ssh-key", category: "code", label: "SSH Authorized Keys" },
  known_hosts: { iconKey: "ssh-key", category: "code", label: "SSH Known Hosts" },
  "nginx.conf": { iconKey: "nginx", category: "code", label: "Nginx Config" },
  "supervisord.conf": { iconKey: "config", category: "code", label: "Supervisor" },
  "ecosystem.config.js": { iconKey: "nodejs", category: "code", label: "PM2" },
  "package.json": { iconKey: "npm", category: "code", label: "package.json", language: "json" },
  "package-lock.json": { iconKey: "npm", category: "code", label: "npm lock", language: "json" },
  "pnpm-lock.yaml": { iconKey: "pnpm", category: "code", label: "pnpm lock" },
  "yarn.lock": { iconKey: "yarn", category: "code", label: "yarn lock" },
  "cargo.toml": { iconKey: "rust", category: "code", label: "Cargo.toml" },
  "cargo.lock": { iconKey: "lock", category: "code", label: "Cargo.lock" },
  "go.mod": { iconKey: "go", category: "code", label: "go.mod" },
  "go.sum": { iconKey: "go", category: "code", label: "go.sum" },
  "requirements.txt": { iconKey: "python", category: "code", label: "Python Dependencies" },
  "pyproject.toml": { iconKey: "python", category: "code", label: "pyproject" },
  "pom.xml": { iconKey: "maven", category: "code", label: "Maven", language: "html" },
  "build.gradle": { iconKey: "gradle", category: "code", label: "Gradle" },
  "build.gradle.kts": { iconKey: "gradle", category: "code", label: "Gradle (Kotlin)" },
  "cmakelists.txt": { iconKey: "cmake", category: "code", label: "CMake" },
};

// -- name rules (between exact names and the extension table) -------------------

const NAME_RULES: ReadonlyArray<(lower: string) => FileKindInfo | null> = [
  // `production.ssh` etc. — a file named just `.ssh` was matched above. Files
  // only: directories are routed by `kind` before any of these run.
  (name) => (name.endsWith(".ssh") ? SSH_FILE : null),
  (name) => (/^dockerfile(\..+)?$/.test(name) ? { ...DOCKER_KIND, label: "Dockerfile" } : null),
  (name) => (/^(docker-)?compose(\..+)?\.ya?ml$/.test(name) ? { ...DOCKER_KIND, label: "Compose" } : null),
  (name) => (/^id_(rsa|dsa|ecdsa|ed25519)(_[a-z0-9]+)?$/.test(name) ? SSH_KEY : null),
  (name) => (/^\.env(\..+)?$/.test(name) ? ENV_KIND : null),
];

// -- special folders (exact names only) -----------------------------------------

const DIR_KINDS: Record<string, FileKindInfo> = {
  ".git": { iconKey: "folder-git", category: "other", label: "Folder" },
  ".github": { iconKey: "folder-github", category: "other", label: "Folder" },
  node_modules: { iconKey: "folder-node", category: "other", label: "Folder" },
  src: { iconKey: "folder-src", category: "other", label: "Folder" },
  dist: { iconKey: "folder-dist", category: "other", label: "Folder" },
  build: { iconKey: "folder-dist", category: "other", label: "Folder" },
  docker: { iconKey: "folder-docker", category: "other", label: "Folder" },
  nginx: { iconKey: "folder-nginx", category: "other", label: "Folder" },
  logs: { iconKey: "folder-logs", category: "other", label: "Folder" },
  log: { iconKey: "folder-logs", category: "other", label: "Folder" },
  config: { iconKey: "folder-config", category: "other", label: "Folder" },
  backup: { iconKey: "folder-backup", category: "other", label: "Folder" },
  backups: { iconKey: "folder-backup", category: "other", label: "Folder" },
};

/** Recognizes a listing entry — `kind` decides file vs folder, not the name. */
export function fileKind(input: FileKindInput): FileKindInfo {
  const lower = input.name.toLowerCase();

  // Directories only ever match by exact name. `.ssh` the directory is a
  // plain folder on purpose; files named `.ssh` are the SSH-flavored ones.
  if (input.kind === "directory") {
    return DIR_KINDS[lower] ?? GENERIC_DIR;
  }

  // Exact file names first (Dockerfile, .env, …, `.ssh` as a file).
  const exact = EXACT_KINDS[lower];
  if (exact) return exact;

  // Name rules: `*.ssh`, dockerfile*, compose*.yml, id_*, .env*.
  for (const rule of NAME_RULES) {
    const kind = rule(lower);
    if (kind) return kind;
  }

  // Extension table.
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return GENERIC; // no extension (or dotfile with no table entry)
  return EXT_KINDS[lower.slice(dot + 1)] ?? GENERIC;
}

/** True when double-click should open the in-app editor. */
export function isEditableKind(input: FileKindInput): boolean {
  const kind = fileKind(input);
  return kind.category === "code" || kind.category === "text";
}
