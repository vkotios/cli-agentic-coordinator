param([string]$LogPath, [string]$PidFile, [string]$Title = "orch view")
# Read-only viewer for one orch run.
#
# It writes its OWN pid to $PidFile so the broker can close exactly this tab later
# by killing exactly this process (spike Q5: wt.exe is only a launcher and exits
# immediately, and WindowsTerminal.exe outlives its last tab, so neither pid is a
# usable handle). This window accepts no input and never touches the worktree.
$ErrorActionPreference = 'Continue'
Set-Content -Path $PidFile -Value $PID -Encoding ascii
$Host.UI.RawUI.WindowTitle = $Title
Write-Host "=== orch read-only view ==="
Write-Host "run log : $LogPath"
Write-Host "viewer  : pid $PID (closed by orch when the run reaches a terminal state)"
Write-Host "============================"
if (-not (Test-Path $LogPath)) { New-Item -ItemType File -Path $LogPath -Force | Out-Null }
# -Encoding UTF8 is MANDATORY (K6): opencode writes BOM-less UTF-8 and PowerShell 5.1's
# Get-Content defaults to the system ANSI code page, which renders "build - qwen..."
# as mojibake. The stream also carries raw ANSI escapes; Windows Terminal renders them.
Get-Content -Path $LogPath -Wait -Tail 200 -Encoding UTF8
