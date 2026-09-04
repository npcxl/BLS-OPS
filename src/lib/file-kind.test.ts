import { describe, expect, it } from "vitest";
import { fileKind, isEditableKind } from "./file-kind";

const file = (name: string, path?: string) => fileKind({ name, kind: "file", path });
const dir = (name: string, path?: string) => fileKind({ name, kind: "directory", path });

describe("fileKind: extensions", () => {
  it("recognizes the extensions the user called out", () => {
    expect(file("query.sql").label).toBe("SQL");
    expect(file("index.html").label).toBe("HTML");
    expect(file("app.js").label).toBe("JavaScript");
    expect(file("Main.java").label).toBe("Java");
    expect(file("report.pdf").category).toBe("pdf");
    expect(file("table.xlsx").category).toBe("sheet");
  });

  it("is case-insensitive", () => {
    expect(file("QUERY.SQL").label).toBe("SQL");
    expect(file("Photo.JPG").category).toBe("image");
  });

  it("falls back to a generic icon for unknown extensions", () => {
    expect(file("data.weird").iconKey).toBe("file");
    expect(file("noext").iconKey).toBe("file");
    // `lastIndexOf(".") <= 0` keeps "name." generic instead of crashing.
    expect(file("name.").iconKey).toBe("file");
  });
});

describe("fileKind: iconKey 契约（识别成功必须给出专属图标，不许再共用 Settings2）", () => {
  it("deployment files get their own icons", () => {
    expect(file("Dockerfile").iconKey).toBe("docker");
    expect(file("dockerfile.dev").iconKey).toBe("docker");
    expect(file("docker-compose.yml").iconKey).toBe("docker");
    expect(file("compose.yaml").iconKey).toBe("docker");
    expect(file("nginx.conf").iconKey).toBe("nginx");
    expect(file("app.service").iconKey).toBe("systemd");
    expect(file("app.socket").iconKey).toBe("systemd");
    expect(file("app.timer").iconKey).toBe("systemd");
    expect(file("supervisord.conf").iconKey).toBe("config");
    expect(file("ecosystem.config.js").iconKey).toBe("nodejs");
  });

  it("config formats stopped sharing one generic icon", () => {
    expect(file("application.yml").iconKey).toBe("yaml");
    expect(file("application.yaml").iconKey).toBe("yaml");
    expect(file("Cargo.toml").iconKey).toBe("rust");
    expect(file("server.ini").iconKey).toBe("ini");
    expect(file(".env").iconKey).toBe("env");
    expect(file(".env.production").iconKey).toBe("env");
  });

  it("project manifests are recognizable", () => {
    expect(file("package.json").iconKey).toBe("npm");
    expect(file("package-lock.json").iconKey).toBe("npm");
    expect(file("pnpm-lock.yaml").iconKey).toBe("pnpm");
    expect(file("yarn.lock").iconKey).toBe("yarn");
    expect(file("Cargo.toml").iconKey).toBe("rust");
    expect(file("go.mod").iconKey).toBe("go");
    expect(file("requirements.txt").iconKey).toBe("python");
    expect(file("pyproject.toml").iconKey).toBe("python");
    expect(file("pom.xml").iconKey).toBe("maven");
    expect(file("build.gradle").iconKey).toBe("gradle");
  });

  it("languages get language icons instead of FileCode2", () => {
    expect(file("main.rs").iconKey).toBe("rust");
    expect(file("main.go").iconKey).toBe("go");
    expect(file("main.py").iconKey).toBe("python");
    expect(file("app.tsx").iconKey).toBe("tsx");
    expect(file("Cargo.toml").label).toBe("Cargo.toml");
  });

  it("security files", () => {
    expect(file("server.pem").iconKey).toBe("key");
    expect(file("server.key").iconKey).toBe("key");
    expect(file("server.crt").iconKey).toBe("certificate");
    expect(file("server.cer").iconKey).toBe("certificate");
    expect(file("hostkey.pub").iconKey).toBe("ssh-key");
    expect(file("id_rsa").iconKey).toBe("ssh-key");
    expect(file("id_ed25519").iconKey).toBe("ssh-key");
  });

  it("special folders", () => {
    expect(dir(".git").iconKey).toBe("folder-git");
    expect(dir(".github").iconKey).toBe("folder-github");
    expect(dir("node_modules").iconKey).toBe("folder-node");
    expect(dir("src").iconKey).toBe("folder-src");
    expect(dir("dist").iconKey).toBe("folder-dist");
    expect(dir("logs").iconKey).toBe("folder-logs");
    expect(dir("backup").iconKey).toBe("folder-backup");
  });
});

describe("fileKind: 名为 .ssh 的文件（本次验收核心）", () => {
  it("a file named .ssh is SSH, not a generic file", () => {
    const kind = file(".ssh");
    expect(kind.iconKey).toBe("ssh");
    expect(kind.label).toBe("SSH");
  });

  it("*.ssh files are SSH too", () => {
    expect(file("production.ssh").iconKey).toBe("ssh");
  });

  it("a directory named .ssh stays a plain folder — kind decides, not the name", () => {
    expect(dir(".ssh").iconKey).toBe("folder");
  });

  it("symlinks follow the file path", () => {
    expect(fileKind({ name: ".ssh", kind: "symlink" }).iconKey).toBe("ssh");
    expect(fileKind({ name: ".ssh", kind: "symlink", path: "/root/.ssh" }).iconKey).toBe("ssh");
  });
});

describe("fileKind: dotfiles by full name", () => {
  it("keeps the established labels", () => {
    expect(file(".env").label).toBe("环境变量");
    expect(file("Dockerfile").label).toBe("Dockerfile");
    expect(file("Makefile").label).toBe("Makefile");
    expect(file(".gitignore").iconKey).toBe("git");
    expect(file(".dockerignore").iconKey).toBe("docker");
  });
});

describe("isEditableKind", () => {
  it("opens code and text files in the editor", () => {
    expect(isEditableKind({ name: "query.sql", kind: "file" })).toBe(true);
    expect(isEditableKind({ name: "nginx.conf", kind: "file" })).toBe(true);
    expect(isEditableKind({ name: "app.log", kind: "file" })).toBe(true);
    expect(isEditableKind({ name: "notes.txt", kind: "file" })).toBe(true);
    expect(isEditableKind({ name: ".ssh", kind: "file" })).toBe(true);
  });

  it("treats compressed dumps as archives, not editable text", () => {
    // schema.sql.gz is a gzip archive even though it contains SQL.
    expect(isEditableKind({ name: "schema.sql.gz", kind: "file" })).toBe(false);
  });

  it("does not offer editing for binary/rich types", () => {
    expect(isEditableKind({ name: "report.pdf", kind: "file" })).toBe(false);
    expect(isEditableKind({ name: "table.xlsx", kind: "file" })).toBe(false);
    expect(isEditableKind({ name: "photo.png", kind: "file" })).toBe(false);
    expect(isEditableKind({ name: "backup.zip", kind: "file" })).toBe(false);
  });

  it("never treats directories as editable, whatever they are named", () => {
    expect(isEditableKind({ name: "notes.txt", kind: "directory" })).toBe(false);
    expect(isEditableKind({ name: ".ssh", kind: "directory" })).toBe(false);
  });
});
