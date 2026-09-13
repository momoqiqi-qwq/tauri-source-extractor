mod extractor;
mod scanner;
mod timefmt;
mod zipper;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 在系统文件管理器里显示导出产物（zip 打包完成后的「打开文件夹」）
        .plugin(tauri_plugin_opener::init())
        // 记住窗口大小 / 位置 / 最大化状态，下次打开原样恢复
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            scanner::scan_project,
            scanner::detect_projects,
            extractor::extract_bundle,
            zipper::extract_zip,
            extractor::save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod e2e {
    use crate::extractor::{extract_bundle, ExtractOptions, ProjectInput};
    use crate::zipper::extract_zip;
    use crate::scanner::{detect_projects, scan_project};
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn tmp(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("tse_e2e_{}", tag));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    /// 造一个最小的 Tauri 项目，覆盖各分类
    fn make_project(tag: &str) -> PathBuf {
        let base = tmp(tag);
        let files: &[(&str, &str)] = &[
            ("package.json", r#"{"name":"demo","version":"0.1.0"}"#),
            ("index.html", "<div id=\"root\"></div>"),
            ("vite.config.ts", "export default {}"),
            ("tsconfig.json", "{}"),
            ("config.json", r#"{"port":1420}"#),
            ("src/main.tsx", "console.log(1)"),
            ("src/App.tsx", "export default function App(){return null}"),
            ("src/styles.css", "body{margin:0}"),
            ("src-tauri/Cargo.toml", "[package]\nname=\"demo\"\n"),
            ("src-tauri/build.rs", "fn main(){}"),
            ("src-tauri/tauri.conf.json", r#"{"productName":"demo"}"#),
            (
                "src-tauri/capabilities/default.json",
                r#"{"identifier":"default"}"#,
            ),
            ("src-tauri/src/main.rs", "fn main(){}"),
            ("src-tauri/src/lib.rs", "pub fn run(){}"),
            (
                "src-tauri/migrations/001_init.sql",
                "CREATE TABLE t(id INT);",
            ),
            ("README.md", "# demo"),
            (".env", "SECRET=1"),
            // 凭据类文件：分类上像 config，但绝不能默认勾选
            ("secrets.json", r#"{"token":"abc"}"#),
            ("src-tauri/keys/server.key", "-----BEGIN KEY-----"),
            // 干扰项：名字里带 secret 的**源码**必须仍然被当作关键文件
            ("src-tauri/src/secrets.rs", "pub fn load(){}"),
            // Tauri 生成的 schema 在 src-tauri/gen 下 → 应跳过
            ("src-tauri/gen/schemas/capability.json", "{}"),
            // 但根目录的 gen/ 是**真实源码目录** → 必须保留
            ("gen/generated.rs", "pub fn generated(){}"),
            ("src-tauri/target/junk.rs", "// should be ignored"),
            ("node_modules/left-pad/index.js", "// should be ignored"),
            ("Cargo.lock", "# lock"),
        ];
        for (rel, content) in files {
            let p = base.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, content).unwrap();
        }
        base
    }

    fn project_input(root: &Path) -> ProjectInput {
        let scan = scan_project(root.to_string_lossy().to_string()).unwrap();
        ProjectInput {
            name: scan.project_name.clone(),
            root: scan.root.clone(),
            selected: scan
                .files
                .iter()
                .filter(|f| f.is_key)
                .map(|f| f.rel_path.clone())
                .collect(),
        }
    }

    #[test]
    fn scan_classifies_and_ignores() {
        let root = make_project("scan");
        let res = scan_project(root.to_string_lossy().to_string()).unwrap();
        let find = |rel: &str| res.files.iter().find(|f| f.rel_path == rel);

        assert_eq!(
            find("src-tauri/tauri.conf.json").unwrap().category,
            "tauri-config"
        );
        assert_eq!(
            find("src-tauri/Cargo.toml").unwrap().category,
            "tauri-config"
        );
        assert_eq!(
            find("src-tauri/capabilities/default.json").unwrap().category,
            "tauri-config"
        );
        assert_eq!(find("src-tauri/src/main.rs").unwrap().category, "rust");
        assert_eq!(find("src/App.tsx").unwrap().category, "frontend");
        assert_eq!(find("package.json").unwrap().category, "frontend");
        assert_eq!(
            find("src-tauri/migrations/001_init.sql").unwrap().category,
            "data"
        );
        assert_eq!(find("README.md").unwrap().category, "docs");
        assert_eq!(find(".env").unwrap().category, "env");
        // 关键回归：散落的配置文件不再掉进 other
        assert_eq!(find("config.json").unwrap().category, "config");

        // 必须被忽略
        assert!(find("src-tauri/target/junk.rs").is_none(), "target 未被忽略");
        assert!(
            find("node_modules/left-pad/index.js").is_none(),
            "node_modules 未被忽略"
        );
        assert!(find("Cargo.lock").is_none(), "Cargo.lock 未被忽略");

        // 关键文件必须默认勾选
        assert!(find("src-tauri/tauri.conf.json").unwrap().is_key);
        assert!(find("src/App.tsx").unwrap().is_key);
        assert!(find("config.json").unwrap().is_key);
        // 根目录 README 默认勾选（但分类仍是 docs）
        assert!(find("README.md").unwrap().is_key, "根 README 应默认勾选");
        assert!(!find(".env").unwrap().is_key, ".env 不应默认勾选");
        assert!(find(".env").unwrap().is_secret);

        // 凭据类文件：即使分类是 config，也不能默认勾选
        assert_eq!(find("secrets.json").unwrap().category, "config");
        assert!(find("secrets.json").unwrap().is_secret, "secrets.json 应标 SECRET");
        assert!(!find("secrets.json").unwrap().is_key, "secrets.json 不应默认勾选");
        assert!(find("src-tauri/keys/server.key").unwrap().is_secret);
        assert!(!find("src-tauri/keys/server.key").unwrap().is_key);

        // 反向回归：名字里带 secret 的源码仍然必须是关键文件（不能被误判）
        assert_eq!(find("src-tauri/src/secrets.rs").unwrap().category, "rust");
        assert!(
            find("src-tauri/src/secrets.rs").unwrap().is_key,
            "secrets.rs 是关键源码，不能被当成凭据排除"
        );

        // gen 只在 src-tauri/ 下跳过；别处的 gen/ 是真实源码，必须保留
        assert!(
            find("src-tauri/gen/schemas/capability.json").is_none(),
            "src-tauri/gen 下的生成物应被跳过"
        );
        assert!(
            find("gen/generated.rs").is_some(),
            "根目录 gen/ 是真实源码目录，不能被全局跳过"
        );
        assert!(
            find("gen/generated.rs").unwrap().is_key,
            "gen/ 下的 Rust 源码应默认勾选"
        );

        assert_eq!(res.project_kind, "tauri");
    }

    #[test]
    fn extract_bundle_end_to_end_with_tauri_style_args() {
        let root = make_project("extract");
        let scan = scan_project(root.to_string_lossy().to_string()).unwrap();
        let selected: Vec<String> = scan
            .files
            .iter()
            .filter(|f| f.is_key)
            .map(|f| f.rel_path.clone())
            .collect();
        assert!(!selected.is_empty());

        // 完全模拟前端 invoke 传来的 JSON
        let projects: Vec<ProjectInput> = serde_json::from_value(json!([{
            "name": "demo",
            "root": root.to_string_lossy(),
            "selected": selected,
        }]))
        .expect("ProjectInput 反序列化失败");

        let opts: ExtractOptions = serde_json::from_value(json!({
            "format": "markdown",
            "includeTree": true,
            "includeMeta": true,
            "header": "你是工程师",
            "maxFileKb": 512
        }))
        .expect("ExtractOptions 反序列化失败");

        let res = extract_bundle(projects, Some(opts)).expect("extract_bundle 失败");

        assert!(res.file_count > 0);
        assert_eq!(res.project_count, 1);
        assert!(res.skipped.is_empty(), "不该有跳过: {:?}", res.skipped);
        assert!(res.content.contains("你是工程师"));
        assert!(res.content.contains("src-tauri/tauri.conf.json"));
        assert!(res.content.contains("```rust"));
        assert!(res.content.contains("```tsx"));
        assert!(res.est_tokens > 0);
        assert_eq!(res.per_project.len(), 1);

        for rel in &selected {
            assert!(res.content.contains(rel.as_str()), "提取包缺少文件: {}", rel);
        }
    }

    #[test]
    fn extract_zip_end_to_end_with_tauri_style_args() {
        let root = make_project("zip_e2e");
        let scan = scan_project(root.to_string_lossy().to_string()).unwrap();
        let selected: Vec<String> = scan
            .files
            .iter()
            .filter(|f| f.is_key)
            .map(|f| f.rel_path.clone())
            .collect();
        assert!(!selected.is_empty());

        // 完全模拟前端 invoke 传来的 JSON（save 对话框先选好保存路径再 invoke）
        let projects: Vec<ProjectInput> = serde_json::from_value(json!([{
            "name": "demo",
            "root": root.to_string_lossy(),
            "selected": selected,
        }]))
        .expect("ProjectInput 反序列化失败");

        let out = tmp("zip_e2e_out").join("关键源码.zip");
        let res = extract_zip(projects, out.to_string_lossy().to_string())
            .expect("extract_zip 失败");

        assert!(res.file_count > 0);
        assert_eq!(res.project_count, 1);
        assert!(res.skipped.is_empty(), "不该有跳过: {:?}", res.skipped);
        assert!(out.exists());
        assert!(res.zip_bytes > 0);

        // 单项目 → zip 内就是项目相对路径，解压即得项目结构
        let mut z =
            zip::ZipArchive::new(fs::File::open(&out).unwrap()).expect("zip 应可读");
        for rel in &selected {
            assert!(
                z.by_name(rel).is_ok(),
                "zip 缺少关键源码文件: {}",
                rel
            );
        }
        assert!(z.by_name("BUNDLE-INFO.txt").is_ok());
    }

    #[test]
    fn extract_merges_multiple_projects() {
        let a = make_project("multi_a");
        let b = make_project("multi_b");
        let res = extract_bundle(
            vec![project_input(&a), project_input(&b)],
            Some(ExtractOptions {
                format: "markdown".into(),
                include_tree: true,
                include_meta: true,
                header: String::new(),
                max_file_kb: 512,
            }),
        )
        .unwrap();

        assert_eq!(res.project_count, 2);
        assert_eq!(res.per_project.len(), 2);
        // 多项目时文件标题必须带项目前缀，避免同名文件混淆
        assert!(
            res.content.contains("tse_e2e_multi_a/src/App.tsx"),
            "缺少带项目前缀的路径"
        );
        assert!(res.content.contains("tse_e2e_multi_b/src/App.tsx"));
    }

    #[test]
    fn extract_errors_clearly_when_nothing_selected() {
        let root = make_project("empty");
        let err = extract_bundle(
            vec![ProjectInput {
                name: "empty".into(),
                root: root.to_string_lossy().to_string(),
                selected: vec![],
            }],
            None,
        )
        .unwrap_err();
        assert!(err.contains("没有可导出的文件"), "错误信息不明确: {err}");
    }

    #[test]
    fn extract_with_no_options_uses_defaults() {
        let root = make_project("defaults");
        let res =
            extract_bundle(vec![project_input(&root)], None).expect("options 为 None 时不该失败");
        assert!(res.file_count > 0);
    }

    #[test]
    fn extract_survives_binary_and_missing_files() {
        let root = make_project("edge");
        fs::write(root.join("weird.bin"), [0u8, 159, 146, 150]).unwrap();
        let res = extract_bundle(
            vec![ProjectInput {
                name: "edge".into(),
                root: root.to_string_lossy().to_string(),
                selected: vec!["weird.bin".to_string(), "does/not/exist.rs".to_string()],
            }],
            None,
        )
        .expect("边界输入不该失败");
        assert_eq!(res.skipped.len(), 1);
        assert!(res.skipped[0].contains("does/not/exist.rs"));
    }

    #[test]
    fn detect_projects_finds_sub_projects() {
        let parent = tmp("parent");
        for name in ["proj_one", "proj_two"] {
            let dir = parent.join(name);
            fs::create_dir_all(dir.join("src-tauri")).unwrap();
            fs::write(dir.join("src-tauri").join("Cargo.toml"), "[package]").unwrap();
            fs::write(dir.join("src-tauri").join("tauri.conf.json"), "{}").unwrap();
        }
        // 干扰项：不是项目
        let junk = parent.join("just_a_folder");
        fs::create_dir_all(&junk).unwrap();
        fs::write(junk.join("note.txt"), "hi").unwrap();
        // 干扰项：node 项目也算
        let node = parent.join("web_thing");
        fs::create_dir_all(&node).unwrap();
        fs::write(node.join("package.json"), "{}").unwrap();

        let found = detect_projects(parent.to_string_lossy().to_string(), None).unwrap();
        let names: Vec<String> = found.iter().map(|p| p.name.clone()).collect();
        assert!(names.contains(&"proj_one".to_string()), "got {:?}", names);
        assert!(names.contains(&"proj_two".to_string()), "got {:?}", names);
        assert!(names.contains(&"web_thing".to_string()), "got {:?}", names);
        assert!(!names.contains(&"just_a_folder".to_string()), "got {:?}", names);
        assert_eq!(found.iter().filter(|p| p.kind == "tauri").count(), 2);
        assert_eq!(found.iter().filter(|p| p.kind == "node").count(), 1);
    }

    /// 对真实项目做一次体检，列出所有「非关键」文件，用来确认没有漏掉关键源码。
    ///
    /// 手动运行：
    /// ```text
    /// TSE_REAL_PROJECT="E:\path\to\proj" cargo test --lib -- --ignored --nocapture real_project
    /// ```
    #[test]
    #[ignore = "依赖本机真实项目，默认不跑"]
    fn real_project_report() {
        let root = std::env::var("TSE_REAL_PROJECT")
            .unwrap_or_else(|_| r"E:\E-Develop-Project\tiez-clipboard-master".to_string());
        if !Path::new(&root).is_dir() {
            eprintln!("跳过：{root} 不存在");
            return;
        }
        let res = scan_project(root.clone()).unwrap();
        println!("\n项目：{}  类型：{}", res.project_name, res.project_kind);
        println!("文件总数：{}  总行数：{}", res.total_files, res.total_lines);
        println!("{:-<60}", "");
        for s in &res.stats {
            println!(
                "  {:14} {:5} 文件 {:8} 行",
                s.category, s.files, s.lines
            );
        }
        let key = res.files.iter().filter(|f| f.is_key).count();
        println!("{:-<60}", "");
        println!("默认勾选（关键）：{} 个", key);
        // 默认勾选体量 vs 常见上下文窗口 —— 这个工具的用途是喂给 AI，超窗口就没意义
        let key_bytes: u64 = res.files.iter().filter(|f| f.is_key).map(|f| f.size).sum();
        let key_tokens = (key_bytes as f64 / 3.6).ceil() as u64;
        println!(
            "默认勾选体量：{:.2} MB  ≈ {} tokens",
            key_bytes as f64 / 1024.0 / 1024.0,
            key_tokens
        );
        println!(
            "  → 对比 128k 窗口：{:.1}x　对比 200k 窗口：{:.1}x",
            key_tokens as f64 / 128_000.0,
            key_tokens as f64 / 200_000.0
        );
        let nonkey: Vec<_> = res.files.iter().filter(|f| !f.is_key).collect();
        println!("非关键（{} 个）：", nonkey.len());
        for f in nonkey {
            println!("  [{}] {}", f.category, f.rel_path);
        }
    }

    #[test]
    fn detect_projects_returns_self_when_root_is_a_project() {
        let root = make_project("self_detect");
        let found = detect_projects(root.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "tauri");
    }
}
