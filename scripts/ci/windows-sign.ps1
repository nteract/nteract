# Signs one file with Azure Artifact Signing for a Windows release build.
#
# Tauri runs this as its signCommand, once per binary and again from NSIS for
# the uninstaller. Each call requests a fresh GitHub OIDC token and hands it to
# the signing dlib through WorkloadIdentityCredential, which trades it for an
# Entra token through the federated credential on the NumFOCUS signing app.
# There is no client secret. The job must declare `id-token: write` and run in
# the environment that credential names.
#
# The release job sets every variable checked below; see the "Prepare Artifact
# Signing" step in .github/workflows/release-common.yml.
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"

foreach ($name in @(
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "SIGNTOOL_PATH",
    "ARTIFACT_SIGNING_DLIB",
    "ARTIFACT_SIGNING_METADATA"
  )) {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing signing environment: $name" }
}

$request = "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=api://AzureADTokenExchange"
$token = (Invoke-RestMethod -Uri $request -Headers @{ Authorization = "Bearer $($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN)" }).value
if (-not $token) { throw "GitHub returned no OIDC token" }

# WorkloadIdentityCredential reads the token from this file. The client and
# tenant ids come from the job environment.
$tokenFile = Join-Path $env:RUNNER_TEMP ("artifact-signing-" + [guid]::NewGuid().ToString("N") + ".jwt")
try {
  Set-Content -Path $tokenFile -Value $token -NoNewline -Encoding ascii
  $env:AZURE_FEDERATED_TOKEN_FILE = $tokenFile

  & $env:SIGNTOOL_PATH sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 `
    /dlib $env:ARTIFACT_SIGNING_DLIB /dmdf $env:ARTIFACT_SIGNING_METADATA /d nteract $Path
  if ($LASTEXITCODE -ne 0) { throw "signtool exited $LASTEXITCODE for $Path" }
} finally {
  Remove-Item -Path $tokenFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:AZURE_FEDERATED_TOKEN_FILE -ErrorAction SilentlyContinue
}
