//! 通用树解析：按缩进/树线字符还原层级（`tree`、`pstree`、配置嵌套）。
//!
//! 输出是**扁平列表 + depth**，前端按 depth 缩进渲染 —— 比嵌套结构更好做
//! 虚拟滚动与筛选，也避免递归深度问题。

/// 一次缩进等于几个空格（`tree` 常见 4，`pstree` 常见 2 或 4）。
const DEFAULT_INDENT: usize = 4;

/// 计算一行的缩进层级：树线字符优先，否则按前导空格数换算。
fn depth_of(line: &str) -> usize {
    let expanded = line
        .replace("│", " ")
        .replace("|", " ")
        .replace("├──", "    ")
        .replace("└──", "    ")
        .replace("├─", "  ")
        .replace("└─", "  ")
        .replace("──", "  ");
    let leading = expanded.len() - expanded.trim_start().len();
    leading / DEFAULT_INDENT
}

/// 取掉树线前缀后的可读标签。
fn label_of(line: &str) -> String {
    let trimmed = line.trim_start();
    let cleaned = trimmed
        .trim_start_matches("├──")
        .trim_start_matches("└──")
        .trim_start_matches("├─")
        .trim_start_matches("└─")
        .trim_start_matches("──")
        .trim_start_matches("- ")
        .trim();
    cleaned.to_string()
}

/// 文本树 → 统一 tree 行（`{label, depth, detail}`）。
pub fn parse_tree_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        // `tree` 的统计尾行（"3 directories, 5 files"）不是节点。
        .filter(|line| !line.trim().contains("directories,"))
        .map(|line| {
            serde_json::json!({
                "label": label_of(line),
                "depth": depth_of(line),
                "detail": "",
            })
        })
        .collect()
}
