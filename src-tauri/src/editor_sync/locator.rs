//! 本地编辑器探测（Windows 为主，兼容 macOS/Linux 的 PATH 探测）。
//!
//! 原则：只做**存在性探测**，绝不启动进程来验证（不弹窗、无副作用）。
//! 找不到的编辑器返回 `available: false`，前端不展示——绝不猜测。

use super::model::EditorInfo;

/// 一个编辑器的探测描述：候选可执行文件名与常见安装子目录。
struct EditorSpec {
    id: &'static str,
    name: &'static str,
    /// 优先级从高到低：`.exe`（可直接 spawn）在 `.cmd`（需经 cmd 转发）之前。
    exe_names: &'static [&'static str],
    /// 在 `LOCALAPPDATA\Programs`、`Program Files`、`Program Files (x86)` 下
    /// 依次尝试的子目录。
    rel_dirs: &'static [&'static str],
    /// macOS/Linux 的 PATH 候选命令名。
    unix_names: &'static [&'static str],
}

const EDITORS: &[EditorSpec] = &[
    EditorSpec {
        id: "vscode",
        name: "VS Code",
        exe_names: &["Code.exe", "code.cmd"],
        rel_dirs: &["Microsoft VS Code"],
        unix_names: &["code"],
    },
    EditorSpec {
        id: "cursor",
        name: "Cursor",
        exe_names: &["Cursor.exe", "cursor.cmd"],
        rel_dirs: &["cursor"],
        unix_names: &["cursor"],
    },
    EditorSpec {
        id: "windsurf",
        name: "Windsurf",
        exe_names: &["Windsurf.exe", "windsurf.cmd"],
        rel_dirs: &["windsurf"],
        unix_names: &["windsurf"],
    },
    EditorSpec {
        id: "trae",
        name: "Trae",
        exe_names: &["Trae.exe", "trae.cmd"],
        rel_dirs: &["Trae CN", "Trae"],
        unix_names: &["trae"],
    },
    EditorSpec {
        id: "codebuddy",
        name: "CodeBuddy",
        exe_names: &["CodeBuddy.exe", "codebuddy.cmd"],
        rel_dirs: &["CodeBuddy"],
        unix_names: &["codebuddy"],
    },
];

/// Windows 下常见的编辑器安装根目录集合（存在性检查时逐个尝试）。
#[cfg(windows)]
fn install_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    let mut push_env = |key: &str, sub: &str| {
        if let Ok(value) = std::env::var(key) {
            let root = std::path::PathBuf::from(value).join(sub);
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    };
    push_env("LOCALAPPDATA", "Programs");
    push_env("ProgramFiles", "");
    push_env("ProgramFiles(x86)", "");
    push_env("LOCALAPPDATA", "");
    roots
}

/// 在 PATH 里搜索可执行文件（Windows 逐个试候选名；Unix 直接试命令名）。
#[cfg(windows)]
fn search_path(exe_names: &[&str]) -> Option<std::path::PathBuf> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(';').filter(|d| !d.is_empty()) {
        for name in exe_names {
            let candidate = std::path::Path::new(dir).join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn search_path(unix_names: &[&str]) -> Option<std::path::PathBuf> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        for name in unix_names {
            let candidate = std::path::Path::new(dir).join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 探测单个编辑器，返回可执行文件路径。
pub fn locate(spec: &EditorSpec) -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        for root in install_roots() {
            for rel in spec.rel_dirs {
                for exe in spec.exe_names {
                    let candidate = root.join(rel).join(exe);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
        search_path(spec.exe_names)
    }
    #[cfg(not(windows))]
    {
        search_path(spec.unix_names)
    }
}

/// 探测全部已知编辑器（顺序即前端展示顺序）。
pub fn list_editors() -> Vec<EditorInfo> {
    EDITORS
        .iter()
        .map(|spec| {
            let path = locate(spec).map(|p| p.to_string_lossy().to_string());
            EditorInfo {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                available: path.is_some(),
                path,
            }
        })
        .collect()
}

/// 按 id 找到已安装编辑器的可执行路径。
pub fn find_editor(editor_id: &str) -> Option<(String, std::path::PathBuf)> {
    EDITORS
        .iter()
        .find(|spec| spec.id == editor_id)
        .and_then(|spec| locate(spec).map(|path| (spec.name.to_string(), path)))
}

/// 启动编辑器进程（不等待退出）。
///
/// `.cmd`/`.bat` 无法被 `CreateProcess` 直接执行，经 `cmd /C` 转发并隐藏
/// 控制台窗口；`.exe` 直接 spawn。
pub fn spawn_editor(exe: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let lower = exe.to_string_lossy().to_ascii_lowercase();
        let command = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", &exe.to_string_lossy(), &target.to_string_lossy()])
                .creation_flags(CREATE_NO_WINDOW);
            cmd
        } else {
            let mut cmd = std::process::Command::new(exe);
            cmd.arg(target).creation_flags(CREATE_NO_WINDOW);
            cmd
        };
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("启动编辑器失败：{error}"))
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(exe)
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("启动编辑器失败：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_editors_covers_known_ids() {
        let editors = list_editors();
        let ids: Vec<&str> = editors.iter().map(|e| e.id.as_str()).collect();
        for expected in ["vscode", "cursor", "windsurf", "trae", "codebuddy"] {
            assert!(ids.contains(&expected), "缺少编辑器 {expected}");
        }
        // 未安装时 available=false 且 path=None，绝不伪造路径。
        for editor in &editors {
            if !editor.available {
                assert!(editor.path.is_none(), "{} 未安装却给了路径", editor.id);
            }
            if editor.available {
                assert!(std::path::Path::new(editor.path.as_ref().unwrap()).is_file());
            }
        }
    }

    #[test]
    fn find_editor_unknown_id_is_none() {
        assert!(find_editor("notepad++").is_none());
    }
}
