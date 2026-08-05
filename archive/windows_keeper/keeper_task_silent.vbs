' keeper_task_silent.vbs
' Silent launcher for the CryptoNova keeper.
' Runs keeper_task.bat with window style 0 (fully hidden, no cmd flicker).
' Called by Task Scheduler instead of keeper_task.bat directly.
'
' To retarget the existing task:
'   schtasks /change /tn "CryptoNova Keeper V8.16" /tr "wscript.exe \"C:\CryptoNite-Smart-Contracts\CryptoNova\keeper_task_silent.vbs\""

Dim oShell
Set oShell = CreateObject("WScript.Shell")

' 0 = hidden window, False = fire-and-forget (VBS exits, node runs in background)
oShell.Run "cmd /c """ & "C:\CryptoNite-Smart-Contracts\CryptoNova\keeper_task.bat" & """", 0, False

Set oShell = Nothing
