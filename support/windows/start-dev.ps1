[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repositoryPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$desktopPath = Join-Path $repositoryPath 'apps/desktop'
$executablePath = Join-Path $repositoryPath 'target/debug/cursor-byok-desktop.exe'
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$null = Get-Command cargo.exe -ErrorAction Stop

if (-not (Test-Path -LiteralPath (Join-Path $desktopPath 'node_modules/.bin/tauri.cmd')))
{
    throw "Install dependencies first: npm --prefix `"$desktopPath`" ci"
}

if ($Check)
{
    Write-Output "Development prerequisites ready: $repositoryPath"
    exit 0
}

$running = Get-CimInstance Win32_Process -Filter "Name = 'cursor-byok-desktop.exe'" |
    Where-Object { $_.ExecutablePath -eq $executablePath }
if ($running)
{
    # The app's single-instance handler shows the existing window.
    Start-Process -FilePath $executablePath -WorkingDirectory $repositoryPath -WindowStyle Hidden
    exit 0
}

if (Get-NetTCPConnection -State Listen -LocalPort 1420 -ErrorAction SilentlyContinue)
{
    throw 'Development port 1420 is already occupied. Check its owner before starting another app.'
}

$logDirectory = Join-Path $repositoryPath 'target'
$null = New-Item -ItemType Directory -Path $logDirectory -Force
$logPath = Join-Path $logDirectory 'windows-dev.log'

Push-Location -LiteralPath $desktopPath
try
{
    # Cargo emits normal build progress on stderr, including under Windows PowerShell.
    $ErrorActionPreference = 'Continue'
    & $npmCommand run tauri:dev *> $logPath
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0)
    {
        throw "Development startup failed. See $logPath"
    }
}
finally
{
    Pop-Location
}
