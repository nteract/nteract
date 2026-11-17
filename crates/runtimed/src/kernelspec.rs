//! Installed definitions belong to the local machine, not the notebook document.
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{bail, ensure, Context, Result};
use notebook_protocol::protocol::{InstalledKernelspec, KernelspecInventory};
use serde::Deserialize;

#[derive(Default, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum InterruptMode {
    #[default]
    Signal,
    Message,
}

#[derive(Deserialize)]
pub(crate) struct Definition {
    argv: Vec<String>,
    display_name: String,
    language: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub interrupt_mode: InterruptMode,
    #[serde(skip)]
    resource_dir: PathBuf,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !matches!(name, "." | "..")
        && name.len() <= 255
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

pub(crate) fn imported(
    metadata: Option<&notebook_doc::metadata::NotebookMetadataSnapshot>,
    mode: notebook_protocol::connection::CreateNotebookEnvironmentMode,
) -> Option<String> {
    if mode != notebook_protocol::connection::CreateNotebookEnvironmentMode::Auto {
        return None;
    }
    let snap = metadata?;
    let spec = snap.kernelspec.as_ref()?;
    let explicit = snap
        .runt
        .extra
        .get("installed_kernelspec")
        .and_then(|v| v.as_str())
        == Some(&spec.name);
    if !explicit
        && (matches!(
            spec.name.as_str(),
            "" | "python" | "python3" | "deno" | "test"
        ) || (snap.runt.env_id.is_none()
            && (snap.runt.uv.is_some() || snap.runt.conda.is_some() || snap.runt.pixi.is_some())))
    {
        return None;
    }
    Some(spec.name.clone())
}

fn roots() -> Vec<PathBuf> {
    let mut roots: Vec<_> = env::var_os("JUPYTER_PATH")
        .iter()
        .flat_map(|s| env::split_paths(s))
        .filter(|p| p.is_absolute())
        .take(64)
        .collect();
    let user = env::var_os("JUPYTER_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            if cfg!(target_os = "macos") {
                dirs::home_dir().map(|p| p.join("Library/Jupyter"))
            } else {
                dirs::data_dir().map(|p| p.join("jupyter"))
            }
        });
    let prefixes = ["VIRTUAL_ENV", "CONDA_PREFIX", "MAMBA_ROOT_PREFIX"]
        .into_iter()
        .filter_map(env::var_os)
        .map(|p| PathBuf::from(p).join("share/jupyter"));
    if env::var("JUPYTER_PREFER_ENV_PATH")
        .is_ok_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
    {
        roots.extend(prefixes);
        roots.extend(user);
    } else {
        roots.extend(user);
        roots.extend(prefixes);
    }
    #[cfg(unix)]
    roots.extend([
        PathBuf::from("/usr/local/share/jupyter"),
        PathBuf::from("/usr/share/jupyter"),
    ]);
    #[cfg(windows)]
    roots.extend(env::var_os("PROGRAMDATA").map(|p| PathBuf::from(p).join("jupyter")));
    let mut seen = BTreeSet::new();
    roots
        .into_iter()
        .filter(|p| p.is_absolute() && seen.insert(p.clone()))
        .map(|p| p.join("kernels"))
        .collect()
}

impl Definition {
    fn load(dir: PathBuf) -> Result<Self> {
        let path = dir.join("kernel.json");
        ensure!(
            fs::metadata(&path)?.is_file(),
            "kernel.json is not a regular file"
        );
        let mut bytes = Vec::new();
        fs::File::open(&path)?.take(65537).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 65536, "kernel.json exceeds 64 KiB");
        let mut spec: Self = serde_json::from_slice(&bytes)?;
        ensure!(
            spec.argv.first().is_some_and(|s| !s.is_empty())
                && spec.argv.iter().any(|s| s.contains("{connection_file}")),
            "argv needs a program and {{connection_file}}"
        );
        ensure!(
            !spec.language.is_empty() && !spec.display_name.is_empty(),
            "missing language or display name"
        );
        spec.resource_dir = dir;
        ensure!(
            spec.language.len() <= 128 && spec.display_name.len() <= 1024,
            "language or display name exceeds catalog limits"
        );
        ensure!(
            !spec.argv.iter().any(|a| a.contains('\0'))
                && spec
                    .env
                    .iter()
                    .all(|(k, v)| !k.is_empty() && !k.contains(['\0', '=']) && !v.contains('\0')),
            "argv or env contains invalid process arguments"
        );
        Ok(spec)
    }
    pub fn info(&self, name: &str) -> InstalledKernelspec {
        InstalledKernelspec {
            name: name.to_ascii_lowercase(),
            display_name: self.display_name.clone(),
            language: self.language.clone(),
        }
    }
    pub fn command(&self, connection: &Path) -> Result<tokio::process::Command> {
        let expand = |s: &String| {
            s.replace("{resource_dir}", &self.resource_dir.to_string_lossy())
                .replace("{connection_file}", &connection.to_string_lossy())
        };
        let program = PathBuf::from(expand(&self.argv[0]));
        // Never resolve a bare program relative to the notebook directory.
        let path = if program.is_absolute() {
            Some(program.clone())
        } else if program.components().count() == 1 {
            let path = self
                .env
                .get("PATH")
                .map(|s| std::ffi::OsString::from(expand_env(s)))
                .or_else(|| env::var_os("PATH"))
                .unwrap_or_default();
            env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .map(|p| p.join(&program))
                .flat_map(|p| {
                    #[cfg(windows)]
                    if p.extension().is_none() {
                        return vec![p.with_extension("exe"), p];
                    }
                    vec![p]
                })
                .find(|p| executable(p))
        } else {
            None
        };
        let executable = path
            .filter(|p| executable(p))
            .with_context(|| format!("Kernelspec executable unavailable: {}", program.display()))?;
        let mut cmd = tokio::process::Command::new(executable);
        cmd.args(self.argv.iter().skip(1).map(expand));
        Ok(cmd)
    }

    pub fn apply_env(&self, cmd: &mut tokio::process::Command) {
        cmd.envs(self.env.iter().map(|(k, v)| (k, expand_env(v))));
    }
}

fn executable(path: &Path) -> bool {
    let Ok(meta) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    meta.is_file()
}

/// Jupyter substitutes inherited variables once; values are never evaluated by a shell.
fn expand_env(value: &str) -> String {
    let mut result = String::new();
    let mut rest = value;
    while let Some((prefix, after)) = rest.split_once('$') {
        result.push_str(prefix);
        if let Some(next) = after.strip_prefix('$') {
            result.push('$');
            rest = next;
            continue;
        }
        let braced = after.starts_with('{');
        let start = if braced { &after[1..] } else { after };
        let len = start
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        if len > 0
            && !start.as_bytes()[0].is_ascii_digit()
            && (!braced || start[len..].starts_with('}'))
        {
            let end = len + if braced { 2 } else { 0 };
            let key = &start[..len];
            let allowed = !crate::jupyter_kernel::KERNEL_ENV_SECRET_BLOCKLIST
                .iter()
                .any(|s| s.eq_ignore_ascii_case(key));
            if let Some(v) = allowed.then(|| env::var(key).ok()).flatten() {
                result.push_str(&v);
            } else {
                result.push('$');
                result.push_str(&after[..end]);
            }
            rest = &after[end..];
        } else {
            result.push('$');
            rest = after;
        }
    }
    result.push_str(rest);
    result
}

fn scan(
    roots: &[PathBuf],
    only: Option<&str>,
) -> (KernelspecInventory, Option<Result<Definition>>) {
    let mut inventory = KernelspecInventory::default();
    let mut seen = BTreeSet::new();
    let mut remaining = 512;
    for root in roots {
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                inventory.warnings.push(format!("{}: {e}", root.display()));
                continue;
            }
        };
        let mut names = Vec::new();
        for entry in entries {
            if remaining == 0 {
                inventory.truncated = true;
                break;
            }
            remaining -= 1;
            match entry {
                Ok(e) => {
                    if let Some(name) = e.file_name().to_str().filter(|s| valid_name(s)) {
                        names.push(name.to_owned());
                    }
                }
                Err(e) => inventory.warnings.push(format!("{}: {e}", root.display())),
            }
        }
        names.sort();
        for name in names {
            if only.is_some_and(|s| !s.eq_ignore_ascii_case(&name))
                || !seen.insert(name.to_ascii_lowercase())
            {
                continue;
            }
            let dir = root.join(&name);
            let spec = Definition::load(dir.clone())
                .with_context(|| format!("{}", dir.join("kernel.json").display()));
            if only.is_some() {
                return (inventory, Some(spec));
            }
            match spec {
                Ok(spec) => inventory.kernelspecs.push(spec.info(&name)),
                Err(e) => inventory.warnings.push(format!("{e:#}")),
            }
        }
        if inventory.truncated {
            break;
        }
    }
    inventory.kernelspecs.sort_by(|a, b| a.name.cmp(&b.name));
    (inventory, None)
}

pub(crate) async fn inventory() -> Result<KernelspecInventory> {
    Ok(tokio::task::spawn_blocking(|| scan(&roots(), None).0).await?)
}

pub(crate) fn persist(
    room: &crate::notebook_sync_server::NotebookRoom,
    doc: &mut notebook_doc::NotebookDoc,
    target: Option<&InstalledKernelspec>,
    language: &str,
) -> Result<()> {
    let mut snap = doc.get_metadata_snapshot().unwrap_or_default();
    if let Some(spec) = target {
        snap.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
            name: spec.name.clone(),
            display_name: spec.display_name.clone(),
            language: Some(spec.language.clone()),
            ..Default::default()
        });
        snap.runt
            .extra
            .insert("installed_kernelspec".into(), spec.name.clone().into());
    } else if snap.runt.extra.remove("installed_kernelspec").is_some()
        || imported(Some(&snap), Default::default()).is_some()
    {
        let (name, display, lang) = if language == "deno" {
            ("deno", "Deno", "typescript")
        } else {
            ("python3", "Python 3", "python")
        };
        snap.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
            name: name.into(),
            display_name: display.into(),
            language: Some(lang.into()),
            ..Default::default()
        });
    } else {
        return Ok(());
    }
    let actor = doc.get_actor_id();
    let rollback = doc.save();
    let heads = doc.get_heads();
    doc.transact_at_heads_recovering(
        &heads,
        Some("runtimed:metadata"),
        "kernelspec-selection",
        |doc| doc.set_metadata_snapshot(&snap),
    )?;
    crate::notebook_sync_server::durability::commit_daemon_notebook_mutation(
        room,
        doc,
        &heads,
        &rollback,
        &actor,
        "kernelspec selection",
    )
    .map_err(anyhow::Error::msg)?;
    let _ = room.broadcasts.changed_tx.send(());
    Ok(())
}
pub(crate) async fn resolve(name: String) -> Result<Definition> {
    ensure!(valid_name(&name), "Invalid kernelspec name: {name}");
    tokio::task::spawn_blocking(move || {
        let (inventory, result) = scan(&roots(), Some(&name));
        if let Some(result) = result {
            return result;
        }
        bail!(
            "Installed kernelspec '{name}' not found{}",
            if inventory.truncated {
                " (search limit reached)"
            } else {
                ""
            }
        )
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precedence_errors_and_command_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let roots = [temp.path().join("first"), temp.path().join("second")];
        let exe = std::env::current_exe().unwrap();
        let json = serde_json::json!({"argv":[exe,"--project=@.","{resource_dir}/kernel file.jl","--connection={connection_file}"],"display_name":"IJulia","language":"julia","env":{"MARK":"a b"}});
        for root in &roots {
            let dir = root.join("Julia-1.11");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("kernel.json"), json.to_string()).unwrap();
        }
        let (inv, _) = scan(&roots, None);
        assert_eq!(inv.kernelspecs.len(), 1);
        assert_eq!(inv.kernelspecs[0].name, "julia-1.11");
        let spec = scan(&roots, Some("julia-1.11")).1.unwrap().unwrap();
        assert_eq!(spec.env["MARK"], "a b");
        assert_eq!(spec.interrupt_mode, InterruptMode::Signal);
        let cmd = spec
            .command(Path::new("space dir/connection.json"))
            .unwrap();
        let args: Vec<_> = cmd.as_std().get_args().collect();
        assert_eq!(args[0], "--project=@.");
        assert_eq!(args[1], roots[0].join("Julia-1.11/kernel file.jl"));
        assert_eq!(args[2], "--connection=space dir/connection.json");
        let mut ark = json;
        ark["language"] = "R".into();
        ark["interrupt_mode"] = "message".into();
        ark["argv"][0] = temp.path().join("missing-ark").display().to_string().into();
        fs::write(roots[0].join("Julia-1.11/kernel.json"), ark.to_string()).unwrap();
        let spec = scan(&roots, Some("julia-1.11")).1.unwrap().unwrap();
        assert_eq!(spec.interrupt_mode, InterruptMode::Message);
        assert!(spec
            .command(Path::new("file"))
            .unwrap_err()
            .to_string()
            .contains("missing-ark"));
        fs::write(roots[0].join("Julia-1.11/kernel.json"), "{").unwrap();
        let (inv, _) = scan(&roots, None);
        assert!(inv.kernelspecs.is_empty());
        assert_eq!(inv.warnings.len(), 1);
        assert!(inv.warnings[0].contains("kernel.json"));
        assert!(scan(&roots, Some("not-installed")).1.is_none());
        for name in ["../lumen", "/abs", "..", ".", "C:\\kernel"] {
            assert!(!valid_name(name));
        }
    }

    #[test]
    fn imported_name_and_managed_mode_precedence() {
        use notebook_protocol::connection::CreateNotebookEnvironmentMode as Mode;
        let mut snap = notebook_doc::metadata::NotebookMetadataSnapshot::default();
        snap.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
            name: "lumen".into(),
            ..Default::default()
        });
        snap.runt.env_id = Some("captured".into());
        assert_eq!(imported(Some(&snap), Mode::Auto).as_deref(), Some("lumen"));
        assert_eq!(imported(Some(&snap), Mode::Project), None);
        snap.kernelspec.as_mut().unwrap().name = "python3".into();
        assert_eq!(imported(Some(&snap), Mode::Auto), None);
        snap.runt
            .extra
            .insert("installed_kernelspec".into(), "python3".into());
        assert_eq!(
            imported(Some(&snap), Mode::Auto).as_deref(),
            Some("python3")
        );
    }
}
