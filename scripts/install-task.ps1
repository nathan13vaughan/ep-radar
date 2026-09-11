# Registers a Windows scheduled task that checks for new jobs every few hours while you're logged in.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 [-EveryHours 2]
param([int]$EveryHours = 2)

$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'scripts\run-hidden.vbs'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours $EveryHours)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
# Interactive logon so the desktop notifications can appear.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName 'EP Job Observer' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Scheduled 'EP Job Observer' to run every $EveryHours hour(s). Log: $root\logs\observer.log"
