//! zip 打包导出：把勾选的源码按原始目录结构写成一个压缩包。
//!
//! 与 extractor 的「合并文本喂 AI」是两条独立出口：这里保留文件本体
//! （含二进制，字节不损），适合直接上传给支持压缩包的 AI、或做项目快照。

use crate::extractor::ProjectInput;
use crate::timefmt::{civil_from_days, now_string};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;

/// zip 里单个项目的简报
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZipProjectBrief {
    pub name: String,
    pub file_count: usize,
    pub bytes: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZipResult {
    /// 写出的 zip 完整路径
    pub path: String,
    pub file_count: usize,
    /// 实际贡献了文件的项目数
    pub project_count: usize,
    /// 解压后的原始字节数
    pub total_bytes: u64,
    /// zip 文件本身的大小
    pub zip_bytes: u64,
    pub skipped: Vec<String>,
    pub per_project: Vec<ZipProjectBrief>,
    pub generated_at: String,
}

/// 把勾选的源码按原始目录结构打包成一个 zip 文件。
///
/// 单项目时 zip 内就是项目相对路径，解压即得项目结构；多项目时顶层加
/// 项目名前缀，避免同名文件互相覆盖。
#[tauri::command]
pub fn extract_zip(projects: Vec<ProjectInput>, path: String) -> Result<ZipResult, String> {
    write_zip_bundle(&projects, &path)
}

pub fn write_zip_bundle(projects: &[ProjectInput], out_path: &str) -> Result<ZipResult, String> {
    if projects.is_empty() {
        return Err("没有可导出的项目".to_string());
    }

    let generated_at = now_string();
    let multi = projects.len() > 1;

    let mut skipped: Vec<String> = Vec::new();
    let mut per_project: Vec<ZipProjectBrief> = Vec::new();
    // (zip 内条目名, 文件内容)。先收集再统一写，这样「全部读不到」能在建文件之前就报错
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();

    for p in projects {
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

        let mut paths: Vec<String> = p.selected.iter().map(|s| s.replace('\\', "/")).collect();
        paths.sort();
        paths.dedup();

        let mut project_files = 0usize;
        let mut project_bytes = 0u64;
        for rel in &paths {
            if !safe_rel(rel) {
                skipped.push(format!("{}/{}（路径不安全，已跳过）", name, rel));
                continue;
            }
            let bytes = match fs::read(root_path.join(rel)) {
                Ok(b) => b,
                Err(e) => {
                    skipped.push(format!("{}/{}（读取失败：{}）", name, rel, e));
                    continue;
                }
            };
            project_bytes += bytes.len() as u64;
            project_files += 1;
            let entry = if multi {
                format!("{}/{}", sanitize_component(&name), rel)
            } else {
                rel.clone()
            };
            entries.push((entry, bytes));
        }
        // 目录存在但一个文件都没读到 → 显式记下来，别让它静默消失
        if project_files == 0 {
            skipped.push(format!("{}（没有可打包的文件）", name));
        }
        per_project.push(ZipProjectBrief {
            name,
            file_count: project_files,
            bytes: project_bytes,
        });
    }

    let total_files = entries.len();
    if total_files == 0 {
        let mut msg = "没有可打包的文件：所有选中项都被跳过或不存在".to_string();
        if !skipped.is_empty() {
            msg.push_str("。原因：");
            msg.push_str(&skipped.iter().take(5).cloned().collect::<Vec<_>>().join("；"));
        }
        return Err(msg);
    }

    if let Some(parent) = Path::new(out_path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
        }
    }

    let file = fs::File::create(out_path).map_err(|e| format!("创建文件失败：{}", e))?;
    let mut w = zip::ZipWriter::new(file);
    let mut options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    if let Some(dt) = zip_datetime_now() {
        options = options.last_modified_time(dt);
    }
    let zerr = |e: zip::result::ZipError| format!("zip 写入失败：{}", e);

    // 清单放第一个条目：解开就能知道这份包是什么、装了什么、跳过了什么
    let manifest = build_manifest(&per_project, &skipped, &generated_at);
    w.start_file("BUNDLE-INFO.txt", options).map_err(zerr)?;
    w.write_all(manifest.as_bytes())
        .map_err(|e| format!("zip 写入失败：{}", e))?;

    let mut total_bytes = 0u64;
    for (entry, bytes) in &entries {
        w.start_file(entry, options).map_err(zerr)?;
        w.write_all(bytes)
            .map_err(|e| format!("zip 写入失败：{}", e))?;
        total_bytes += bytes.len() as u64;
    }

    let file = w.finish().map_err(zerr)?;
    let zip_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);

    Ok(ZipResult {
        path: out_path.to_string(),
        file_count: total_files,
        project_count: per_project.iter().filter(|b| b.file_count > 0).count(),
        total_bytes,
        zip_bytes,
        skipped,
        per_project,
        generated_at,
    })
}

/// zip 条目里的单个路径段：去掉分隔符与 Windows 保留字符
fn sanitize_component(s: &str) -> String {
    s.chars()
        .map(|c| {
            if matches!(
                c,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) || c.is_control()
            {
                '_'
            } else {
                c
            }
        })
        .collect()
}

/// 相对路径必须是干净的 `a/b/c` 形式（调用前已把 `\` 归一成 `/`），拒绝空段与 `..`
fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn build_manifest(briefs: &[ZipProjectBrief], skipped: &[String], generated_at: &str) -> String {
    let mut out = String::new();
    out.push_str("Tauri 关键源码提取包\n");
    out.push_str(&format!("生成时间：{}\n", generated_at));
    out.push_str("来源：Tauri 关键源码提取器（tauri-source-extractor）\n\n");
    out.push_str("包含项目：\n");
    let mut total = 0usize;
    for b in briefs {
        if b.file_count == 0 {
            continue;
        }
        total += b.file_count;
        out.push_str(&format!(
            "  - {}：{} 个文件，{} 字节\n",
            b.name, b.file_count, b.bytes
        ));
    }
    out.push_str(&format!(
        "\n共 {} 个文件。文件名为 UTF-8；多项目时顶层目录为项目名。\n",
        total
    ));
    if !skipped.is_empty() {
        out.push_str("\n已跳过：\n");
        for s in skipped {
            out.push_str(&format!("  - {}\n", s));
        }
    }
    out
}

/// 当前 UTC 时间对应的 zip 时间戳。zip 只支持 1980–2107，越界就退回默认值。
fn zip_datetime_now() -> Option<zip::DateTime> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    let (h, mi, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    let (y, m, d) = civil_from_days(secs / 86400);
    let (y, m, d) = (y as u16, m as u8, d as u8);
    zip::DateTime::from_date_and_time(y, m, d, h as u8, mi as u8, s as u8).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::path::PathBuf;

    fn zip_tmp(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("tse_zip_{}", tag));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn zip_project(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let base = zip_tmp(tag);
        for (rel, content) in files {
            let p = base.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, content).unwrap();
        }
        base
    }

    fn zip_input(name: &str, root: &Path, selected: &[&str]) -> ProjectInput {
        ProjectInput {
            name: name.to_string(),
            root: root.to_string_lossy().to_string(),
            selected: selected.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn read_entry(z: &mut zip::ZipArchive<fs::File>, name: &str) -> Vec<u8> {
        let mut out = Vec::new();
        z.by_name(name)
            .unwrap_or_else(|e| panic!("缺少条目 {name}: {e}"))
            .read_to_end(&mut out)
            .unwrap();
        out
    }

    #[test]
    fn zip_single_project_keeps_rel_paths_and_bytes() {
        let root = zip_project(
            "zip_single",
            &[("src/main.rs", "fn main(){}"), ("README.md", "# t")],
        );
        fs::write(root.join("logo.bin"), [0u8, 159, 146, 150]).unwrap();
        let out = zip_tmp("zip_single_out").join("out.zip");

        let res = write_zip_bundle(
            &[zip_input(
                "demo",
                &root,
                &["src/main.rs", "README.md", "logo.bin"],
            )],
            out.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert_eq!(res.file_count, 3);
        assert_eq!(res.project_count, 1);
        assert_eq!(res.total_bytes, 11 + 3 + 4);
        assert!(res.zip_bytes > 0);
        assert!(res.skipped.is_empty());

        let mut z = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        assert_eq!(read_entry(&mut z, "src/main.rs"), b"fn main(){}");
        assert_eq!(read_entry(&mut z, "README.md"), b"# t");
        // zip 是给「要文件本体」的场景用的，二进制必须字节不损（合并文本导出做不到）
        assert_eq!(read_entry(&mut z, "logo.bin"), [0u8, 159, 146, 150]);
        assert!(z.by_name("BUNDLE-INFO.txt").is_ok());
        // 时间戳应被设成当前 UTC（默认会是 1980）
        let mtime = z
            .by_name("src/main.rs")
            .unwrap()
            .last_modified()
            .expect("mtime 应存在");
        assert!(mtime.year() >= 2024, "mtime 未被设置: {mtime}");
    }

    #[test]
    fn zip_multi_project_prefixes_entries() {
        let a = zip_project("zip_pa", &[("src/main.rs", "A")]);
        let b = zip_project("zip_pb", &[("src/main.rs", "B")]);
        let out = zip_tmp("zip_multi_out").join("out.zip");

        let res = write_zip_bundle(
            &[
                zip_input("pa", &a, &["src/main.rs"]),
                zip_input("pb", &b, &["src/main.rs"]),
            ],
            out.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert_eq!(res.project_count, 2);
        let mut z = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        assert_eq!(read_entry(&mut z, "pa/src/main.rs"), b"A");
        assert_eq!(read_entry(&mut z, "pb/src/main.rs"), b"B");
        let manifest = String::from_utf8(read_entry(&mut z, "BUNDLE-INFO.txt")).unwrap();
        assert!(manifest.contains("pa"));
        assert!(manifest.contains("pb"));
    }

    #[test]
    fn zip_reports_skipped_files_and_manifest_lists_them() {
        let root = zip_project("zip_skip", &[("src/main.rs", "ok")]);
        let out = zip_tmp("zip_skip_out").join("out.zip");

        let res = write_zip_bundle(
            &[zip_input("demo", &root, &["src/main.rs", "does/not/exist.rs"])],
            out.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert_eq!(res.file_count, 1);
        assert_eq!(res.skipped.len(), 1);
        assert!(res.skipped[0].contains("does/not/exist.rs"));
        let mut z = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        let manifest = String::from_utf8(read_entry(&mut z, "BUNDLE-INFO.txt")).unwrap();
        assert!(manifest.contains("已跳过"), "manifest:\n{manifest}");
        assert!(manifest.contains("does/not/exist.rs"));
    }

    #[test]
    fn zip_fails_clearly_when_nothing_readable() {
        let root = zip_project("zip_none", &[("src/main.rs", "ok")]);
        let err = write_zip_bundle(
            &[zip_input("demo", &root, &["gone.rs", "also/gone.rs"])],
            zip_tmp("zip_none_out")
                .join("out.zip")
                .to_string_lossy()
                .as_ref(),
        )
        .unwrap_err();
        assert!(err.contains("没有可打包的文件"), "错误信息不明确: {err}");
    }

    #[test]
    fn zip_rejects_dotdot_paths() {
        let root = zip_project("zip_dotdot", &[("src/main.rs", "ok")]);
        fs::write(root.parent().unwrap().join("escape.txt"), "secret").unwrap();
        let out = zip_tmp("zip_dotdot_out").join("out.zip");

        let res = write_zip_bundle(
            &[zip_input("demo", &root, &["../escape.txt", "src/main.rs"])],
            out.to_string_lossy().as_ref(),
        )
        .unwrap();

        // 恶意/手误的相对路径被拦下并记录，其余文件照常打包
        assert_eq!(res.file_count, 1);
        assert!(res.skipped[0].contains("路径不安全"));
        let mut z = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        for i in 0..z.len() {
            assert!(!z.by_index(i).unwrap().name().contains(".."));
        }
    }

    #[test]
    fn zip_sanitizes_project_name_in_multi_mode() {
        let a = zip_project("zip_name_a", &[("src/x.rs", "A")]);
        let b = zip_project("zip_name_b", &[("src/x.rs", "B")]);
        let out = zip_tmp("zip_name_out").join("out.zip");

        write_zip_bundle(
            &[
                zip_input("we/ird:na|me", &a, &["src/x.rs"]),
                zip_input("pb", &b, &["src/x.rs"]),
            ],
            out.to_string_lossy().as_ref(),
        )
        .unwrap();

        let mut z = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        assert!(z.by_name("we_ird_na_me/src/x.rs").is_ok());
    }
}
