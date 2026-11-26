param(
    [int]$DelaySeconds = 0,
    [string]$ExePath = (Join-Path $PSScriptRoot '..\target\release\cursor-byok-desktop.exe'),
    [string]$LogPath = (Join-Path $env:TEMP 'cursor-byok-restart.log')
)

$ErrorActionPreference = 'Stop'

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

$resolvedExe = [System.IO.Path]::GetFullPath($ExePath)
$releaseDir = Split-Path -Parent $resolvedExe
$stagedOld = Join-Path $releaseDir 'cursor-byok-desktop.running.exe'

Set-Content -LiteralPath $LogPath -Value '' -Encoding UTF8
Write-Log "Restart requested for $resolvedExe (delay=${DelaySeconds}s)"

if ($DelaySeconds -gt 0) {
    Start-Sleep -Seconds $DelaySeconds
}

if (-not (Test-Path -LiteralPath $resolvedExe)) {
    Write-Log "ERROR: Target executable not found: $resolvedExe"
    exit 1
}

$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq 'cursor-byok-desktop' -or $_.ProcessName -eq 'cursor-byok-desktop.running'
})

if ($running.Count -gt 0) {
    Write-Log ("Closing existing process(es): " + (($running | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ', '))
    foreach ($proc in $running) {
        try {
            if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
                $null = $proc.CloseMainWindow()
            }
        } catch {}
    }

    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        $alive = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -eq 'cursor-byok-desktop' -or $_.ProcessName -eq 'cursor-byok-desktop.running'
        })
        if ($alive.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }

    $stillAlive = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -eq 'cursor-byok-desktop' -or $_.ProcessName -eq 'cursor-byok-desktop.running'
    })
    foreach ($proc in $stillAlive) {
        Write-Log "Force stopping $($proc.ProcessName)#$($proc.Id)"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }

    $waitDeadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $waitDeadline) {
        $alive = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -eq 'cursor-byok-desktop' -or $_.ProcessName -eq 'cursor-byok-desktop.running'
        })
        if ($alive.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }
}

if (Test-Path -LiteralPath $stagedOld) {
    $rmDeadline = (Get-Date).AddSeconds(5)
    while ((Test-Path -LiteralPath $stagedOld) -and (Get-Date) -lt $rmDeadline) {
        try {
            Remove-Item -LiteralPath $stagedOld -Force -ErrorAction Stop
            Write-Log "Removed superseded executable: $stagedOld"
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
}

Write-Log "Launching $resolvedExe"
$started = Start-Process -FilePath $resolvedExe -WorkingDirectory $releaseDir -PassThru
Write-Log "Started cursor-byok-desktop PID $($started.Id)"

$readyDeadline = (Get-Date).AddSeconds(15)
$listening = @()
while ((Get-Date) -lt $readyDeadline) {
    if ($started.HasExited) {
        Write-Log "ERROR: New process exited early with code $($started.ExitCode)"
        exit 1
    }
    $listening = @(Get-NetTCPConnection -OwningProcess $started.Id -State Listen -ErrorAction SilentlyContinue)
    if ($listening.Count -gt 0) {
        break
    }
    Start-Sleep -Milliseconds 250
}

if ($listening.Count -gt 0) {
    $ports = ($listening | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ', '
    Write-Log "Ready: PID $($started.Id) listening on $ports"
} else {
    Write-Log "WARNING: PID $($started.Id) is running but no listening port detected within 15s"
}
