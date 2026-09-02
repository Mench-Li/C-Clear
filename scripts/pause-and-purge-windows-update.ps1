# C-Clear 辅助脚本：暂停 Windows 更新 + 清空更新缓存
# 用途：当大版本更新（如 23H2 -> 24H2）在后台下载了数十 GB 暂存（$WINDOWS.~BT + SoftwareDistribution\Download），
#       可暂停更新并清空这两处，立即回收空间。
# 用法：以管理员身份运行，或由 DSH 用 Start-Process -Verb RunAs 提权调用（会弹 UAC）。
# 注意：脚本为纯 ASCII，兼容 Windows PowerShell 5.1（避免中文串按 ANSI 误读）。

$ErrorActionPreference = "SilentlyContinue"
$out = "$env:TEMP\cc-purge-out.txt"
$log = @()
try {
  $c0 = (Get-PSDrive C).Free
  $log += ("Start free: {0:N2} GB" -f ($c0/1GB))

  $s = [DateTime]::UtcNow; $e = $s.AddDays(28)
  $k = "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings"
  $f = "yyyy-MM-ddTHH:mm:ssZ"
  Set-ItemProperty $k -Name "PauseFeatureUpdatesStartTime" -Value $s.ToString($f) -Type String
  Set-ItemProperty $k -Name "PauseFeatureUpdatesEndTime"   -Value $e.ToString($f) -Type String
  Set-ItemProperty $k -Name "PauseQualityUpdatesStartTime" -Value $s.ToString($f) -Type String
  Set-ItemProperty $k -Name "PauseQualityUpdatesEndTime"   -Value $e.ToString($f) -Type String
  Set-ItemProperty $k -Name "PauseUpdatesStartTime"        -Value $s.ToString($f) -Type String
  Set-ItemProperty $k -Name "PauseUpdatesExpiryTime"       -Value $e.ToString($f) -Type String
  $log += ("Updates paused until (UTC): " + $e.ToString("yyyy-MM-dd HH:mm"))

  foreach ($sv in "wuauserv","bits","dosvc") { Stop-Service $sv -Force }
  Start-Sleep 2
  $log += "Services stopped (wuauserv/bits/dosvc)"

  Remove-Item "C:\Windows\SoftwareDistribution\Download\*" -Recurse -Force
  $left = (Get-ChildItem "C:\Windows\SoftwareDistribution\Download" -Force | Measure-Object).Count
  $log += ("Download top-level items left: " + $left)

  Remove-Item "C:\`$WINDOWS.~BT" -Recurse -Force
  if (Test-Path "C:\`$WINDOWS.~BT") {
    takeown /f "C:\`$WINDOWS.~BT" /r /a | Out-Null
    icacls "C:\`$WINDOWS.~BT" /grant *S-1-5-32-544:F /t /q | Out-Null
    Remove-Item "C:\`$WINDOWS.~BT" -Recurse -Force
  }
  $log += ("~BT deleted: " + (-not (Test-Path "C:\`$WINDOWS.~BT")))

  Start-Service wuauserv; Start-Service bits
  $log += "Services restarted"

  $c1 = (Get-PSDrive C).Free
  $log += ("End free: {0:N2} GB  (freed {1:N2} GB)" -f ($c1/1GB), (($c1-$c0)/1GB))
} catch {
  $log += ("ERROR: " + $_.Exception.Message)
}
$log | Out-File $out -Encoding UTF8
