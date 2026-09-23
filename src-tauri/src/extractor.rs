//! 把选中的源码文件合并成「喂给 AI」的单文件包。
//!
//! 支持三种格式：markdown（默认，推荐）/ xml（类 repomix）/ plain（纯文本分隔）。
//! 支持一次合并多个项目：目录树以项目名为顶层，文件标题带项目前缀。
//! 输出包含：自定义提示词头部、统计信息、目录树、以及每个文件的带语言标注的代码块。

use crate::timefmt::now_string;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtractOptions {
    /// markdown | xml | plain
    pub format: String,
    /// 是否包含目录树
    pub include_tree: bool,
    /// 是否包含统计信息
    pub include_meta: bool,
    /// 自定义提示词 / 说明，放在最前面
    pub header: String,
    /// 单个文件大小上限（KB），超过则跳过
    pub max_file_kb: u64,
}

/// 一个待导出的项目
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    #[serde(default)]
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub selected: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBrief {
    pub name: String,
    pub file_count: usize,
    pub lines: usize,
    pub est_tokens: usize,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BundleResult {
    pub content: String,
    pub file_count: usize,
    pub project_count: usize,
    pub total_lines: usize,
    pub total_chars: usize,
    pub est_tokens: usize,
    pub skipped: Vec<String>,
    pub per_project: Vec<ProjectBrief>,
    pub generated_at: String,
}

/// 单个已读取的文件
struct Loaded {
    rel: String,
    content: String,
    lines: usize,
    lang: String,
    lossy: bool,
}

// `(async)`：合并导出要把每个选中文件整个读进内存，大包在主线程上会卡 UI
#[tauri::command(async)]
pub fn extract_bundle(
    projects: Vec<ProjectInput>,
    options: Option<ExtractOptions>,
) -> Result<BundleResult, String> {
    let opts = options.unwrap_or_default();
    let format = if opts.format.is_empty() {
        "markdown".to_string()
    } else {
        opts.format.to_lowercase()
    };
    let max_kb = if opts.max_file_kb == 0 {
        512
    } else {
        opts.max_file_kb
    };

    if projects.is_empty() {
        return Err("没有可导出的项目".to_string());
    }

    let generated_at = now_string();
    let multi = projects.len() > 1;

    let mut skipped: Vec<String> = Vec::new();
    // 按输入顺序分组，保持稳定
    let mut groups: Vec<(String, Vec<Loaded>)> = Vec::new();
    let mut per_project: Vec<ProjectBrief> = Vec::new();

    for p in &projects {
        let root_path = Path::new(&p.root);
        if !root_path.is_dir() {
            skipped.push(format!("{}（目录不存在，已跳过整个项目）", p.root));
            continue;
        }
        let name = if p.name.trim().is_empty() {
            root_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "project".to_string())
        } else {
            p.name.clone()
        };

        let mut paths: Vec<String> = p
            .selected
            .iter()
            .map(|s| s.replace('\\', "/"))
            .collect();
        paths.sort();
        paths.dedup();

        let mut loaded: Vec<Loaded> = Vec::new();
        let mut project_chars = 0usize;

        for rel in &paths {
            let abs = root_path.join(rel);
            let meta = match fs::metadata(&abs) {
                Ok(m) => m,
                Err(_) => {
                    skipped.push(format!("{}/{}（文件不存在）", name, rel));
                    continue;
                }
            };
            if meta.len() > max_kb * 1024 {
                skipped.push(format!(
                    "{}/{}（{} KB，超过 {} KB 上限）",
                    name,
                    rel,
                    meta.len() / 1024,
                    max_kb
                ));
                continue;
            }
            let bytes = match fs::read(&abs) {
                Ok(b) => b,
                Err(e) => {
                    skipped.push(format!("{}/{}（读取失败：{}）", name, rel, e));
                    continue;
                }
            };
            // 用借用的 from_utf8 探测，避免为了判编码把整个文件再克隆一份
            let lossy = std::str::from_utf8(&bytes).is_err();
            let content = String::from_utf8_lossy(&bytes).to_string();
            project_chars += content.chars().count();
            let lines = if content.is_empty() {
                0
            } else {
                content.lines().count().max(1)
            };
            let file_name = abs
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let ext = abs
                .extension()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let lang = lang_of(&ext, &file_name);

            loaded.push(Loaded {
                rel: rel.clone(),
                content,
                lines,
                lang,
                lossy,
            });
        }

        per_project.push(ProjectBrief {
            name: name.clone(),
            file_count: loaded.len(),
            lines: loaded.iter().map(|l| l.lines).sum(),
            est_tokens: ((project_chars as f64) / 3.6).ceil() as usize,
        });
        groups.push((name, loaded));
    }

    // 没有任何文件 → 给出明确原因，而不是生成空包
    let total_loaded: usize = groups.iter().map(|(_, v)| v.len()).sum();
    if total_loaded == 0 {
        let mut msg = "没有可导出的文件：所有选中项都被跳过或不存在".to_string();
        if !skipped.is_empty() {
            msg.push_str("。原因：");
            msg.push_str(&skipped.iter().take(5).cloned().collect::<Vec<_>>().join("；"));
        }
        return Err(msg);
    }

    // 目录树：多项目时以项目名为顶层
    let tree_paths: Vec<String> = groups
        .iter()
        .flat_map(|(name, files)| {
            files
                .iter()
                .map(move |f| format!("{}/{}", name, f.rel))
        })
        .collect();
    let tree_root = if multi {
        String::new()
    } else {
        groups[0].0.clone()
    };
    let tree_text = build_tree(&tree_root, &tree_paths);

    let body = match format.as_str() {
        "xml" => render_xml(&groups, &tree_text, opts.include_tree, multi),
        "plain" => render_plain(&groups, multi),
        _ => render_markdown(&groups, &tree_text, opts.include_tree, multi),
    };

    let total_lines: usize = groups.iter().flat_map(|(_, v)| v.iter()).map(|l| l.lines).sum();

    let mut out = String::new();
    if !opts.header.trim().is_empty() {
        out.push_str(opts.header.trim());
        out.push_str("\n\n");
    }
    if opts.include_meta {
        let names: Vec<String> = groups.iter().map(|(n, _)| n.clone()).collect();
        if multi {
            out.push_str(&format!(
                "> 项目：{}　|　文件数：{}　|　总行数：{}　|　生成于：{}\n\n",
                names.join("、"),
                total_loaded,
                total_lines,
                generated_at
            ));
        } else {
            out.push_str(&format!(
                "> 项目：`{}`　|　文件数：{}　|　总行数：{}　|　生成于：{}\n\n",
                names[0], total_loaded, total_lines, generated_at
            ));
        }
    }
    out.push_str(&body);

    if !skipped.is_empty() {
        out.push_str("\n\n<!-- 已跳过：\n");
        for s in &skipped {
            out.push_str(&format!("- {}\n", s));
        }
        out.push_str("-->\n");
    }

    let total_chars = out.chars().count();
    let est_tokens = estimate_tokens(&out);

    Ok(BundleResult {
        content: out,
        file_count: total_loaded,
        project_count: groups.len(),
        total_lines,
        total_chars,
        est_tokens,
        skipped,
        per_project,
        generated_at,
    })
}

#[tauri::command(async)]
pub fn save_text_file(path: String, content: String) -> Result<String, String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
        }
    }
    fs::write(&path, content).map_err(|e| format!("写入失败：{}", e))?;
    Ok(path)
}

// ---------------------------------------------------------------- 渲染

fn render_markdown(
    groups: &[(String, Vec<Loaded>)],
    tree: &str,
    include_tree: bool,
    multi: bool,
) -> String {
    let mut out = String::new();
    if include_tree && !tree.is_empty() {
        out.push_str("## 目录结构\n\n```text\n");
        out.push_str(tree);
        out.push_str("```\n\n---\n\n");
    }

    let mut n = 0usize;
    for (project, files) in groups {
        if files.is_empty() {
            continue;
        }
        if multi {
            out.push_str(&format!("## 项目：{}\n\n", project));
        }
        for f in files {
            n += 1;
            let display = if multi {
                format!("{}/{}", project, f.rel)
            } else {
                f.rel.clone()
            };
            let level = if multi { "###" } else { "##" };
            out.push_str(&format!("{} {}. `{}`\n\n", level, n, display));
            if f.lossy {
                out.push_str("> ⚠️ 该文件包含非 UTF-8 字节，已按替换字符展示。\n\n");
            }
            out.push_str(&format!("```{}\n", f.lang));
            out.push_str(f.content.trim_end_matches(['\n', '\r']));
            out.push_str("\n```\n\n");
        }
    }
    out
}

fn render_xml(
    groups: &[(String, Vec<Loaded>)],
    tree: &str,
    include_tree: bool,
    multi: bool,
) -> String {
    let mut out = String::new();
    out.push_str("<project_bundle>\n");
    if include_tree && !tree.is_empty() {
        out.push_str("<directory_tree>\n");
        out.push_str(tree);
        out.push_str("</directory_tree>\n");
    }
    for (project, files) in groups {
        if files.is_empty() {
            continue;
        }
        out.push_str(&format!("<project name=\"{}\">\n", escape_xml(project)));
        for f in files {
            let path = if multi {
                format!("{}/{}", project, f.rel)
            } else {
                f.rel.clone()
            };
            out.push_str(&format!(
                "<file path=\"{}\" language=\"{}\">\n",
                escape_xml(&path),
                escape_xml(&f.lang)
            ));
            let safe = f
                .content
                .trim_end_matches(['\n', '\r'])
                .replace("]]>", "]]]]><![CDATA[>");
            out.push_str("<![CDATA[\n");
            out.push_str(&safe);
            out.push_str("\n]]>\n</file>\n");
        }
        out.push_str("</project>\n");
    }
    out.push_str("</project_bundle>\n");
    out
}

fn render_plain(groups: &[(String, Vec<Loaded>)], multi: bool) -> String {
    let mut out = String::new();
    for (project, files) in groups {
        for f in files {
            let display = if multi {
                format!("{}/{}", project, f.rel)
            } else {
                f.rel.clone()
            };
            out.push_str(&format!(
                "{}\n{}\n{}\n\n",
                "=".repeat(78),
                display,
                "=".repeat(78)
            ));
            out.push_str(f.content.trim_end_matches(['\n', '\r']));
            out.push_str("\n\n");
        }
    }
    out
}

// ---------------------------------------------------------------- 工具

/// root_label 为空时不输出根行（多项目模式）
fn build_tree(root_label: &str, paths: &[String]) -> String {
    #[derive(Default)]
    struct Node {
        children: BTreeMap<String, Node>,
        is_file: bool,
    }

    fn render(node: &Node, prefix: &str, out: &mut String) {
        let items: Vec<(&String, &Node)> = node.children.iter().collect();
        let n = items.len();
        for (i, (name, child)) in items.iter().enumerate() {
            let last = i + 1 == n;
            out.push_str(prefix);
            out.push_str(if last { "└── " } else { "├── " });
            out.push_str(name);
            if !child.is_file {
                out.push('/');
            }
            out.push('\n');
            let next = format!("{}{}", prefix, if last { "    " } else { "│   " });
            render(child, &next, out);
        }
    }

    let mut root = Node::default();
    for p in paths {
        let mut cur = &mut root;
        for part in p.split('/') {
            if part.is_empty() {
                continue;
            }
            cur = cur.children.entry(part.to_string()).or_default();
        }
        cur.is_file = true;
    }

    let mut out = String::new();
    if !root_label.is_empty() {
        out.push_str(root_label);
        out.push_str("/\n");
    }
    render(&root, "", &mut out);
    out
}

fn lang_of(ext: &str, name: &str) -> String {
    match ext {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "json" => "json",
        "json5" => "json5",
        "jsonc" => "jsonc",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "sass" => "sass",
        "less" => "less",
        "md" | "markdown" => "markdown",
        "mdx" => "mdx",
        "sql" => "sql",
        "sh" | "bash" => "bash",
        "zsh" => "zsh",
        "ps1" => "powershell",
        "bat" | "cmd" => "bat",
        "py" => "python",
        "go" => "go",
        "vue" => "vue",
        "svelte" => "svelte",
        "astro" => "astro",
        "xml" | "svg" | "plist" => "xml",
        "conf" | "ini" | "cfg" | "properties" => "ini",
        "gradle" => "groovy",
        "graphql" | "gql" => "graphql",
        "proto" => "protobuf",
        "csv" => "csv",
        "" => {
            let n = name.to_lowercase();
            if n.starts_with("dockerfile") {
                "dockerfile"
            } else if n.starts_with(".env") {
                "ini"
            } else {
                "text"
            }
        }
        _ => "text",
    }
    .to_string()
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 粗略估算 token：代码以 ASCII 为主，约 3.6 字符 / token
fn estimate_tokens(s: &str) -> usize {
    ((s.chars().count() as f64) / 3.6).ceil() as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_directory_tree() {
        let paths = vec![
            "src-tauri/src/main.rs".to_string(),
            "src-tauri/tauri.conf.json".to_string(),
            "package.json".to_string(),
        ];
        let t = build_tree("demo", &paths);
        assert!(t.starts_with("demo/\n"), "tree was:\n{t}");
        assert!(t.contains("├── package.json"), "tree was:\n{t}");
        assert!(t.contains("└── src-tauri/"), "tree was:\n{t}");
        assert!(t.contains("    ├── src/"), "tree was:\n{t}");
        assert!(t.contains("    │   └── main.rs"), "tree was:\n{t}");
        assert!(t.contains("    └── tauri.conf.json"), "tree was:\n{t}");
    }

    #[test]
    fn renders_tree_without_root_label_for_multi_project() {
        let paths = vec![
            "appA/src/main.ts".to_string(),
            "appB/src/main.rs".to_string(),
        ];
        let t = build_tree("", &paths);
        assert!(t.starts_with("├── appA/"), "tree was:\n{t}");
        assert!(t.contains("└── appB/"), "tree was:\n{t}");
    }

    #[test]
    fn maps_languages() {
        assert_eq!(lang_of("rs", "main.rs"), "rust");
        assert_eq!(lang_of("tsx", "App.tsx"), "tsx");
        assert_eq!(lang_of("json", "tauri.conf.json"), "json");
        assert_eq!(lang_of("toml", "Cargo.toml"), "toml");
        assert_eq!(lang_of("", "Dockerfile"), "dockerfile");
        assert_eq!(lang_of("", ".env"), "ini");
        assert_eq!(lang_of("qqq", "weird.qqq"), "text");
    }

    #[test]
    fn estimates_tokens() {
        let s = "a".repeat(36);
        assert_eq!(estimate_tokens(&s), 10);
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn escapes_xml_specials() {
        assert_eq!(escape_xml("a<b>&\"c\""), "a&lt;b&gt;&amp;&quot;c&quot;");
    }

}
