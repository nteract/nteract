# Run on Windows with makensis on PATH. Never changes HKCU\Environment.
$ErrorActionPreference = 'Stop'
$testKey = 'Software\nteract\Tests\Path-' + [guid]::NewGuid().ToString('N')
$directory = 'C:\nteract-path-test\bin'
$noExpand = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$stringKind = [Microsoft.Win32.RegistryValueKind]::String
$expandKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
$key = $null

function Invoke-Fixture {
    $process = Start-Process -FilePath (Join-Path $PSScriptRoot 'test-user-path.exe') -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Fixture exited with $($process.ExitCode)" }
}

function Assert-Path($name, $initial, $kind, $expected, $expectedKind) {
    $key.DeleteValue('Path', $false)
    if ($null -ne $initial) { $key.SetValue('Path', $initial, $kind) }
    Invoke-Fixture
    $actual = $key.GetValue('Path', $null, $noExpand)
    if ($actual -cne $expected -or $key.GetValueKind('Path') -ne $expectedKind) {
        throw "${name}: PATH content or registry type changed unexpectedly"
    }
    Write-Host "PASS: $name"
}

Push-Location $PSScriptRoot
try {
    & makensis /V2 "/DTEST_KEY=$testKey" test-user-path.nsi
    if ($LASTEXITCODE -ne 0) { throw 'NSIS fixture compilation failed' }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($testKey)
    Invoke-Fixture
    $limit = [int]$key.GetValue('StringLimit')

    Assert-Path 'missing PATH' $null $expandKind $directory $expandKind
    Assert-Path 'empty PATH' '' $stringKind $directory $stringKind
    $raw = '%USERPROFILE%\tools;C:\existing'
    Assert-Path 'unexpanded variables' $raw $expandKind "$raw;$directory" $expandKind
    Assert-Path 'REG_SZ stays literal' $raw $stringKind "$raw;$directory" $stringKind
    $present = "C:\existing;$directory"
    Assert-Path 'repeat install' $present $expandKind $present $expandKind
    $fits = 'x' * ($limit - $directory.Length - 2)
    Assert-Path 'append just fits' $fits $expandKind "$fits;$directory" $expandKind
    $overflows = $fits + 'x'
    Assert-Path 'append would truncate' $overflows $expandKind $overflows $expandKind
    $long = '%USERPROFILE%\tools;' + ('x' * ($limit * 2)) + ';C:\last-entry'
    Assert-Path 'oversized PATH' $long $expandKind $long $expandKind
    Assert-Path 'oversized literal PATH' $long $stringKind $long $stringKind
    Assert-Path 'unsupported value type' 42 ([Microsoft.Win32.RegistryValueKind]::DWord) 42 ([Microsoft.Win32.RegistryValueKind]::DWord)
} finally {
    if ($null -ne $key) { $key.Dispose() }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKey, $false)
    Remove-Item (Join-Path $PSScriptRoot 'test-user-path.exe') -ErrorAction SilentlyContinue
    Pop-Location
}
