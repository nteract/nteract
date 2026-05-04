param(
  [string]$Version = $env:TAURI_CLI_VERSION
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $Version) {
  $Version = "2.11.0"
}

$procArch = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE", [EnvironmentVariableTarget]::Machine)
switch ($procArch) {
  "AMD64" { $target = "x86_64-pc-windows-msvc" }
  "ARM64" { $target = "aarch64-pc-windows-msvc" }
  default { throw "Unsupported Windows processor architecture: $procArch" }
}

$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $HOME ".cargo" }
$cargoBin = Join-Path $cargoHome "bin"
New-Item -ItemType Directory -Force -Path $cargoBin | Out-Null

if ($env:GITHUB_PATH) {
  Add-Content -Path $env:GITHUB_PATH -Value $cargoBin
}
$env:PATH = "$cargoBin;$env:PATH"

$assetName = "cargo-tauri-$target.zip"
$url = "https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v$Version/$assetName"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  $zip = Join-Path $tmp $assetName
  Write-Host "Installing Tauri CLI v$Version for $target from $url"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force

  $cargoTauri = Get-ChildItem -Path $tmp -Filter "cargo-tauri.exe" -Recurse | Select-Object -First 1
  if (-not $cargoTauri) {
    throw "Downloaded archive did not contain cargo-tauri.exe"
  }

  Copy-Item -Path $cargoTauri.FullName -Destination (Join-Path $cargoBin "cargo-tauri.exe") -Force
  Write-Host "Installed cargo-tauri.exe to $cargoBin"
} catch {
  Write-Warning "Direct Tauri CLI download failed: $_"
  Write-Host "Falling back to cargo install tauri-cli --version $Version"
  cargo install tauri-cli --version $Version --locked --force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

cargo tauri --version
