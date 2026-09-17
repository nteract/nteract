# Run on Windows with makensis on PATH. Never changes HKCU\Environment.
$ErrorActionPreference = 'Stop'
$testKey = 'Software\nteract\Tests\Path-' + [guid]::NewGuid().ToString('N')
$directory = 'C:\nteract-path-test\bin'
$noExpand = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$stringKind = [Microsoft.Win32.RegistryValueKind]::String
$expandKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
$key = $null
$productName = 'nteract PATH fixture-' + [guid]::NewGuid().ToString('N')
$logDirectory = Join-Path $env:LOCALAPPDATA $productName
$logFile = Join-Path $logDirectory 'install-bootstrap.log'

function Invoke-Fixture($expectedWarning = '') {
    $previousLog = if (Test-Path $logFile) { [IO.File]::ReadAllText($logFile) } else { '' }
    $process = Start-Process -FilePath (Join-Path $PSScriptRoot 'test-user-path.exe') -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Fixture exited with $($process.ExitCode)" }
    $expectedLog = $previousLog + "PATH fixture started`r`n" + $expectedWarning + "PATH fixture complete`r`n"
    if ([IO.File]::ReadAllText($logFile) -cne $expectedLog) {
        throw 'Bootstrap log lost or changed an earlier message'
    }
}

function Assert-Path($name, $initial, $kind, $expected, $expectedKind, $expectedWarning = '') {
    $key.DeleteValue('Path', $false)
    if ($null -ne $initial) { $key.SetValue('Path', $initial, $kind) }
    Invoke-Fixture $expectedWarning
    $actual = $key.GetValue('Path', $null, $noExpand)
    if ($actual -cne $expected -or $key.GetValueKind('Path') -ne $expectedKind) {
        throw "${name}: PATH content or registry type changed unexpectedly"
    }
    Write-Host "PASS: $name"
}

Push-Location $PSScriptRoot
try {
    & makensis /V2 "/DTEST_KEY=$testKey" "/DPRODUCTNAME=$productName" test-user-path.nsi
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
    $overflowWarning = "Preserved user PATH: appending would exceed the installer string limit. Add $directory to PATH manually.`r`n"
    $readWarning = "Preserved user PATH: the installer could not safely read it. Add $directory to PATH manually.`r`n"
    Assert-Path 'append would truncate' $overflows $expandKind $overflows $expandKind $overflowWarning
    $long = '%USERPROFILE%\tools;' + ('x' * ($limit * 2)) + ';C:\last-entry'
    Assert-Path 'oversized PATH' $long $expandKind $long $expandKind $readWarning
    Assert-Path 'oversized literal PATH' $long $stringKind $long $stringKind $readWarning
    Assert-Path 'unsupported value type' 42 ([Microsoft.Win32.RegistryValueKind]::DWord) 42 ([Microsoft.Win32.RegistryValueKind]::DWord) $readWarning
} finally {
    if ($null -ne $key) { $key.Dispose() }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKey, $false)
    Remove-Item (Join-Path $PSScriptRoot 'test-user-path.exe') -ErrorAction SilentlyContinue
    Remove-Item $logDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Pop-Location
}
