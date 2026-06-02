# CryptoNite Git Sync — Task Scheduler Setup
# Run this once in PowerShell (no admin needed)
# Creates a task that runs git_sync.py every 30 minutes

$taskName = "CryptoNite-Git-Sync"
$pythonPath = (Get-Command python).Source
$scriptPath = "C:\CryptoNite-MT5-Bots\git_sync.py"
$workingDir = "C:\CryptoNite-MT5-Bots"

# Remove old task if it exists
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Define the action: run python git_sync.py
$action = New-ScheduledTaskAction `
    -Execute $pythonPath `
    -Argument $scriptPath `
    -WorkingDirectory $workingDir

# Trigger: every 30 minutes, starting now, running indefinitely
$trigger = New-ScheduledTaskTrigger `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -Once `
    -At (Get-Date)

# Settings: run whether logged on or not, don't stop if on battery
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# Register the task for the current user
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Auto-syncs CryptoNite MT5 bot files to GitHub every 30 minutes." `
    -RunLevel Limited `
    -Force

Write-Host ""
Write-Host "Task '$taskName' created successfully!" -ForegroundColor Green
Write-Host "It will run every 30 minutes automatically."
Write-Host ""
Write-Host "To run it right now: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "To check status:     Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
Write-Host "To remove it:        Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
