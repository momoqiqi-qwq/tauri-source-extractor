//! 项目扫描与「关键源码」分类。
//!
//! 遍历目标项目，跳过依赖/构建产物目录，把每个文件归入
//! tauri-config / rust / frontend / data / docs / env / config / other 之一，
//! 并给出默认是否勾选（is_key）。
//!
//! 设计取向：**宁可多选，不可漏选**。用户明确要求「确保没有漏掉的关键文件」，
//! 因此通用配置文件（json/toml/yaml/xml…）单独归为 config 且默认勾选。

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;
use walkdir::WalkDir;

/// 这些目录名（小写）整棵跳过
const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".git",
    ".hg",
    ".svn",
    ".vite",
    ".cache",
    ".turbo",
    ".parcel-cache",
    "coverage",
    ".nyc_output",
    ".idea",
    ".vs",
    "__pycache__",
    ".output",
    ".tauri",
    ".gradle",
    "vendor",
    "pods",
    ".pnpm-store",
    ".yarn",
    ".venv",
    "venv",
];

/// 只在**特定父目录**下才跳过的目录名：(父路径前缀, 目录名)，均小写。
///
/// Tauri 会把生成的 capability schema 写进 `src-tauri/gen/schemas`，但 `gen`
/// 同时也是很常见的**真实源码目录**名（Android、protobuf/gRPC 代码生成等）。
/// 若把它放进 `IGNORE_DIRS` 全局跳过，这些源码会**无声消失**——正是
/// 「不漏掉关键文件」要防的失败模式。所以这里按作用域精确跳过。
const SCOPED_IGNORE_DIRS: &[(&str, &str)] = &[("src-tauri/", "gen")];

/// 这些文件名（小写）直接跳过
const IGNORE_FILES: &[&str] = &[
    "cargo.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "poetry.lock",
    "composer.lock",
    "gemfile.lock",
    "go.sum",
    "packages.lock.json",
];

/// 明确按二进制处理的后缀
const BINARY_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "tiff", "avif", "heic", "psd",
    "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "mkv", "wav", "ogg", "flac",
    "webm", "m4a", "zip", "tar", "gz", "7z", "rar", "xz", "bz2", "zst", "exe", "dll", "so", "dylib",
    "a", "lib", "o", "obj", "pdb", "class", "jar", "wasm", "bin", "dat", "db", "sqlite", "sqlite3",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "swf", "apk", "ipa", "dmg", "msi", "node",
    "map", "br", "snap",
];

/// 明确按文本处理的后缀
const TEXT_EXTS: &[&str] = &[
    "rs", "toml", "json", "json5", "jsonc", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
    "vue", "svelte", "astro", "html", "htm", "css", "scss", "sass", "less", "styl", "md", "markdown",
    "mdx", "txt", "rst", "yml", "yaml", "xml", "svg", "sql", "sh", "bash", "zsh", "fish", "ps1",
    "bat", "cmd", "py", "go", "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp", "cc", "cs", "rb",
    "php", "lua", "dart", "ini", "cfg", "conf", "properties", "gradle", "plist", "graphql", "gql",
    "proto", "hbs", "ejs", "pug", "njk", "liquid", "tf", "env", "csv", "tsv", "cmake", "gitignore",
    "nsh", "nsi", "wxs", "wxi", "iss", "pl", "awk", "sed", "mk",
];

/// 无后缀但确定是文本的常见文件
const KNOWN_TEXT_NAMES: &[&str] = &[
    "dockerfile",
    "makefile",
    "procfile",
    "rakefile",
    "gemfile",
    "license",
    "licence",
    "readme",
    "changelog",
    "authors",
    "notice",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".npmrc",
    ".nvmrc",
    ".editorconfig",
    ".prettierrc",
    ".prettierignore",
    ".eslintignore",
    ".babelrc",
    ".dockerignore",
    ".taurignore",
    ".env",
];

/// 命中即视为前端源码的目录前缀
const FRONTEND_DIRS: &[&str] = &[
    "src/",
    "app/",
    "web/",
    "frontend/",
    "pages/",
    "components/",
    "features/",
    "layouts/",
    "views/",
    "hooks/",
    "utils/",
    "helpers/",
    "styles/",
    "store/",
    "stores/",
    "composables/",
    "router/",
];

/// 前端源码后缀
const FRONTEND_EXTS: &[&str] = &[
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro", "css", "scss",
    "sass", "less", "styl", "html", "htm",
];

/// 前端构建配置（按前缀匹配）
const FRONTEND_CONF_PREFIXES: &[&str] = &[
    "vite.config",
    "vitest.config",
    "tsconfig",
    "jsconfig",
    "tailwind.config",
    "postcss.config",
    "svelte.config",
    "astro.config",
    "next.config",
    "nuxt.config",
    "eslint.config",
    ".eslintrc",
    ".prettierrc",
    "babel.config",
    ".babelrc",
    "jest.config",
    "playwright.config",
    "rollup.config",
    "webpack.config",
    "uno.config",
    "windi.config",
];

/// 前端构建配置（精确匹配）
const FRONTEND_CONF_EXACT: &[&str] = &["package.json", "index.html", "deno.json", "bunfig.toml"];

/// 文档后缀
const DOCS_EXTS: &[&str] = &["md", "markdown", "mdx", "txt", "rst"];

/// 通用配置后缀 —— 默认勾选，避免漏掉关键文件
const CONFIG_EXTS: &[&str] = &[
    "json", "json5", "jsonc", "toml", "yaml", "yml", "xml", "ini", "cfg", "conf", "properties",
    "plist", "graphql", "gql", "proto", "tf", "gradle", "cmake", "csv", "tsv",
    // 构建 / 打包脚本：NSIS、WiX、Inno、shell、PowerShell、批处理、其他语言的小工具
    "nsh", "nsi", "wxs", "wxi", "iss", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "py",
    "rb", "lua", "pl", "mk",
];

/// 明确是凭据 / 密钥的后缀 —— 这些文件不该被默认喂给 AI
const SECRET_EXTS: &[&str] = &[
    "pem", "key", "p12", "pfx", "jks", "keystore", "ppk", "asc", "tfvars", "tfstate",
];

/// 明确是凭据 / 密钥的文件名（精确匹配）。
///
/// 只匹配**精确文件名**而不是 `secrets` 这种前缀 —— 否则 `src/secrets.rs`
/// 这类「名字里带 secret 的源码」会被误判，反而漏掉关键源码。
const SECRET_NAMES: &[&str] = &[
    ".npmrc",
    ".netrc",
    ".pgpass",
    ".htpasswd",
    ".envrc",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials.json",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
    "service-account.json",
    "serviceaccount.json",
    "google-services.json",
];

/// 是否属于「不该默认导出」的凭据文件
fn is_secret_file(name_lower: &str, ext: &str) -> bool {
    if name_lower == ".env" || name_lower.starts_with(".env.") {
        return true;
    }
    if SECRET_EXTS.contains(&ext) {
        return true;
    }
    SECRET_NAMES.contains(&name_lower)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub rel_path: String,
    pub abs_path: String,
    pub name: String,
    pub dir: String,
    pub ext: String,
    pub category: String,
    pub size: u64,
    pub lines: usize,
    pub is_key: bool,
    pub is_text: bool,
    pub is_secret: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryStat {
    pub category: String,
    pub files: usize,
    pub bytes: u64,
    pub lines: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub project_name: String,
    /// tauri | node | rust | unknown
    pub project_kind: String,
    pub files: Vec<FileEntry>,
    pub stats: Vec<CategoryStat>,
    pub total_files: usize,
    pub total_bytes: u64,
    pub total_lines: usize,
    pub ignored_dirs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProject {
    pub name: String,
    pub path: String,
    pub kind: String,
}

/// 判断一个目录条目是否应该整棵跳过。
///
/// 先查全局忽略表，再查「作用域忽略」——后者只在条目位于指定父目录下时才生效，
/// 避免把别处的同名真实源码目录一起干掉。
fn should_skip_dir(root_path: &Path, e: &walkdir::DirEntry) -> bool {
    let name = e.file_name().to_string_lossy().to_lowercase();
    if IGNORE_DIRS.contains(&name.as_str()) {
        return true;
    }
    let rel = e
        .path()
        .strip_prefix(root_path)
        .map(|r| r.to_string_lossy().replace('\\', "/").to_lowercase())
        .unwrap_or_default();
    SCOPED_IGNORE_DIRS
        .iter()
        .any(|(prefix, dir)| name == *dir && rel.starts_with(prefix))
}

#[tauri::command]
pub fn scan_project(root: String) -> Result<ScanResult, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("目录不存在或不是文件夹：{}", root));
    }

    let mut files: Vec<FileEntry> = Vec::new();

    let walker = WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                !should_skip_dir(root_path, e)
            } else {
                true
            }
        });

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }

        let abs = entry.path();
        let rel = match abs.strip_prefix(root_path) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let name_lower = name.to_lowercase();

        if IGNORE_FILES.contains(&name_lower.as_str()) {
            continue;
        }
        if name_lower.ends_with(".tmp")
            || name_lower.ends_with(".bak")
            || name_lower.ends_with(".orig")
            || name_lower.ends_with('~')
        {
            continue;
        }

        let ext = abs
            .extension()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        let size = match entry.metadata() {
            Ok(m) => m.len(),
            Err(_) => 0,
        };

        let is_secret = is_secret_file(&name_lower, &ext);
        let is_text = is_probably_text(abs, &ext, &name_lower);

        let mut lines = 0usize;
        if is_text && size <= 4 * 1024 * 1024 {
            if let Ok(bytes) = fs::read(abs) {
                lines = count_lines(&bytes);
            }
        }

        let category = classify(&rel, &name_lower, &ext);

        let dir = match rel.rsplit_once('/') {
            Some((d, _)) => d.to_string(),
            None => String::new(),
        };

        // 项目根目录的 README 默认勾选：对理解项目整体很有价值
        let root_readme =
            category == "docs" && dir.is_empty() && name_lower.starts_with("readme");
        let is_key = (matches!(
            category,
            "tauri-config" | "rust" | "frontend" | "data" | "config"
        ) || root_readme)
            && !is_secret;

        files.push(FileEntry {
            rel_path: rel,
            abs_path: abs.to_string_lossy().to_string(),
            name,
            dir,
            ext,
            category: category.to_string(),
            size,
            lines,
            is_key,
            is_text,
            is_secret,
        });
    }

    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    // 统计
    let mut stats_map: std::collections::BTreeMap<String, CategoryStat> = Default::default();
    let mut total_bytes = 0u64;
    let mut total_lines = 0usize;
    for f in &files {
        total_bytes += f.size;
        total_lines += f.lines;
        let e = stats_map
            .entry(f.category.clone())
            .or_insert_with(|| CategoryStat {
                category: f.category.clone(),
                files: 0,
                bytes: 0,
                lines: 0,
            });
        e.files += 1;
        e.bytes += f.size;
        e.lines += f.lines;
    }
    let mut stats: Vec<CategoryStat> = stats_map.into_values().collect();
    stats.sort_by(|a, b| a.category.cmp(&b.category));

    let project_name = root_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());

    let project_kind = detect_kind(root_path);

    Ok(ScanResult {
        root: root_path.to_string_lossy().to_string(),
        project_name,
        project_kind,
        total_files: files.len(),
        total_bytes,
        total_lines,
        files,
        stats,
        ignored_dirs: IGNORE_DIRS.iter().map(|s| s.to_string()).collect(),
    })
}

/// 在父目录里自动发现子项目（含 src-tauri / package.json / Cargo.toml 的目录）
#[tauri::command]
pub fn detect_projects(
    root: String,
    max_depth: Option<usize>,
) -> Result<Vec<DetectedProject>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("目录不存在：{}", root));
    }
    let max_depth = max_depth.unwrap_or(3).clamp(1, 5);

    // 自己就是项目 → 只返回自己
    let self_kind = detect_kind(root_path);
    if self_kind != "unknown" {
        return Ok(vec![DetectedProject {
            name: root_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| root.clone()),
            path: root_path.to_string_lossy().to_string(),
            kind: self_kind,
        }]);
    }

    let mut found: Vec<DetectedProject> = Vec::new();
    let walker = WalkDir::new(root_path)
        .follow_links(false)
        .min_depth(1)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                !should_skip_dir(root_path, e) && !name.starts_with('.')
            } else {
                true
            }
        });

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_dir() {
            continue;
        }
        let kind = detect_kind(entry.path());
        if kind != "unknown" {
            found.push(DetectedProject {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                kind,
            });
        }
    }

    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

fn detect_kind(dir: &Path) -> String {
    if dir.join("src-tauri").join("tauri.conf.json").is_file()
        || dir.join("src-tauri").join("Cargo.toml").is_file()
    {
        return "tauri".to_string();
    }
    if dir.join("package.json").is_file() {
        return "node".to_string();
    }
    if dir.join("Cargo.toml").is_file() {
        return "rust".to_string();
    }
    "unknown".to_string()
}

/// 把相对路径归入分类
fn classify(rel: &str, name_lower: &str, ext: &str) -> &'static str {
    let p = rel.to_lowercase();
    let in_src_tauri = p.starts_with("src-tauri/");

    // 1) Tauri 配置
    if name_lower.starts_with("tauri.conf")
        || (name_lower.starts_with("tauri.") && name_lower.ends_with(".conf.json"))
        || name_lower == ".taurignore"
        || p.contains("capabilities/")
        || p.contains("permissions/")
        || (in_src_tauri && matches!(name_lower, "cargo.toml" | "build.rs"))
    {
        return "tauri-config";
    }

    // 2) Rust 后端（含 workspace 根 Cargo.toml）
    if ext == "rs" || name_lower == "cargo.toml" || name_lower.starts_with("rust-toolchain") {
        return "rust";
    }

    // 3) 数据 / 迁移
    if ext == "sql" || p.contains("migration") {
        return "data";
    }

    // 4) 环境变量（默认不勾选）
    if name_lower == ".env" || name_lower.starts_with(".env.") {
        return "env";
    }

    // 5) 前端源码与构建配置
    if FRONTEND_DIRS.iter().any(|d| p.starts_with(d))
        || FRONTEND_CONF_EXACT.contains(&name_lower)
        || FRONTEND_CONF_PREFIXES
            .iter()
            .any(|pre| name_lower.starts_with(pre))
        || FRONTEND_EXTS.contains(&ext)
    {
        return "frontend";
    }

    // 6) 文档
    if DOCS_EXTS.contains(&ext)
        || name_lower.starts_with("license")
        || name_lower.starts_with("readme")
        || name_lower.starts_with("changelog")
        || name_lower.starts_with("notice")
    {
        return "docs";
    }

    // 7) 通用配置（默认勾选）
    if CONFIG_EXTS.contains(&ext) {
        return "config";
    }

    "other"
}

fn is_probably_text(path: &Path, ext: &str, name_lower: &str) -> bool {
    if !ext.is_empty() {
        if BINARY_EXTS.contains(&ext) {
            return false;
        }
        if TEXT_EXTS.contains(&ext) {
            return true;
        }
    }
    if name_lower.starts_with(".env") || KNOWN_TEXT_NAMES.contains(&name_lower) {
        return true;
    }
    // 未知后缀：嗅探前 4KB 是否含 NUL 字节
    if let Ok(mut f) = fs::File::open(path) {
        let mut buf = [0u8; 4096];
        if let Ok(n) = f.read(&mut buf) {
            if n == 0 {
                return true;
            }
            return !buf[..n].contains(&0);
        }
    }
    false
}

fn count_lines(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let nl = bytes.iter().filter(|&&b| b == b'\n').count();
    if *bytes.last().unwrap() == b'\n' {
        nl
    } else {
        nl + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_tauri_config() {
        for (rel, name, ext) in [
            ("src-tauri/tauri.conf.json", "tauri.conf.json", "json"),
            (
                "src-tauri/tauri.windows.conf.json",
                "tauri.windows.conf.json",
                "json",
            ),
            ("src-tauri/capabilities/default.json", "default.json", "json"),
            ("src-tauri/Cargo.toml", "cargo.toml", "toml"),
            ("src-tauri/build.rs", "build.rs", "rs"),
        ] {
            assert_eq!(classify(rel, name, ext), "tauri-config", "{} 分类错误", rel);
        }
    }

    #[test]
    fn classifies_rust() {
        assert_eq!(classify("src-tauri/src/main.rs", "main.rs", "rs"), "rust");
        assert_eq!(
            classify("src-tauri/src/app/setup.rs", "setup.rs", "rs"),
            "rust"
        );
        assert_eq!(classify("crates/core/src/lib.rs", "lib.rs", "rs"), "rust");
        // workspace 根 Cargo.toml 也算 Rust
        assert_eq!(classify("Cargo.toml", "cargo.toml", "toml"), "rust");
    }

    #[test]
    fn classifies_frontend() {
        assert_eq!(classify("src/App.tsx", "app.tsx", "tsx"), "frontend");
        assert_eq!(
            classify("src/features/a/b.ts", "b.ts", "ts"),
            "frontend"
        );
        assert_eq!(classify("package.json", "package.json", "json"), "frontend");
        assert_eq!(
            classify("vite.config.ts", "vite.config.ts", "ts"),
            "frontend"
        );
        assert_eq!(
            classify("vite.config.mjs", "vite.config.mjs", "mjs"),
            "frontend"
        );
        assert_eq!(
            classify("tsconfig.node.json", "tsconfig.node.json", "json"),
            "frontend"
        );
        assert_eq!(classify("index.html", "index.html", "html"), "frontend");
        assert_eq!(classify("styles/main.css", "main.css", "css"), "frontend");
    }

    #[test]
    fn classifies_data_docs_env() {
        assert_eq!(
            classify("src-tauri/migrations/001.sql", "001.sql", "sql"),
            "data"
        );
        assert_eq!(classify("db/schema.sql", "schema.sql", "sql"), "data");
        assert_eq!(classify("README.md", "readme.md", "md"), "docs");
        assert_eq!(classify("docs/guide.md", "guide.md", "md"), "docs");
        assert_eq!(classify("LICENSE", "license", ""), "docs");
        assert_eq!(classify(".env", ".env", ""), "env");
        assert_eq!(classify(".env.local", ".env.local", "local"), "env");
    }

    /// 回归：这些以前会掉进 other 被漏掉
    #[test]
    fn config_category_catches_loose_configs() {
        assert_eq!(classify("config.json", "config.json", "json"), "config");
        assert_eq!(classify("settings/app.toml", "app.toml", "toml"), "config");
        assert_eq!(
            classify(".github/workflows/ci.yml", "ci.yml", "yml"),
            "config"
        );
        assert_eq!(
            classify("docker-compose.yml", "docker-compose.yml", "yml"),
            "config"
        );
        assert_eq!(classify("Info.plist", "info.plist", "plist"), "config");
        assert_eq!(
            classify("api/schema.graphql", "schema.graphql", "graphql"),
            "config"
        );
        assert_eq!(classify("notes.xyz", "notes.xyz", "xyz"), "other");
    }

    /// 回归：打包脚本、shell 工具脚本也是关键文件，不能掉进 other
    #[test]
    fn build_and_packaging_scripts_are_key() {
        assert_eq!(
            classify("src-tauri/nsis/uninstall.nsh", "uninstall.nsh", "nsh"),
            "config"
        );
        assert_eq!(
            classify("installer/setup.nsi", "setup.nsi", "nsi"),
            "config"
        );
        assert_eq!(classify("scripts/release.sh", "release.sh", "sh"), "config");
        assert_eq!(
            classify("scripts/build.ps1", "build.ps1", "ps1"),
            "config"
        );
        assert_eq!(
            classify("scripts/gen.py", "gen.py", "py"),
            "config"
        );
        assert_eq!(
            classify("src-tauri/.taurignore", ".taurignore", ""),
            "tauri-config"
        );
    }

    /// 忽略表必须全小写 —— 比较时用的是 to_lowercase()，混入大写项会静默失效
    #[test]
    fn lookup_tables_are_lowercase() {
        let check = |list: &[&str], what: &str| {
            for item in list {
                assert_eq!(
                    *item,
                    item.to_lowercase(),
                    "{} 含非小写项: {}（永远不会被匹配到）",
                    what,
                    item
                );
            }
        };
        check(IGNORE_DIRS, "IGNORE_DIRS");
        check(IGNORE_FILES, "IGNORE_FILES");
        check(BINARY_EXTS, "BINARY_EXTS");
        check(TEXT_EXTS, "TEXT_EXTS");
        check(KNOWN_TEXT_NAMES, "KNOWN_TEXT_NAMES");
        check(FRONTEND_DIRS, "FRONTEND_DIRS");
        check(FRONTEND_EXTS, "FRONTEND_EXTS");
        check(FRONTEND_CONF_PREFIXES, "FRONTEND_CONF_PREFIXES");
        check(FRONTEND_CONF_EXACT, "FRONTEND_CONF_EXACT");
        check(CONFIG_EXTS, "CONFIG_EXTS");
        check(SECRET_EXTS, "SECRET_EXTS");
        check(SECRET_NAMES, "SECRET_NAMES");

        for (prefix, dir) in SCOPED_IGNORE_DIRS {
            assert_eq!(
                *prefix,
                prefix.to_lowercase(),
                "SCOPED_IGNORE_DIRS 前缀含非小写项: {}",
                prefix
            );
            assert_eq!(
                *dir,
                dir.to_lowercase(),
                "SCOPED_IGNORE_DIRS 目录名含非小写项: {}",
                dir
            );
        }
    }

    /// 凭据文件应被标记为 secret（默认不勾选），但**源码文件绝不能被误判**，
    /// 否则就违背了「不漏关键文件」的目标。
    #[test]
    fn flags_credential_files_but_not_source_code() {
        // 凭据：必须命中
        assert!(is_secret_file(".env", ""));
        assert!(is_secret_file(".env.local", "local"));
        assert!(is_secret_file("id_rsa", ""));
        assert!(is_secret_file("server.key", "key"));
        assert!(is_secret_file("cert.pem", "pem"));
        assert!(is_secret_file("google-services.json", "json"));
        assert!(is_secret_file("credentials.json", "json"));
        assert!(is_secret_file("terraform.tfvars", "tfvars"));

        // 源码：绝不能命中
        assert!(!is_secret_file("secrets.rs", "rs"), "Rust 源码被误判");
        assert!(!is_secret_file("credentials.ts", "ts"), "TS 源码被误判");
        assert!(!is_secret_file("secrets_handler.tsx", "tsx"), "TSX 源码被误判");
        assert!(!is_secret_file("tauri.conf.json", "json"));
        assert!(!is_secret_file("package.json", "json"));
        assert!(!is_secret_file("cargo.toml", "toml"));
    }

    #[test]
    fn counts_lines_correctly() {
        assert_eq!(count_lines(b""), 0);
        assert_eq!(count_lines(b"a"), 1);
        assert_eq!(count_lines(b"a\n"), 1);
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(count_lines(b"a\nb\n"), 2);
    }

    #[test]
    fn detects_binary_extensions() {
        assert!(!is_probably_text(Path::new("nope.png"), "png", "nope.png"));
        assert!(is_probably_text(Path::new("nope.rs"), "rs", "nope.rs"));
        assert!(is_probably_text(
            Path::new("nope.Dockerfile"),
            "",
            "dockerfile"
        ));
    }
}
