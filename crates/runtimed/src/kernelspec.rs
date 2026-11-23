//! Installed definitions belong to the local machine, not the notebook document.
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{bail, ensure, Context, Result};
use notebook_protocol::protocol::{
    InstalledKernelspec, KernelspecInterrupt as InterruptMode, KernelspecInventory,
    KernelspecLaunch,
};
use serde::Deserialize;

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
        .is_some_and(|name| name.eq_ignore_ascii_case(&spec.name));
    if !explicit
        && ["", "python", "python3", "deno"]
            .iter()
            .any(|s| spec.name.eq_ignore_ascii_case(s))
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
    pub fn prepare(
        self,
        overlay: &std::collections::HashMap<String, String>,
    ) -> Result<KernelspecLaunch> {
        ensure!(
            !self.argv[0].contains("{connection_file}"),
            "connection file cannot be a kernelspec executable"
        );
        let program = PathBuf::from(
            self.argv[0].replace("{resource_dir}", &self.resource_dir.to_string_lossy()),
        );
        let env: BTreeMap<_, _> = self
            .env
            .into_iter()
            .map(|(k, v)| (k, expand_env(&v, overlay)))
            .collect();
        // Never resolve a bare program relative to the notebook directory.
        let path = if program.is_absolute() {
            Some(program.clone())
        } else if program.components().count() == 1 {
            let path = env
                .get("PATH")
                .or_else(|| overlay.get("PATH"))
                .map(std::ffi::OsString::from)
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
        Ok(KernelspecLaunch {
            executable,
            args: self.argv.into_iter().skip(1).collect(),
            resource_dir: self.resource_dir,
            env,
            interrupt_mode: self.interrupt_mode,
        })
    }
}

pub async fn command(
    spec: &KernelspecLaunch,
    connection: &Path,
) -> Result<tokio::process::Command> {
    let Some(module) = protected_python_module(spec) else {
        return Ok(build_command(spec, connection, None));
    };
    let entry = crate::launcher_cache::kernel_entry_script()
        .await
        .context("Prepare protected entry script for installed Python kernel")?;
    Ok(build_command(spec, connection, Some((module, &entry))))
}

fn build_command(
    spec: &KernelspecLaunch,
    connection: &Path,
    entry: Option<(PythonModuleLaunch<'_>, &Path)>,
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(&spec.executable);
    let substitute = |s: &str| {
        s.replace("{resource_dir}", &spec.resource_dir.to_string_lossy())
            .replace("{connection_file}", &connection.to_string_lossy())
    };
    if let Some((module, entry)) = entry {
        cmd.args(spec.args[..module.index].iter().map(|s| substitute(s)));
        if !module.same_arg_flags.is_empty() {
            cmd.arg(module.same_arg_flags);
        }
        cmd.arg(entry).arg(substitute(module.name));
        cmd.args(
            spec.args[module.index + module.consumed..]
                .iter()
                .map(|s| substitute(s)),
        );
    } else {
        cmd.args(spec.args.iter().map(|s| substitute(s)));
    }
    cmd
}

struct PythonModuleLaunch<'a> {
    index: usize,
    consumed: usize,
    same_arg_flags: &'a str,
    name: &'a str,
}

fn protected_python_module(spec: &KernelspecLaunch) -> Option<PythonModuleLaunch<'_>> {
    python_module_launch(&spec.args).filter(|_| is_direct_python(&spec.executable))
}

/// Wrapped Python module launches are not rewritten: wrapper arguments are
/// wrapper-specific. Require an explicit launch when argv exposes such a command.
pub(crate) fn requires_explicit_launch(spec: &KernelspecLaunch) -> bool {
    !is_direct_python(&spec.executable)
        && spec.args.iter().enumerate().any(|(index, arg)| {
            is_python_executable(Path::new(arg))
                && python_module_launch(&spec.args[index + 1..]).is_some()
        })
}

fn python_module_launch(args: &[String]) -> Option<PythonModuleLaunch<'_>> {
    let mut args = args.iter().enumerate();
    while let Some((index, arg)) = args.next() {
        if arg == "--check-hash-based-pycs" {
            args.next()?;
            continue;
        }
        let flags = arg.strip_prefix('-')?;
        if flags.is_empty() || flags.starts_with('-') {
            return None;
        }
        // Parse short options as Python does: -X and -W take a value,
        // -c starts a command, and -m starts a module (ending option parsing).
        for (offset, flag) in flags.char_indices() {
            let rest = &flags[offset + flag.len_utf8()..];
            match flag {
                'X' | 'W' => {
                    if rest.is_empty() {
                        args.next()?;
                    }
                    break;
                }
                'm' => {
                    let (name, consumed) = if rest.is_empty() {
                        (args.next()?.1.as_str(), 2)
                    } else {
                        (rest, 1)
                    };
                    return Some(PythonModuleLaunch {
                        index,
                        consumed,
                        same_arg_flags: if offset == 0 { "" } else { &arg[..offset + 1] },
                        name,
                    });
                }
                'b' | 'B' | 'd' | 'E' | 'i' | 'I' | 'O' | 'P' | 'q' | 's' | 'S' | 'u' | 'v'
                | 'x' => {}
                _ => return None,
            }
        }
    }
    None
}

fn is_direct_python(executable: &Path) -> bool {
    // Use the executable name or its symlink target, not kernelspec metadata.
    is_python_executable(executable)
        || executable
            .canonicalize()
            .is_ok_and(|path| is_python_executable(&path))
}

fn is_python_executable(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    ["python", "pythonw", "pypy"].iter().any(|prefix| {
        name.strip_prefix(prefix).is_some_and(|suffix| {
            let version = suffix.strip_suffix('t').unwrap_or(suffix);
            suffix.is_empty()
                || (!version.is_empty()
                    && version
                        .split('.')
                        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())))
        })
    })
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
fn expand_env(value: &str, overlay: &std::collections::HashMap<String, String>) -> String {
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
            if let Some(v) = allowed
                .then(|| overlay.get(key).cloned().or_else(|| env::var(key).ok()))
                .flatten()
            {
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
    let previous = snap.kernelspec.clone();
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
    // A spec describes a language, not the version or MIME/lexer details of a running kernel.
    let previous_language = previous
        .as_ref()
        .and_then(|s| s.language.as_deref())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            snap.language_info
                .as_ref()
                .map(|info| info.name.as_str())
                .filter(|s| !s.is_empty())
        });
    if let Some(language) = snap.kernelspec.as_ref().and_then(|s| s.language.as_ref()) {
        if snap.language_info.is_none()
            || previous_language.is_some_and(|old| !old.eq_ignore_ascii_case(language))
        {
            snap.language_info = Some(notebook_doc::metadata::LanguageInfoSnapshot {
                name: language.clone(),
                ..Default::default()
            });
        }
    }
    if let (Some(previous), Some(next)) = (previous, snap.kernelspec.as_mut()) {
        if previous.name.eq_ignore_ascii_case(&next.name) {
            next.extras = previous.extras;
        }
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
    fn installed_python_module_argv_keeps_flags_and_substitutes_connection_file() {
        let entry = Path::new("/daemon/kernel-entry/kernel_entry.py");
        let connection = Path::new("space dir/connection.json");
        for (exe, flags, launch, expected) in [
            ("python", vec![], vec!["-m", "ipykernel_launcher"], vec![]),
            (
                "Python3.13t.exe",
                vec!["-Xfrozen_modules=off", "-W", "ignore", "-I"],
                vec!["-m", "custom.launcher"],
                vec!["-Xfrozen_modules=off", "-W", "ignore", "-I"],
            ),
            ("pypy3", vec![], vec!["-Bumipykernel_launcher"], vec!["-Bu"]),
            (
                "pythonw3.12.exe",
                vec!["-x"],
                vec!["-m", "ipykernel_launcher"],
                vec!["-x"],
            ),
        ] {
            let spec = KernelspecLaunch {
                executable: PathBuf::from(exe),
                args: flags
                    .iter()
                    .chain(&launch)
                    .copied()
                    .chain(["-f", "{connection_file}"])
                    .map(String::from)
                    .collect(),
                resource_dir: PathBuf::from("kernels/installed"),
                env: BTreeMap::new(),
                interrupt_mode: InterruptMode::Signal,
            };
            let module = protected_python_module(&spec).unwrap();
            let cmd = build_command(&spec, connection, Some((module, entry)));
            assert_eq!(cmd.as_std().get_program(), exe);
            let expected = expected
                .into_iter()
                .chain([
                    entry.to_str().unwrap(),
                    if exe == "Python3.13t.exe" {
                        "custom.launcher"
                    } else {
                        "ipykernel_launcher"
                    },
                    "-f",
                    connection.to_str().unwrap(),
                ])
                .collect::<Vec<_>>();
            assert_eq!(cmd.as_std().get_args().collect::<Vec<_>>(), expected);
        }
    }

    #[test]
    fn non_python_module_invocations_are_not_rewritten() {
        let connection = Path::new("connection.json");
        for (exe, args) in [
            ("julia", vec!["--project=@.", "kernel.jl"]),
            ("ark", vec!["-m", "logging"]),
            ("python", vec!["-c", "pass", "-m", "module"]),
            ("python", vec!["-W", "-m", "script.py"]),
            ("python", vec!["-B", "script.py", "-m", "module"]),
        ] {
            let spec = KernelspecLaunch {
                executable: PathBuf::from(exe),
                args: args
                    .iter()
                    .copied()
                    .chain(["{connection_file}"])
                    .map(String::from)
                    .collect(),
                resource_dir: PathBuf::from("kernels/installed"),
                env: BTreeMap::new(),
                interrupt_mode: InterruptMode::Signal,
            };
            assert!(protected_python_module(&spec).is_none());
            let cmd = build_command(&spec, connection, None);
            assert_eq!(cmd.as_std().get_program(), exe);
            let expected = args
                .into_iter()
                .chain(["connection.json"])
                .collect::<Vec<_>>();
            assert_eq!(cmd.as_std().get_args().collect::<Vec<_>>(), expected);
        }
    }

    #[test]
    fn pythonw_executables_are_recognized() {
        for executable in [
            "pythonw",
            "pythonw.exe",
            "PythonW3.12.exe",
            "bin/pythonw3.13t",
        ] {
            assert!(is_python_executable(Path::new(executable)), "{executable}");
        }
        for executable in ["python-wrapper", "pythonw-launcher.exe", "pythonw.dll"] {
            assert!(!is_python_executable(Path::new(executable)), "{executable}");
        }
    }

    #[test]
    fn wrapped_python_modules_require_explicit_launch() {
        for (executable, args, required) in [
            (
                "conda",
                vec!["run", "-n", "x", "python", "-m", "ipykernel_launcher"],
                true,
            ),
            (
                "/usr/bin/env",
                vec!["python3", "-W", "ignore", "-m", "entry"],
                true,
            ),
            (
                "uv",
                vec!["run", "python", "-Xfrozen_modules=off", "-m", "entry"],
                true,
            ),
            (
                "pixi",
                vec!["run", "{resource_dir}/bin/python3.12", "-Bumlauncher"],
                true,
            ),
            ("python", vec!["-m", "ipykernel_launcher"], false),
            ("pythonw.exe", vec!["-x", "-m", "ipykernel_launcher"], false),
            ("julia", vec!["--project=@.", "kernel.jl"], false),
            ("ark", vec!["-m", "ark_launcher"], false),
            (
                "conda",
                vec!["run", "python", "script.py", "-m", "arg"],
                false,
            ),
            ("env", vec!["python", "-c", "pass", "-m", "arg"], false),
            ("env", vec!["python", "-W", "-m", "script.py"], false),
        ] {
            let spec = KernelspecLaunch {
                executable: PathBuf::from(executable),
                args: args.into_iter().map(String::from).collect(),
                resource_dir: PathBuf::new(),
                env: BTreeMap::new(),
                interrupt_mode: InterruptMode::Signal,
            };
            assert_eq!(
                requires_explicit_launch(&spec),
                required,
                "{executable} {:?}",
                spec.args
            );
        }
    }

    #[tokio::test]
    async fn reapplied_kernelspec_metadata_round_trips_without_losing_details() {
        use notebook_doc::metadata::{LanguageInfoSnapshot, NotebookMetadataSnapshot};

        let temp = tempfile::tempdir().unwrap();
        let room = crate::notebook_sync_server::NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            std::sync::Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            true,
        );
        let mut doc = room.doc.write().await;
        let target = InstalledKernelspec {
            name: "lumen".into(),
            display_name: "Current name".into(),
            language: "python".into(),
        };
        for (name, previous_language, info_name, keep_extras, keep_info) in [
            ("Lumen", None, "Python", true, true),
            ("lumen", Some("PYTHON"), "python", true, true),
            ("other-python", None, "python", false, true),
            ("lumen", Some("julia"), "julia", true, false),
            ("julia", None, "julia", false, false),
        ] {
            let mut raw = serde_json::json!({
                "kernelspec": {"name": name, "display_name": "Original", "metadata": {"debugger": true}},
                "language_info": {"name": info_name, "version": "3.12.4", "mimetype": "text/x-python"},
                "custom": {"preserved": true}
            });
            if let Some(language) = previous_language {
                raw["kernelspec"]["language"] = language.into();
            }
            let initial = NotebookMetadataSnapshot::from_metadata_value(&raw);
            doc.set_metadata_snapshot(&initial).unwrap();
            persist(&room, &mut doc, Some(&target), "python").unwrap();
            let reopened = notebook_doc::NotebookDoc::load(&doc.save()).unwrap();
            let snapshot = reopened.get_metadata_snapshot().unwrap();
            let applied = snapshot.kernelspec.unwrap();
            assert_eq!(applied.name, target.name);
            assert_eq!(applied.display_name, target.display_name);
            assert_eq!(applied.language.as_deref(), Some("python"));
            if keep_extras {
                assert_eq!(applied.extras, initial.kernelspec.unwrap().extras, "{name}");
            } else {
                assert!(applied.extras.is_empty(), "{name}");
            }
            let expected_info = if keep_info {
                initial.language_info.unwrap()
            } else {
                LanguageInfoSnapshot {
                    name: "python".into(),
                    ..Default::default()
                }
            };
            assert_eq!(snapshot.language_info.unwrap(), expected_info, "{name}");
            assert_eq!(snapshot.extras, initial.extras);
            assert_eq!(snapshot.runt.extra["installed_kernelspec"], "lumen");
        }
    }

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
        let prepared = spec.prepare(&Default::default()).unwrap();
        let cmd = build_command(&prepared, Path::new("space dir/connection.json"), None);
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
            .prepare(&Default::default())
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
        let mut snap = notebook_doc::metadata::NotebookMetadataSnapshot {
            kernelspec: Some(notebook_doc::metadata::KernelspecSnapshot {
                name: "lumen".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        snap.runt.env_id = Some("captured".into());
        snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
            dependencies: vec!["numpy".into()],
            requires_python: None,
            prerelease: None,
        });
        assert_eq!(imported(Some(&snap), Mode::Auto).as_deref(), Some("lumen"));
        snap.runt.env_id = None;
        assert_eq!(imported(Some(&snap), Mode::Auto).as_deref(), Some("lumen"));
        snap.kernelspec.as_mut().unwrap().name = "test".into();
        assert_eq!(imported(Some(&snap), Mode::Auto).as_deref(), Some("test"));
        assert_eq!(imported(Some(&snap), Mode::Project), None);
        snap.kernelspec.as_mut().unwrap().name = "python3".into();
        assert_eq!(imported(Some(&snap), Mode::Auto), None);
        snap.runt
            .extra
            .insert("installed_kernelspec".into(), "PYTHON3".into());
        assert_eq!(
            imported(Some(&snap), Mode::Auto).as_deref(),
            Some("python3")
        );
    }

    #[test]
    fn descriptor_freezes_program_arguments_interrupt_and_expanded_environment() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kernel.json");
        let exe = env::current_exe().unwrap();
        let json = serde_json::json!({"argv":[exe.file_name().unwrap().to_str().unwrap(),"{resource_dir}/startup file","{connection_file}"],"language":"R","display_name":"ark","env":{"PATH":"${TOOL_BIN}","MARK":"$USER_MARK $$ ${UNKNOWN_KSPEC_VAR}"},"interrupt_mode":"message"});
        fs::write(&file, json.to_string()).unwrap();
        let overlay = std::collections::HashMap::from([
            (
                "TOOL_BIN".into(),
                exe.parent().unwrap().display().to_string(),
            ),
            ("USER_MARK".into(), "one value".into()),
        ]);
        let prepared = Definition::load(dir.path().into())
            .unwrap()
            .prepare(&overlay)
            .unwrap();
        fs::write(file, "{}").unwrap();
        let transferred: KernelspecLaunch =
            serde_json::from_slice(&serde_json::to_vec(&prepared).unwrap()).unwrap();
        assert_eq!(transferred.interrupt_mode, InterruptMode::Message);
        assert_eq!(transferred.env["MARK"], "one value $ ${UNKNOWN_KSPEC_VAR}");
        let cmd = build_command(&transferred, Path::new("new connection"), None);
        assert_eq!(cmd.as_std().get_program(), exe);
        assert_eq!(cmd.as_std().get_args().last().unwrap(), "new connection");
    }
}
