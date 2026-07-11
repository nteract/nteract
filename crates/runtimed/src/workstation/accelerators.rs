//! Native workstation accelerator inventory.
//!
//! The inventory describes devices this workstation agent can detect and, when
//! a vendor probe succeeds, access through the local runtime. It deliberately
//! does not report free memory, idle devices, or schedulable capacity.

use runtime_doc::WorkstationAcceleratorState;

#[cfg(any(target_os = "linux", target_os = "macos", test))]
use std::collections::BTreeMap;
#[cfg(any(target_os = "linux", test))]
use std::path::Path;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::Duration;

#[cfg(target_os = "linux")]
const LINUX_PCI_DEVICES_PATH: &str = "/sys/bus/pci/devices";
#[cfg(target_os = "linux")]
const NVIDIA_SMI_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(target_os = "macos")]
const MACOS_SYSTEM_PROFILER_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(any(target_os = "linux", test))]
const NVIDIA_NOT_READY_DIAGNOSTIC: &str =
    "NVIDIA GPU detected, but the workstation runtime could not query it. Check the NVIDIA driver and device access.";
#[cfg(any(target_os = "linux", target_os = "macos", test))]
const VENDOR_READINESS_UNKNOWN_DIAGNOSTIC: &str =
    "GPU detected, but this agent cannot yet verify runtime access for this vendor.";

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct LinuxGpuDevice {
    vendor: Option<String>,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum NvidiaProbe {
    Ready(String),
    Failed,
    NotRun,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct NvidiaGpu {
    model: String,
    memory_bytes: Option<u64>,
}

/// Detect the workstation's accelerator inventory for a bounded heartbeat snapshot.
///
/// `None` means this agent could not determine the inventory. `Some([])` means
/// the platform scan completed and found no accelerator. Entries describe
/// detected hardware; `readiness = "ready"` only means the vendor probe could
/// query the device from this runtime environment.
pub async fn detect_accelerators() -> Option<Vec<WorkstationAcceleratorState>> {
    #[cfg(target_os = "linux")]
    {
        let devices = scan_linux_gpu_devices(Path::new(LINUX_PCI_DEVICES_PATH))?;
        let has_nvidia = devices
            .iter()
            .any(|device| device.vendor.as_deref() == Some("NVIDIA"));
        let nvidia_probe = if has_nvidia {
            probe_nvidia_smi().await
        } else {
            NvidiaProbe::NotRun
        };
        Some(project_linux_accelerators(&devices, nvidia_probe))
    }

    #[cfg(target_os = "macos")]
    {
        probe_macos_accelerators().await
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
async fn probe_macos_accelerators() -> Option<Vec<WorkstationAcceleratorState>> {
    let mut command = tokio::process::Command::new("system_profiler");
    command
        .args(["SPDisplaysDataType", "-json", "-detailLevel", "mini"])
        .kill_on_drop(true);

    match tokio::time::timeout(MACOS_SYSTEM_PROFILER_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            parse_macos_display_inventory(&String::from_utf8_lossy(&output.stdout))
        }
        _ => None,
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_display_inventory(output: &str) -> Option<Vec<WorkstationAcceleratorState>> {
    let payload: serde_json::Value = serde_json::from_str(output).ok()?;
    let displays = payload.get("SPDisplaysDataType")?.as_array()?;
    let mut grouped = BTreeMap::<(Option<String>, Option<String>), u64>::new();

    for display in displays {
        let model = display
            .get("sppci_model")
            .or_else(|| display.get("_name"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let vendor = display
            .get("spdisplays_vendor")
            .and_then(serde_json::Value::as_str)
            .and_then(normalize_macos_vendor)
            .or_else(|| {
                model
                    .as_deref()
                    .filter(|value| value.starts_with("Apple "))
                    .map(|_| "Apple".to_string())
            });
        if vendor.is_none() && model.is_none() {
            continue;
        }
        *grouped.entry((vendor, model)).or_default() += 1;
    }

    Some(
        grouped
            .into_iter()
            .map(|((vendor, model), count)| WorkstationAcceleratorState {
                kind: "gpu".to_string(),
                vendor,
                model,
                count,
                memory_bytes_per_device: None,
                readiness: "unknown".to_string(),
                diagnostic: Some(VENDOR_READINESS_UNKNOWN_DIAGNOSTIC.to_string()),
            })
            .collect(),
    )
}

#[cfg(any(target_os = "macos", test))]
fn normalize_macos_vendor(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value.strip_prefix("sppci_vendor_").unwrap_or(value).trim();
    let value = value.split_once(" (0x").map_or(value, |(vendor, _)| vendor);
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(target_os = "linux")]
async fn probe_nvidia_smi() -> NvidiaProbe {
    let mut command = tokio::process::Command::new("nvidia-smi");
    command
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .kill_on_drop(true);

    match tokio::time::timeout(NVIDIA_SMI_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            NvidiaProbe::Ready(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        _ => NvidiaProbe::Failed,
    }
}

#[cfg(any(target_os = "linux", test))]
fn scan_linux_gpu_devices(root: &Path) -> Option<Vec<LinuxGpuDevice>> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut devices = Vec::new();

    for entry in entries {
        let entry = entry.ok()?;
        let class = std::fs::read_to_string(entry.path().join("class")).ok()?;
        if !is_gpu_pci_class(&class)? {
            continue;
        }
        let vendor = std::fs::read_to_string(entry.path().join("vendor"))
            .ok()
            .and_then(|vendor| pci_vendor_name(&vendor));
        devices.push(LinuxGpuDevice { vendor });
    }

    Some(devices)
}

#[cfg(any(target_os = "linux", test))]
fn is_gpu_pci_class(value: &str) -> Option<bool> {
    let value = value.trim().trim_start_matches("0x");
    u32::from_str_radix(value, 16)
        .ok()
        .map(|class| ((class >> 16) & 0xff) == 0x03)
}

#[cfg(any(target_os = "linux", test))]
fn pci_vendor_name(value: &str) -> Option<String> {
    match value
        .trim()
        .trim_start_matches("0x")
        .to_ascii_lowercase()
        .as_str()
    {
        "10de" => Some("NVIDIA".to_string()),
        "1002" => Some("AMD".to_string()),
        "8086" => Some("Intel".to_string()),
        "106b" => Some("Apple".to_string()),
        _ => None,
    }
}

#[cfg(any(target_os = "linux", test))]
fn project_linux_accelerators(
    devices: &[LinuxGpuDevice],
    nvidia_probe: NvidiaProbe,
) -> Vec<WorkstationAcceleratorState> {
    let nvidia_count = devices
        .iter()
        .filter(|device| device.vendor.as_deref() == Some("NVIDIA"))
        .count() as u64;
    let mut accelerators = project_nvidia_accelerators(nvidia_count, nvidia_probe);

    let mut unverified_vendors = BTreeMap::<Option<String>, u64>::new();
    for device in devices
        .iter()
        .filter(|device| device.vendor.as_deref() != Some("NVIDIA"))
    {
        *unverified_vendors.entry(device.vendor.clone()).or_default() += 1;
    }
    accelerators.extend(unverified_vendors.into_iter().map(|(vendor, count)| {
        WorkstationAcceleratorState {
            kind: "gpu".to_string(),
            vendor,
            model: None,
            count,
            memory_bytes_per_device: None,
            readiness: "unknown".to_string(),
            diagnostic: Some(VENDOR_READINESS_UNKNOWN_DIAGNOSTIC.to_string()),
        }
    }));
    accelerators
}

#[cfg(any(target_os = "linux", test))]
fn project_nvidia_accelerators(
    detected_count: u64,
    probe: NvidiaProbe,
) -> Vec<WorkstationAcceleratorState> {
    if detected_count == 0 {
        return Vec::new();
    }

    let parsed = match probe {
        NvidiaProbe::Ready(output) => parse_nvidia_smi_output(&output),
        NvidiaProbe::Failed | NvidiaProbe::NotRun => None,
    };
    let Some(gpus) = parsed else {
        return vec![not_ready_nvidia_accelerator(detected_count)];
    };

    let mut grouped = BTreeMap::<(String, Option<u64>), u64>::new();
    for gpu in gpus {
        *grouped.entry((gpu.model, gpu.memory_bytes)).or_default() += 1;
    }
    let ready_count: u64 = grouped.values().sum();
    let mut accelerators = grouped
        .into_iter()
        .map(
            |((model, memory_bytes_per_device), count)| WorkstationAcceleratorState {
                kind: "gpu".to_string(),
                vendor: Some("NVIDIA".to_string()),
                model: Some(model),
                count,
                memory_bytes_per_device,
                readiness: "ready".to_string(),
                diagnostic: None,
            },
        )
        .collect::<Vec<_>>();
    if ready_count < detected_count {
        accelerators.push(not_ready_nvidia_accelerator(detected_count - ready_count));
    }
    accelerators
}

#[cfg(any(target_os = "linux", test))]
fn not_ready_nvidia_accelerator(count: u64) -> WorkstationAcceleratorState {
    WorkstationAcceleratorState {
        kind: "gpu".to_string(),
        vendor: Some("NVIDIA".to_string()),
        model: None,
        count,
        memory_bytes_per_device: None,
        readiness: "not_ready".to_string(),
        diagnostic: Some(NVIDIA_NOT_READY_DIAGNOSTIC.to_string()),
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_nvidia_smi_output(output: &str) -> Option<Vec<NvidiaGpu>> {
    let mut gpus = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let (model, memory_mib) = line.rsplit_once(',')?;
        let model = model.trim();
        if model.is_empty() {
            return None;
        }
        let model = model.strip_prefix("NVIDIA ").unwrap_or(model);
        let memory_bytes = memory_mib
            .trim()
            .parse::<u64>()
            .ok()
            .and_then(|mib| mib.checked_mul(1024 * 1024));
        gpus.push(NvidiaGpu {
            model: model.to_string(),
            memory_bytes,
        });
    }
    (!gpus.is_empty()).then_some(gpus)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_pci_device(root: &Path, name: &str, class: &str, vendor: &str) {
        let device = root.join(name);
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("class"), class).unwrap();
        std::fs::write(device.join("vendor"), vendor).unwrap();
    }

    #[test]
    fn detects_usable_nvidia_a100_with_per_device_memory() {
        let temp = tempfile::TempDir::new().unwrap();
        add_pci_device(temp.path(), "0000-01-00.0", "0x030200", "0x10de");

        let devices = scan_linux_gpu_devices(temp.path()).unwrap();
        let accelerators = project_linux_accelerators(
            &devices,
            NvidiaProbe::Ready("NVIDIA A100-SXM4-80GB, 81920\n".to_string()),
        );

        assert_eq!(
            accelerators,
            vec![WorkstationAcceleratorState {
                kind: "gpu".to_string(),
                vendor: Some("NVIDIA".to_string()),
                model: Some("A100-SXM4-80GB".to_string()),
                count: 1,
                memory_bytes_per_device: Some(80 * 1024 * 1024 * 1024),
                readiness: "ready".to_string(),
                diagnostic: None,
            }]
        );
    }

    #[test]
    fn groups_identical_nvidia_gpus() {
        let temp = tempfile::TempDir::new().unwrap();
        add_pci_device(temp.path(), "0000-01-00.0", "0x030200", "0x10de");
        add_pci_device(temp.path(), "0000-02-00.0", "0x030200", "0x10de");

        let devices = scan_linux_gpu_devices(temp.path()).unwrap();
        let accelerators = project_linux_accelerators(
            &devices,
            NvidiaProbe::Ready(
                "NVIDIA A100-SXM4-80GB, 81920\nNVIDIA A100-SXM4-80GB, 81920\n".to_string(),
            ),
        );

        assert_eq!(accelerators.len(), 1);
        assert_eq!(accelerators[0].count, 2);
        assert_eq!(accelerators[0].readiness, "ready");
    }

    #[test]
    fn detected_nvidia_probe_failure_is_not_ready_with_actionable_diagnostic() {
        let temp = tempfile::TempDir::new().unwrap();
        add_pci_device(temp.path(), "0000-01-00.0", "0x030200", "0x10de");

        let devices = scan_linux_gpu_devices(temp.path()).unwrap();
        let accelerators = project_linux_accelerators(&devices, NvidiaProbe::Failed);

        assert_eq!(accelerators.len(), 1);
        assert_eq!(accelerators[0].readiness, "not_ready");
        assert_eq!(
            accelerators[0].diagnostic.as_deref(),
            Some(NVIDIA_NOT_READY_DIAGNOSTIC)
        );
    }

    #[test]
    fn successful_linux_scan_without_gpu_is_known_none() {
        let temp = tempfile::TempDir::new().unwrap();
        add_pci_device(temp.path(), "0000-00-1f.6", "0x020000", "0x8086");

        let devices = scan_linux_gpu_devices(temp.path()).unwrap();

        assert!(devices.is_empty());
        assert!(project_linux_accelerators(&devices, NvidiaProbe::NotRun).is_empty());
    }

    #[test]
    fn unreadable_linux_inventory_is_unknown() {
        let temp = tempfile::TempDir::new().unwrap();

        assert_eq!(
            scan_linux_gpu_devices(&temp.path().join("missing-pci-devices")),
            None
        );

        let unreadable_device = temp.path().join("0000-01-00.0");
        std::fs::create_dir_all(unreadable_device).unwrap();
        assert_eq!(scan_linux_gpu_devices(temp.path()), None);
    }

    #[test]
    fn non_nvidia_gpu_stays_structured_with_unknown_readiness() {
        let temp = tempfile::TempDir::new().unwrap();
        add_pci_device(temp.path(), "0000-03-00.0", "0x030000", "0x1002");

        let devices = scan_linux_gpu_devices(temp.path()).unwrap();
        let accelerators = project_linux_accelerators(&devices, NvidiaProbe::NotRun);

        assert_eq!(accelerators.len(), 1);
        assert_eq!(accelerators[0].vendor.as_deref(), Some("AMD"));
        assert_eq!(accelerators[0].count, 1);
        assert_eq!(accelerators[0].readiness, "unknown");
    }

    #[test]
    fn macos_display_inventory_reports_apple_gpu_as_detected_but_unverified() {
        let accelerators = parse_macos_display_inventory(
            r#"{
              "SPDisplaysDataType": [{
                "_name": "Apple M3 Max",
                "spdisplays_vendor": "sppci_vendor_Apple"
              }]
            }"#,
        )
        .unwrap();

        assert_eq!(
            accelerators,
            vec![WorkstationAcceleratorState {
                kind: "gpu".to_string(),
                vendor: Some("Apple".to_string()),
                model: Some("Apple M3 Max".to_string()),
                count: 1,
                memory_bytes_per_device: None,
                readiness: "unknown".to_string(),
                diagnostic: Some(VENDOR_READINESS_UNKNOWN_DIAGNOSTIC.to_string()),
            }]
        );
    }

    #[test]
    fn macos_empty_display_inventory_is_known_none() {
        assert_eq!(
            parse_macos_display_inventory(r#"{"SPDisplaysDataType": []}"#),
            Some(Vec::new())
        );
    }

    #[test]
    fn malformed_macos_display_inventory_is_unknown() {
        assert_eq!(parse_macos_display_inventory("not json"), None);
        assert_eq!(parse_macos_display_inventory(r#"{}"#), None);
    }
}
