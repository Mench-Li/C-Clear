return {
  apply(ctx) {
    const shell = ctx.get('shell')
    if (shell === undefined) {
      console.error('[cclean] shell service unavailable; plugin stays idle')
      return
    }

    let staticTargets = []
    let customTargets = []
    let customInfo = []
    let targets = []
    let lastAppdata = []
    let chain = Promise.resolve()

    const WS_ROOT = 'E:\\Project\\DSH'
    const POLICY_RW = { mode: 'workspace-write', workspaceRoot: WS_ROOT }
    const POLICY_FULL = { mode: 'danger-full-access', workspaceRoot: WS_ROOT }

    const psq = function (s) { return "'" + String(s).replace(/'/g, "''") + "'" }
    const extractJson = function (text) {
      const m = String(text || '').match(/\{[\s\S]*\}/)
      if (!m) return null
      try { return JSON.parse(m[0]) } catch (e) { return null }
    }
    const psRun = function (command, timeoutMs, policy) {
      const spec = shell.resolve({ command: command, timeoutMs: timeoutMs, sandboxPolicy: policy || POLICY_RW })
      return shell.run(spec).then(function (r) {
        return {
          code: r.exitCode,
          out: (r.stdout && r.stdout.text) || '',
          err: (r.stderr && r.stderr.text) || '',
          timedOut: r.timedOut === true,
          sandboxMode: (r.sandbox && r.sandbox.mode) || null,
          sandboxDenied: !!(r.sandbox && r.sandbox.denied)
        }
      })
    }
    const enqueue = function (fn) {
      const next = chain.then(fn, fn)
      chain = next.then(function () {}, function (e) {
        console.error('[cclean] operation failed:', (e && e.message) || e)
      })
      return next
    }
    const fail = function (msg) { return { ok: false, error: msg } }
    const sandboxBlocked = function (r) {
      return r.sandboxDenied === true
        ? fail('操作被DSH文件沙箱拦截（实际运行模式：' + (r.sandboxMode || '未知') + '）。请把会话文件策略切换为 danger-full-access 后重试。')
        : null
    }
    const classifyClean = function (data, t) {
      if (!data) return data
      const err = String(data.firstError || '')
      if (data.failed > 0 && /being used by another process/i.test(err)) {
        data.note = '部分文件被运行中的程序占用，关闭对应程序（或重启后再清）即可清掉'
      } else if (data.failed > 0 && /denied/i.test(err)) {
        data.note = t && t.admin
          ? '需要管理员权限，当前进程未提权'
          : '存在受保护/提权进程创建的文件，当前用户无法删除（重启后通常可清）'
      }
      return data
    }
    const findTarget = function (p) {
      return targets.find(function (t) { return t.path === p })
    }
    const rebuildTargets = function () {
      targets = staticTargets.concat(customTargets).concat(customInfo)
    }

    const CATALOG_PS = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$global:list = @()",
      "function Add-One([string]$id,[string]$kind,[string]$name,[string]$category,[string]$tmpl,[string]$cleanMode,[bool]$admin,[bool]$cleanable,[bool]$relocatable,[string]$note) {",
      "  $p = [Environment]::ExpandEnvironmentVariables($tmpl)",
      "  $exists = Test-Path -LiteralPath $p",
      "  $lt = $null; $tg = $null",
      "  if ($exists) { $it = Get-Item -LiteralPath $p -Force; if ($it -and $it.LinkType) { $lt = [string]$it.LinkType; $tg = (@($it.Target) -join ';') } }",
      "  $global:list = $global:list + @([pscustomobject]@{ id=$id; kind=$kind; name=$name; category=$category; path=$p; cleanMode=$cleanMode; admin=$admin; cleanable=$cleanable; relocatable=$relocatable; note=$note; exists=$exists; linkType=$lt; linkTarget=$tg })",
      "}",
      "Add-One 'user-temp' 'clean' '用户临时文件' '系统缓存' '%LOCALAPPDATA%\\Temp' 'children' $false $true $false '可安全清空，目录本身保留'",
      "Add-One 'win-temp' 'clean' '系统临时文件' '系统缓存' '%SystemRoot%\\Temp' 'children' $true $true $false '需管理员权限；运行中程序的临时文件可能跳过'",
      "Add-One 'wu-download' 'clean' 'Windows更新下载缓存' '系统缓存' '%SystemRoot%\\SoftwareDistribution\\Download' 'children' $true $true $false '更新安装完成后可清空'",
      "Add-One 'wer' 'clean' 'Windows错误报告' '系统缓存' '%LOCALAPPDATA%\\Microsoft\\Windows\\WER' 'children' $false $true $false ''",
      "Add-One 'd3ds' 'clean' 'DirectX着色器缓存' '系统缓存' '%LOCALAPPDATA%\\D3DSCache' 'children' $false $true $false ''",
      "Add-One 'crashdumps' 'clean' '应用崩溃转储' '系统缓存' '%LOCALAPPDATA%\\CrashDumps' 'children' $false $true $false ''",
      "Add-One 'nv-shader' 'clean' 'NVIDIA着色器缓存' '系统缓存' '%LOCALAPPDATA%\\NVIDIA\\DXCache' 'children' $false $true $false ''",
      "Add-One 'amd-shader' 'clean' 'AMD着色器缓存' '系统缓存' '%LOCALAPPDATA%\\AMD\\DxCache' 'children' $false $true $false ''",
      "Add-One 'thumbnails' 'clean' '缩略图缓存' '系统缓存' '%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer' 'thumbs' $false $true $false '仅删除thumbcache_*.db；资源管理器占用时部分失败'",
      "Add-One 'recycle-c' 'clean' '回收站（C盘）' '系统缓存' 'RECYCLE-BIN-C' 'recycle' $false $true $false '用Clear-RecycleBin清空，不做大小统计'",
      "Add-One 'npm-cache' 'dual' 'npm缓存' '开发缓存' '%LOCALAPPDATA%\\npm-cache' 'children' $false $true $true '可清空；也可整体迁移到D盘并建联接'",
      "Add-One 'dot-cache' 'relocate' '.cache（跨平台工具缓存）' '开发缓存' '%USERPROFILE%\\.cache' '' $false $false $true 'Codex等开发工具的运行时缓存；迁移后原路径联接，工具照常使用'",
      "Add-One 'dot-codex' 'relocate' '.codex（Codex配置与会话）' '开发缓存' '%USERPROFILE%\\.codex' '' $false $false $true 'Codex CLI 的配置/会话/日志；迁移后原路径联接，codex 命令照常使用'",
      "Add-One 'pip-cache' 'dual' 'pip缓存' '开发缓存' '%LOCALAPPDATA%\\pip\\cache' 'children' $false $true $true '可清空；也可迁移'",
      "Add-One 'yarn-cache' 'dual' 'Yarn缓存' '开发缓存' '%LOCALAPPDATA%\\Yarn\\Cache' 'children' $false $true $true ''",
      "Add-One 'gradle-caches' 'dual' 'Gradle构建缓存' '开发缓存' '%USERPROFILE%\\.gradle\\caches' 'children' $false $true $true '清空后首次构建变慢；迁移前建议关闭Gradle守护进程/IDE'",
      "Add-One 'maven-repo' 'dual' 'Maven本地仓库' '开发缓存' '%USERPROFILE%\\.m2\\repository' 'children' $false $true $true '清空后需重新下载依赖；迁移前建议关闭Java/IDE'",
      "Add-One 'pnpm-store' 'relocate' 'pnpm存储仓库' '开发缓存' '%LOCALAPPDATA%\\pnpm\\store' '' $false $false $true '被硬链接引用，直接删除会损坏已安装项目——只能迁移+联接'",
      "Add-One 'nuget-pkgs' 'relocate' 'NuGet包仓库' '开发缓存' '%USERPROFILE%\\.nuget\\packages' '' $false $false $true '建议迁移而非删除；迁移后原路径联接对dotnet透明'",
      "Add-One 'vscode-ext' 'relocate' 'VS Code扩展目录' '应用数据' '%USERPROFILE%\\.vscode\\extensions' '' $false $false $true '安装器固定C盘路径，迁移后用联接保持原路径可用'",
      "Add-One 'wps-cloud' 'info' 'WPS云盘本地副本' '应用数据' '%USERPROFILE%\\WPS Cloud' '' $false $false $false '云盘文件的本地镜像。请在WPS设置里把云同步/缓存目录改到D盘或开启按需下载；不建议联接硬搬（同步客户端会重建目录）'",
      "Add-One 'win-bt' 'info' 'Windows升级残留($WINDOWS.~BT)' '系统组件' 'C:\\$WINDOWS.~BT' '' $true $false $false '升级完成后残留；用管理员「磁盘清理→临时Windows安装文件」回收'",
      "Add-One 'windows-old' 'info' 'Windows.old 系统回退' '系统组件' 'C:\\Windows.old' '' $true $false $false '系统/安装器强制C盘：请用系统“磁盘清理”处理，本工具不触碰'",
      "Add-One 'winsxs' 'info' '组件存储 WinSxS' '系统组件' '%SystemRoot%\\WinSxS' '' $true $false $false '系统强制C盘：不可移动、不可直接删除'",
      "Add-One 'program-files' 'info' 'Program Files' '系统组件' '%ProgramFiles%' '' $true $false $false '已安装应用大多强制C盘；本工具仅统计占用，如需腾挪请用软件自带迁移或重装到D盘'",
      "Add-One 'program-files-x86' 'info' 'Program Files (x86)' '系统组件' '%ProgramFiles(x86)%' '' $true $false $false '同 Program Files'",
      "foreach ($bm in @(@('Chrome', (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\User Data')), @('Edge', (Join-Path $env:LOCALAPPDATA 'Microsoft\\Edge\\User Data')))) {",
      "  if (-not (Test-Path -LiteralPath $bm[1])) { continue }",
      "  $profs = Get-ChildItem -LiteralPath $bm[1] -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }",
      "  foreach ($pr in $profs) {",
      "    foreach ($sub in @('Cache','Code Cache','GPUCache')) {",
      "      $cp = Join-Path $pr.FullName $sub",
      "      if (Test-Path -LiteralPath $cp) { Add-One ('browser|' + $cp) 'clean' ($bm[0] + ' 缓存 · ' + $pr.Name + '\\' + $sub) '浏览器缓存' $cp 'dir' $false $true $false '删除目录本身，浏览器会自动重建；建议先关闭浏览器' }",
      "    }",
      "  }",
      "}",
      "$ffBase = Join-Path $env:LOCALAPPDATA 'Mozilla\\Firefox\\Profiles'",
      "if (Test-Path -LiteralPath $ffBase) {",
      "  Get-ChildItem -LiteralPath $ffBase -Directory -ErrorAction SilentlyContinue | ForEach-Object {",
      "    $c2 = Join-Path $_.FullName 'cache2'",
      "    if (Test-Path -LiteralPath $c2) { Add-One ('ffx|' + $c2) 'clean' ('Firefox 缓存 · ' + $_.Name) '浏览器缓存' $c2 'children' $false $true $false '请先关闭 Firefox' }",
      "  }",
      "}",
      "$driveRows = @()",
      "foreach ($d in @('C','D')) {",
      "  $pd = Get-PSDrive -Name $d -ErrorAction SilentlyContinue",
      "  if ($pd -and $pd.Free) { $driveRows = $driveRows + @([pscustomobject]@{ drive=$d; free=[long]$pd.Free; used=[long]$pd.Used }) }",
      "}",
      "[pscustomobject]@{ targets=@($global:list); drives=@($driveRows) } | ConvertTo-Json -Depth 5 -Compress"
    ].join('\n')

    const APPDATA_PS = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$roots = @([Environment]::GetFolderPath('LocalApplicationData'), [Environment]::GetFolderPath('ApplicationData'), (Join-Path $env:USERPROFILE 'AppData\\LocalLow'))",
      "$out = @()",
      "foreach ($r in $roots) {",
      "  if (-not ($r -and (Test-Path -LiteralPath $r))) { continue }",
      "  $dirs = Get-ChildItem -LiteralPath $r -Directory -Force -ErrorAction SilentlyContinue",
      "  foreach ($d in $dirs) {",
      "    if ($d.LinkType) {",
      "      $out = $out + @([pscustomobject]@{ root=$r; name=$d.Name; path=$d.FullName; sizeBytes=[long]0; files=[long]0; isLink=$true; linkType=[string]$d.LinkType })",
      "      continue",
      "    }",
      "    $total = [long]0; $cnt = [long]0",
      "    Get-ChildItem -LiteralPath $d.FullName -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $total = $total + [long]$_.Length; $cnt = $cnt + 1 }",
      "    $out = $out + @([pscustomobject]@{ root=$r; name=$d.Name; path=$d.FullName; sizeBytes=$total; files=$cnt; isLink=$false; linkType=$null })",
      "  }",
      "}",
      "$out = @($out | Sort-Object -Property sizeBytes -Descending)",
      "[pscustomobject]@{ ok=$true; items=$out } | ConvertTo-Json -Depth 4 -Compress"
    ].join('\n')

    const scanPs = function (path) {
      return [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$p = " + psq(path),
        "if (-not (Test-Path -LiteralPath $p)) { [pscustomobject]@{ ok=$true; exists=$false; sizeBytes=0; files=0 } | ConvertTo-Json -Compress; exit 0 }",
        "$it = Get-Item -LiteralPath $p -Force",
        "$lt = $null; $tg = $null",
        "if ($it -and $it.LinkType) { $lt = [string]$it.LinkType; $tg = (@($it.Target) -join ';') }",
        "if ($lt) { [pscustomobject]@{ ok=$true; exists=$true; sizeBytes=0; files=0; linkType=$lt; linkTarget=$tg } | ConvertTo-Json -Compress; exit 0 }",
        "$total = [long]0; $cnt = [long]0",
        "Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $total = $total + [long]$_.Length; $cnt = $cnt + 1 }",
        "[pscustomobject]@{ ok=$true; exists=$true; sizeBytes=$total; files=$cnt; linkType=$lt; linkTarget=$tg } | ConvertTo-Json -Compress"
      ].join('\n')
    }

    const judgePs = function (path, size) {
      return [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$p = " + psq(path),
        "$size = " + String(Math.max(0, Math.round(Number(size) || 0))),
        "function Out-J([bool]$m,[string]$r) { [pscustomobject]@{ ok=$true; movable=$m; reason=$r } | ConvertTo-Json -Compress }",
        "if (-not (Test-Path -LiteralPath $p)) { Out-J $false '路径不存在'; exit 0 }",
        "$it = Get-Item -LiteralPath $p -Force",
        "if ($it -and $it.LinkType) { Out-J $false ('已是指向 ' + (@($it.Target) -join ';') + ' 的链接，无需重复迁移'); exit 0 }",
        "$pd = Get-PSDrive -Name 'D' -ErrorAction SilentlyContinue",
        "if (-not ($pd -and $pd.Free)) { Out-J $false '未找到D盘'; exit 0 }",
        "$need = [long]($size * 1.05) + 67108864",
        "if ($pd.Free -lt $need) { Out-J $false ('D盘空间不足：需要约 ' + [long]($need / 1MB) + ' MB，D盘剩余 ' + [long]($pd.Free / 1GB) + ' GB'); exit 0 }",
        "$parent = Split-Path -Parent $p",
        "$leaf = Split-Path -Leaf $p",
        "$probe = '__cc_probe_' + [guid]::NewGuid().ToString('N').Substring(0,8)",
        "$locked = $false; $derr = ''",
        "try { Rename-Item -LiteralPath $p -NewName $probe -ErrorAction Stop } catch { $locked = $true; $derr = $_.Exception.Message }",
        "if (-not $locked) { try { Rename-Item -LiteralPath (Join-Path $parent $probe) -NewName $leaf -ErrorAction Stop } catch { $locked = $true; $derr = $_.Exception.Message } }",
        "if ($locked) { Out-J $false ('目录被占用：有程序正在使用其中的文件，请先关闭相关程序（IDE/构建进程/守护进程）后重试。' + $derr) } else { Out-J $true '检查通过：无系统限制、无文件占用、D盘空间足够' }"
      ].join('\n')
    }

    const cleanPs = function (path, mode) {
      return [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$p = " + psq(path),
        "$mode = " + psq(mode),
        "$c0 = (Get-PSDrive -Name 'C').Free",
        "$removed = 0; $failed = 0; $firstErr = ''; $note = ''",
        "if ($mode -eq 'recycle') {",
        "  Clear-RecycleBin -DriveLetter C -Force -ErrorAction SilentlyContinue",
        "  if ($?) { $removed = 1 } else {",
        "    Clear-RecycleBin -Force -ErrorAction SilentlyContinue",
        "    if ($?) { $removed = 1; $note = '按盘符清空不被当前系统支持，已改为清空所有盘的回收站' } else { $failed = 1; $firstErr = 'Clear-RecycleBin 两种方式均失败' }",
        "  }",
        "} elseif ($mode -eq 'dir') {",
        "  try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop; $removed = 1 } catch { $failed = 1; $firstErr = $_.Exception.Message }",
        "} elseif ($mode -eq 'thumbs') {",
        "  Get-ChildItem -LiteralPath $p -Filter 'thumbcache_*.db' -File -Force -ErrorAction SilentlyContinue | ForEach-Object {",
        "    try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; $removed = $removed + 1 } catch { $failed = $failed + 1; if (-not $firstErr) { $firstErr = $_.Exception.Message } }",
        "  }",
        "} else {",
        "  if (Test-Path -LiteralPath $p) {",
        "    Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | ForEach-Object {",
        "      try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop; $removed = $removed + 1 } catch { $failed = $failed + 1; if (-not $firstErr) { $firstErr = $_.Exception.Message } }",
        "    }",
        "  }",
        "}",
        "$c1 = (Get-PSDrive -Name 'C').Free",
        "[pscustomobject]@{ ok=($failed -eq 0); removed=$removed; failed=$failed; firstError=$firstErr; note=$note; freedBytes=[long]($c1 - $c0) } | ConvertTo-Json -Compress"
      ].join('\n')
    }

    const relocatePs = function (path, dstRoot, letter, wantShortcut, safeName, dstName) {
      return [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$p = " + psq(path),
        "$dstRoot = " + psq(dstRoot),
        "$letter = " + psq(letter),
        "$wantLnk = " + (wantShortcut ? '$true' : '$false'),
        "$dstName = " + psq(dstName),
        "function Out-R([bool]$ok2,[string]$err2,[string]$dst2,[bool]$sc2) { [pscustomobject]@{ ok=$ok2; error=$err2; dst=$dst2; shortcut=$sc2 } | ConvertTo-Json -Compress }",
        "if (-not (Test-Path -LiteralPath $p)) { Out-R $false '路径不存在' '' $false; exit 0 }",
        "$it = Get-Item -LiteralPath $p -Force",
        "if ($it -and $it.LinkType) { Out-R $false '已是指向别处的链接' '' $false; exit 0 }",
        "$pd = Get-PSDrive -Name $letter -ErrorAction SilentlyContinue",
        "if (-not ($pd -and $pd.Free)) { Out-R $false ('未找到目标盘 ' + $letter) '' $false; exit 0 }",
        "$parent = Split-Path -Parent $p",
        "$leaf = Split-Path -Leaf $p",
        "$probe = '__cc_probe_' + [guid]::NewGuid().ToString('N').Substring(0,8)",
        "$locked = $false; $derr = ''",
        "try { Rename-Item -LiteralPath $p -NewName $probe -ErrorAction Stop } catch { $locked = $true; $derr = $_.Exception.Message }",
        "if (-not $locked) { try { Rename-Item -LiteralPath (Join-Path $parent $probe) -NewName $leaf -ErrorAction Stop } catch { $locked = $true; $derr = $_.Exception.Message } }",
        "if ($locked) { Out-R $false ('目录被占用，已取消迁移。' + $derr) '' $false; exit 0 }",
        "New-Item -ItemType Directory -Force -Path $dstRoot -ErrorAction SilentlyContinue | Out-Null",
        "$dst = Join-Path $dstRoot $dstName",
        "if (Test-Path -LiteralPath $dst) { $dst = Join-Path $dstRoot ($dstName + '_' + [guid]::NewGuid().ToString('N').Substring(0,6)) }",
        "& robocopy.exe $p $dst /E /MOVE /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NP /XJ | Out-Null",
        "$rc = 16; if ($LASTEXITCODE -ne $null) { $rc = $LASTEXITCODE }",
        "if ($rc -ge 8) {",
        "  & robocopy.exe $dst $p /E /MOVE /R:1 /W:1 /NFL /NDL /NP | Out-Null",
        "  Out-R $false ('robocopy 迁移失败（rc=' + $rc + '），已尝试把数据移回C盘原位置') '' $false; exit 0",
        "}",
        "$leftover = ''",
        "if (Test-Path -LiteralPath $p) {",
        "  $links = @(Get-ChildItem -LiteralPath $p -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)",
        "  foreach ($lk in $links) {",
        "    try {",
        "      $rel = $lk.FullName.Substring($p.Length).TrimStart('\\')",
        "      $destLink = Join-Path $dst $rel",
        "      $destParent = Split-Path -Parent $destLink",
        "      if (-not (Test-Path -LiteralPath $destParent)) { New-Item -ItemType Directory -Force -Path $destParent -ErrorAction SilentlyContinue | Out-Null }",
        "      if (-not (Test-Path -LiteralPath $destLink)) { Move-Item -LiteralPath $lk.FullName -Destination $destLink -Force -ErrorAction SilentlyContinue }",
        "    } catch { }",
        "  }",
        "  try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop } catch {",
        "    Start-Sleep -Seconds 2",
        "    try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop } catch {",
        "      $names = @(Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object { $_.Name })",
        "      $leftover = '残留：' + ($names -join ', ')",
        "    }",
        "  }",
        "}",
        "$junction = $false; $jerr = ''",
        "if (-not (Test-Path -LiteralPath $p)) {",
        "  try { New-Item -ItemType Junction -Path $p -Target $dst -ErrorAction Stop | Out-Null; $junction = $true } catch { $jerr = $_.Exception.Message }",
        "  if (-not $junction) {",
        "    $line = 'mklink /J \"' + $p + '\" \"' + $dst + '\"'",
        "    & cmd.exe /c $line | Out-Null",
        "    if ($LASTEXITCODE -eq 0) { $junction = $true }",
        "  }",
        "} else {",
        "  $jerr = '原目录未清空，无法创建联接' + $(if ($leftover) { '（' + $leftover + '）' } else { '' })",
        "}",
        "if (-not $junction) {",
        "  & robocopy.exe $dst $p /E /MOVE /R:1 /W:1 /NFL /NDL /NP | Out-Null",
        "  Out-R $false ('目录联接创建失败：' + $jerr + '，数据已移回C盘原位置（robocopy rc=' + $rc + '）') '' $false; exit 0",
        "}",
        "$scPath = ''",
        "if ($wantLnk) {",
        "  try {",
        "    $desk = [Environment]::GetFolderPath('Desktop')",
        "    $ws = New-Object -ComObject WScript.Shell",
        "    $lnkPath = Join-Path $desk ('C盘迁移-' + " + psq(safeName) + " + '.lnk')",
        "    $lnk = $ws.CreateShortcut($lnkPath)",
        "    $lnk.TargetPath = $dst",
        "    $lnk.Save()",
        "    $scPath = $lnkPath",
        "  } catch { $scPath = '' }",
        "}",
        "Out-R $true '' $dst ($scPath -ne '')"
      ].join('\n')
    }

    ctx.effect(function () {
      return harness.handle('catalog', function () {
        return enqueue(function () {
          return psRun(CATALOG_PS, 60000, POLICY_RW).then(function (r) {
            if (r.timedOut) return fail('目录枚举超时')
            const blocked = sandboxBlocked(r)
            if (blocked) return blocked
            const data = extractJson(r.out)
            if (!data) return fail('目录枚举输出无法解析：' + ((r.err || r.out || '').slice(0, 160)))
            staticTargets = Array.isArray(data.targets) ? data.targets : []
            rebuildTargets()
            return { ok: true, targets: targets, drives: Array.isArray(data.drives) ? data.drives : [] }
          })
        })
      })
    })

    ctx.effect(function () {
      return harness.handle('appdataScan', function () {
        return enqueue(function () {
          return psRun(APPDATA_PS, 600000, POLICY_RW).then(function (r) {
            if (r.timedOut) return fail('AppData 扫描超时（目录过大）')
            const blocked = sandboxBlocked(r)
            if (blocked) return blocked
            const data = extractJson(r.out)
            if (!data || !Array.isArray(data.items)) return fail('AppData 扫描输出无法解析：' + ((r.err || '').slice(0, 160)))
            lastAppdata = data.items
            return { ok: true, items: data.items }
          })
        })
      })
    })

    ctx.effect(function () {
      return harness.handle('addTarget', function (args) {
        const p = String((args && args.path) || '').trim()
        const item = lastAppdata.find(function (x) { return x.path === p })
        if (!item) return Promise.resolve(fail('该路径不在刚才的 AppData 扫描结果里，请先扫描再选择'))
        if (item.isLink) return Promise.resolve(fail('该目录已是链接，无需迁移'))
        const existing = targets.find(function (t) { return t.path === p })
        if (existing) {
          return Promise.resolve(fail(existing.relocatable ? '该目录已在②区' : '该目录已归入③区（可在④区点「重测回②区」）'))
        }
        const norm = p.toLowerCase().replace(/[\\/]+$/, '')
        for (let i = 0; i < targets.length; i++) {
          if (!targets[i].relocatable) continue
          const tp = String(targets[i].path).toLowerCase().replace(/[\\/]+$/, '')
          if (norm === tp) continue
          if (norm.indexOf(tp + '\\') === 0 || tp.indexOf(norm + '\\') === 0) {
            return Promise.resolve(fail('与现有目录「' + targets[i].name + '」重叠（父子关系），不能重复迁移'))
          }
        }
        const custom = {
          id: 'custom|' + p,
          kind: 'relocate',
          name: String(item.name || '自选目录'),
          category: 'AppData自选',
          path: p,
          cleanMode: '',
          admin: false,
          cleanable: false,
          relocatable: true,
          note: '从AppData排行加入：迁移前自动探测占用与D盘空间，失败自动回滚',
          exists: true,
          linkType: null
        }
        customTargets.push(custom)
        rebuildTargets()
        return Promise.resolve({ ok: true, target: custom })
      })
    })

    ctx.effect(function () {
      return harness.handle('reAddTarget', function (args) {
        const p = String((args && args.path) || '').trim()
        const idx = customInfo.findIndex(function (x) { return x.path === p })
        if (idx === -1) return Promise.resolve(fail('该目录不在③区自选列表里（系统固定项不可重测）'))
        const item = customInfo[idx]
        customInfo.splice(idx, 1)
        customTargets.push({
          id: 'custom|' + p,
          kind: 'relocate',
          name: item.name,
          category: 'AppData自选',
          path: p,
          cleanMode: '',
          admin: false,
          cleanable: false,
          relocatable: true,
          note: '重测回②区：探测通过即可迁移；若再次被拒会重新归入③区',
          exists: true,
          linkType: null
        })
        rebuildTargets()
        return Promise.resolve({ ok: true })
      })
    })

    ctx.effect(function () {
      return harness.handle('scan', function (args) {
        const p = args && args.path
        const t = findTarget(p)
        if (!t) return Promise.resolve(fail('未知路径（请先刷新目录）'))
        return enqueue(function () {
          return psRun(scanPs(p), 600000, POLICY_RW).then(function (r) {
            if (r.timedOut) return fail('统计超时（目录过大）')
            const blocked = sandboxBlocked(r)
            if (blocked) return blocked
            const data = extractJson(r.out)
            if (!data) return fail('统计输出无法解析：' + ((r.err || '').slice(0, 160)))
            return data
          })
        })
      })
    })

    ctx.effect(function () {
      return harness.handle('judge', function (args) {
        const p = args && args.path
        const t = findTarget(p)
        if (!t || !t.relocatable) return Promise.resolve(fail('该路径不支持迁移判定'))
        const size = Math.max(0, Number(args && args.sizeBytes) || 0)
        return enqueue(function () {
          return psRun(judgePs(p, size), 120000, POLICY_FULL).then(function (r) {
            const blocked = sandboxBlocked(r)
            if (blocked) return blocked
            const data = extractJson(r.out)
            if (!data) return fail('判定输出无法解析')
            if (data.movable === false && /Access to the path .* is denied/i.test(String(data.reason || '')) && String(t.id).indexOf('custom|') === 0) {
              customTargets = customTargets.filter(function (x) { return x.path !== p })
              customInfo = customInfo.filter(function (x) { return x.path !== p })
              customInfo.push({
                id: 'sysinfo|' + p,
                kind: 'info',
                name: t.name,
                category: 'AppData自选·占用被拒',
                path: p,
                cleanMode: '',
                admin: false,
                cleanable: false,
                relocatable: false,
                note: '重命名探测被拒（Access denied），已归入③区；退出占用程序后可在④区点「重测回②区」再试',
                exists: true,
                linkType: null
              })
              rebuildTargets()
              return { ok: true, movable: false, reason: data.reason, reclassified: true }
            }
            return data
          })
        })
      })
    })

    ctx.effect(function () {
      return harness.handle('clean', function (args) {
        const t = findTarget(args && args.path)
        if (!t || !t.cleanable) return Promise.resolve(fail('该路径不支持清理'))
        if (t.cleanMode !== 'recycle' && t.exists === false) {
          return Promise.resolve({ ok: true, removed: 0, failed: 0, freedBytes: 0, note: '路径不存在（未安装），已跳过' })
        }
        const mode = t.cleanMode || 'children'
        return enqueue(function () {
          return psRun(cleanPs(t.path, mode), 600000, POLICY_FULL).then(function (r) {
            const blocked = sandboxBlocked(r)
            if (blocked) return blocked
            const data = extractJson(r.out)
            if (!data) return fail('清理输出无法解析')
            return classifyClean(data, t)
          })
        })
      })
    })

    ctx.effect(function () {
      return harness.handle('relocate', function (args) {
        const t = findTarget(args && args.path)
        if (!t || !t.relocatable) return Promise.resolve(fail('该路径不支持迁移'))
        let dstRoot = String((args && args.dstRoot) || 'D:\\CRelocated').trim()
        if (!/^[A-Za-z]:\\[^"*?:<>|\r\n]+$/i.test(dstRoot)) return Promise.resolve(fail('目标目录需为形如 D:\\CRelocated 的绝对路径'))
        dstRoot = dstRoot.replace(/[\\]+$/, '')
        const letter = dstRoot.charAt(0).toUpperCase()
        if (letter === 'C') return Promise.resolve(fail('目标目录不能位于C盘'))
        const wantShortcut = (args && args.shortcut) === true
        const safeName = String(t.name || t.path).replace(/[\\/:*?"<>|]/g, '')
        let dstName = String((args && args.dstName) || '').replace(/[\\/:*?"<>|]/g, '')
        if (!dstName) {
          const leaf = t.path.split('\\').pop()
          dstName = (t.id && t.id.indexOf('|') === -1) ? String(t.id) : (leaf || 'dir').replace(/[\\/:*?"<>|]/g, '')
        }
        return enqueue(function () {
          return psRun(relocatePs(t.path, dstRoot, letter, wantShortcut, safeName, dstName), 900000, POLICY_FULL).then(function (r) {
            const blocked = sandboxBlocked(r)
            if (blocked) return blocked
            const data = extractJson(r.out)
            if (!data) return fail('迁移输出无法解析')
            return data
          })
        })
      })
    })
  }
}
