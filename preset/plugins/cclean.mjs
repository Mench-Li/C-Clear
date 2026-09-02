// C盘清理助手 —— 宿主插件（DSH 正式插件，本地 ESM 文件，由预设行 `name: ./plugins/cclean.mjs` 挂载）
// 提供：
//   GET  /cclean        自包含面板网页
//   POST /cclean/api/*  JSON RPC（catalog/scan/judge/clean/relocate/appdataScan/addTarget/reAddTarget）
// 依赖：宿主 `webServer`（HTTP 路由）与 `shell`（PowerShell 执行）。
export const name = 'cclean'
export const inject = ['webServer', 'shell']

export function apply(ctx) {
  let staticTargets = []
  let customTargets = []
  let customInfo = []
  let targets = []
  let lastAppdata = []
  // Write operations (clean/relocate) run serially on their own chain so two
  // robocopy/delete jobs never hit the disk at once. Read-only calls
  // (catalog/scan/judge/appdataScan) run concurrently without enqueueing so a
  // slow scan never blocks the panel or a user's click behind it.
  let writeChain = Promise.resolve()

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
    const spec = ctx.shell.resolve({ command: command, timeoutMs: timeoutMs, sandboxPolicy: policy || POLICY_RW })
    return ctx.shell.run(spec).then(function (r) {
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
  // Serialize one write operation behind any earlier writes. A rejected write
  // must not poison the rest of the chain, so the continuation swallows it.
  const write = function (fn) {
    const next = writeChain.then(fn, fn)
    writeChain = next.then(function () {}, function (e) {
      console.error('[cclean] write failed:', (e && e.message) || e)
    })
    return next
  }
  // Read-only RPCs run immediately and independently; each returns its own
  // promise. Only clean/relocate serialize (via write), because two robocopy
  // runs or deletes in flight would race on the same source directory.
  const concurrent = function (fn) { return Promise.resolve().then(fn) }
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
    "foreach ($pd in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {",
    "  if ($pd -and $pd.Free -and $pd.Name -match '^[A-Za-z]$') { $driveRows = $driveRows + @([pscustomobject]@{ drive=$pd.Name; free=[long]$pd.Free; used=[long]$pd.Used }) }",
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

  const judgePs = function (path, size, letter) {
    const L = String(letter || 'D').replace(/[^A-Za-z]/, '').toUpperCase()
    return [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$p = " + psq(path),
      "$size = " + String(Math.max(0, Math.round(Number(size) || 0))),
      "function Out-J([bool]$m,[string]$r) { [pscustomobject]@{ ok=$true; movable=$m; reason=$r } | ConvertTo-Json -Compress }",
      "if (-not (Test-Path -LiteralPath $p)) { Out-J $false '路径不存在'; exit 0 }",
      "$it = Get-Item -LiteralPath $p -Force",
      "if ($it -and $it.LinkType) { Out-J $false ('已是指向 ' + (@($it.Target) -join ';') + ' 的链接，无需重复迁移'); exit 0 }",
      "$pd = Get-PSDrive -Name " + psq(L) + " -ErrorAction SilentlyContinue",
      "if (-not ($pd -and $pd.Free)) { Out-J $false ('未找到目标盘 ' + " + psq(L) + "); exit 0 }",
      "$need = [long]($size * 1.05) + 67108864",
      "if ($pd.Free -lt $need) { Out-J $false ('目标盘空间不足：需要约 ' + [long]($need / 1MB) + ' MB，" + L + "盘剩余 ' + [long]($pd.Free / 1GB) + ' GB'); exit 0 }",
      "$parent = Split-Path -Parent $p",
      "$leaf = Split-Path -Leaf $p",
      "$probe = '__cc_probe_' + [guid]::NewGuid().ToString('N').Substring(0,8)",
      "$locked = $false; $derr = ''",
      "try { Rename-Item -LiteralPath $p -NewName $probe -ErrorAction Stop } catch { $locked = $true; $derr = $_.Exception.Message }",
      "if (-not $locked) { try { Rename-Item -LiteralPath (Join-Path $parent $probe) -NewName $leaf -ErrorAction Stop } catch { $locked = $true; $derr = $_.Exception.Message } }",
      "if ($locked) { Out-J $false ('目录被占用：有程序正在使用其中的文件，请先关闭相关程序（IDE/构建进程/守护进程）后重试。' + $derr) } else { Out-J $true '检查通过：无系统限制、无文件占用、目标盘空间足够' }"
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

  // ==== RPC 分发（对应原动态插件的 harness.handle 各方法）====
  const dispatch = function (method, args) {
    const p = args && args.path
    if (method === 'catalog') {
      return concurrent(function () {
        return psRun(CATALOG_PS, 60000, POLICY_FULL).then(function (r) {
          if (r.timedOut) return fail('目录枚举超时')
          const blocked = sandboxBlocked(r); if (blocked) return blocked
          const data = extractJson(r.out)
          if (!data) return fail('目录枚举输出无法解析：' + ((r.err || r.out || '').slice(0, 160)))
          staticTargets = Array.isArray(data.targets) ? data.targets : []
          rebuildTargets()
          return { ok: true, targets: targets, drives: Array.isArray(data.drives) ? data.drives : [] }
        })
      })
    }
    if (method === 'appdataScan') {
      return concurrent(function () {
        return psRun(APPDATA_PS, 600000, POLICY_RW).then(function (r) {
          if (r.timedOut) return fail('AppData 扫描超时（目录过大）')
          const blocked = sandboxBlocked(r); if (blocked) return blocked
          const data = extractJson(r.out)
          if (!data || !Array.isArray(data.items)) return fail('AppData 扫描输出无法解析：' + ((r.err || '').slice(0, 160)))
          lastAppdata = data.items
          return { ok: true, items: data.items }
        })
      })
    }
    if (method === 'addTarget') {
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
        id: 'custom|' + p, kind: 'relocate', name: String(item.name || '自选目录'), category: 'AppData自选',
        path: p, cleanMode: '', admin: false, cleanable: false, relocatable: true,
        note: '从AppData排行加入：迁移前自动探测占用与目标盘空间，失败自动回滚', exists: true, linkType: null
      }
      customTargets.push(custom)
      rebuildTargets()
      return Promise.resolve({ ok: true, target: custom })
    }
    if (method === 'reAddTarget') {
      const idx = customInfo.findIndex(function (x) { return x.path === p })
      if (idx === -1) return Promise.resolve(fail('该目录不在③区自选列表里（系统固定项不可重测）'))
      const item = customInfo[idx]
      customInfo.splice(idx, 1)
      customTargets.push({
        id: 'custom|' + p, kind: 'relocate', name: item.name, category: 'AppData自选', path: p,
        cleanMode: '', admin: false, cleanable: false, relocatable: true,
        note: '重测回②区：探测通过即可迁移；若再次被拒会重新归入③区', exists: true, linkType: null
      })
      rebuildTargets()
      return Promise.resolve({ ok: true })
    }
    if (method === 'scan') {
      const t = findTarget(p)
      if (!t) return Promise.resolve(fail('未知路径（请先刷新目录）'))
      return concurrent(function () {
        return psRun(scanPs(p), 600000, POLICY_RW).then(function (r) {
          if (r.timedOut) return fail('统计超时（目录过大）')
          const blocked = sandboxBlocked(r); if (blocked) return blocked
          const data = extractJson(r.out)
          if (!data) return fail('统计输出无法解析：' + ((r.err || '').slice(0, 160)))
          return data
        })
      })
    }
    if (method === 'judge') {
      const t = findTarget(p)
      if (!t || !t.relocatable) return Promise.resolve(fail('该路径不支持迁移判定'))
      const size = Math.max(0, Number(args && args.sizeBytes) || 0)
      const dstRoot = String((args && args.dstRoot) || 'D:\\CRelocated').trim()
      const dm = dstRoot.match(/^([A-Za-z]):/)
      const letter = dm ? dm[1].toUpperCase() : (String(args && args.letter || 'D').replace(/[^A-Za-z]/, '').toUpperCase() || 'D')
      return concurrent(function () {
        return psRun(judgePs(p, size, letter), 120000, POLICY_FULL).then(function (r) {
          const blocked = sandboxBlocked(r); if (blocked) return blocked
          const data = extractJson(r.out)
          if (!data) return fail('判定输出无法解析')
          if (data.movable === false && /Access to the path .* is denied/i.test(String(data.reason || '')) && String(t.id).indexOf('custom|') === 0) {
            customTargets = customTargets.filter(function (x) { return x.path !== p })
            customInfo = customInfo.filter(function (x) { return x.path !== p })
            customInfo.push({
              id: 'sysinfo|' + p, kind: 'info', name: t.name, category: 'AppData自选·占用被拒', path: p,
              cleanMode: '', admin: false, cleanable: false, relocatable: false,
              note: '重命名探测被拒（Access denied），已归入③区；退出占用程序后可在④区点「重测回②区」再试', exists: true, linkType: null
            })
            rebuildTargets()
            return { ok: true, movable: false, reason: data.reason, reclassified: true }
          }
          return data
        })
      })
    }
    if (method === 'clean') {
      const t = findTarget(p)
      if (!t || !t.cleanable) return Promise.resolve(fail('该路径不支持清理'))
      if (t.cleanMode !== 'recycle' && t.exists === false) {
        return Promise.resolve({ ok: true, removed: 0, failed: 0, freedBytes: 0, note: '路径不存在（未安装），已跳过' })
      }
      const mode = t.cleanMode || 'children'
      return write(function () {
        return psRun(cleanPs(t.path, mode), 600000, POLICY_FULL).then(function (r) {
          const blocked = sandboxBlocked(r); if (blocked) return blocked
          const data = extractJson(r.out)
          if (!data) return fail('清理输出无法解析')
          return classifyClean(data, t)
        })
      })
    }
    if (method === 'relocate') {
      const t = findTarget(p)
      if (!t || !t.relocatable) return Promise.resolve(fail('该路径不支持迁移'))
      let dstRoot = String((args && args.dstRoot) || 'D:\\CRelocated').trim()
      if (!/^[A-Za-z]:\\[^"*?:<>|\r\n]+$/i.test(dstRoot)) return Promise.resolve(fail('目标目录需为形如 E:\\CRelocated 的绝对路径（E 换成你想用的目标盘盘符）'))
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
      return write(function () {
        return psRun(relocatePs(t.path, dstRoot, letter, wantShortcut, safeName, dstName), 900000, POLICY_FULL).then(function (r) {
          const blocked = sandboxBlocked(r); if (blocked) return blocked
          const data = extractJson(r.out)
          if (!data) return fail('迁移输出无法解析')
          return data
        })
      })
    }
    return Promise.resolve(fail('未知接口：' + method))
  }

  // ==== HTTP 辅助 ====
  const json = function (res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }
  const readJsonBody = function (req) {
    return new Promise(function (resolve) {
      let data = ''
      req.on('data', function (c) { data += c })
      req.on('end', function () {
        try { resolve(data ? JSON.parse(data) : {}) } catch (e) { resolve({}) }
      })
    })
  }

  // ==== 路由注册（生命周期可逆）====
  ctx.effect(function () {
    return ctx.webServer.register({
      kind: 'exact',
      path: '/cclean',
      handler: function (req, res) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PANEL_HTML)
      }
    })
  })
  ctx.effect(function () {
    return ctx.webServer.register({
      kind: 'prefix',
      path: '/cclean/api',
      handler: async function (req, res) {
        try {
          const url = new URL(req.url, 'http://localhost')
          let method = url.pathname.replace(/^\/cclean\/api\/?/, '')
          if (!method) method = 'catalog'
          const args = await readJsonBody(req)
          const result = await dispatch(method, args)
          json(res, 200, result)
        } catch (e) {
          json(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      }
    })
  })

  // ==== 自包含面板网页（内嵌 CSS + 原生 JS UI）====
  const PANEL_HTML = [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>C盘清理助手</title><style>',
    'body{font:13px/1.55 system-ui,"Segoe UI",sans-serif;margin:0;background:#14161a;color:#e6e6e6}',
    '.wrap{max-width:860px;margin:0 auto;padding:16px}',
    'h1{font-size:18px;margin:0 0 10px}',
    '.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 12px}',
    'button{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid #555;background:transparent;color:inherit;cursor:pointer}',
    'button:hover:not(:disabled){background:#ffffff14}button:disabled{opacity:.45;cursor:default}',
    'button.danger{border-color:#d9534f;color:#d9534f}',
    'input[type=text]{font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;border:1px solid #555;background:transparent;color:inherit;width:150px}',
    '.chip{border:1px solid #777;border-radius:10px;padding:0 8px;font-size:11px}',
    '.chip.hot{border-color:#e6a03c;color:#d79a3c}',
    '.sec{margin:14px 0 4px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.sub{opacity:.75;font-size:11px;margin:2px 0 6px}',
    '.item{border:1px solid #333;border-radius:6px;padding:5px 9px;margin:5px 0}',
    '.row{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}',
    '.size{font-weight:600;white-space:nowrap}',
    '.path{opacity:.55;font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all}',
    '.note{opacity:.7;font-size:11px}',
    '.badge{border:1px solid #666;border-radius:8px;padding:0 5px;font-size:10.5px;white-space:nowrap}',
    '.badge.warn{border-color:#e6a03c;color:#d79a3c}.badge.ok{border-color:#4caf7d;color:#4caf7d}.badge.bad{border-color:#d9534f;color:#d9534f}',
    '.log{max-height:180px;overflow:auto;border:1px dashed #444;border-radius:6px;padding:5px 9px;margin-top:14px;white-space:pre-wrap;font-size:11px}',
    '.rank{border-bottom:1px dashed #333;padding:3px 5px}',
    '</style></head><body><div class="wrap" id="app"></div><script>',
    'var state={targets:[],info:{},drives:[],checked:{},dstRoot:"D:\\\\CRelocated",dstTouched:false,wantLnk:true,confirmPath:null,adItems:[],sizeSort:true,busy:false,moveBusy:{},logs:[]};',
    'function api(m,a){return fetch("/cclean/api/"+m,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(a||{})}).then(function(r){return r.json()})}',
    'function fmtB(n){if(n===null||n===undefined||isNaN(Number(n)))return"—";var v=Number(n),u=["B","KB","MB","GB","TB"],i=0;while(v>=1024&&i<u.length-1){v/=1024;i++}return (i===0?String(Math.round(v)):v.toFixed(1))+" "+u[i]}',
    'function fmtC(n){if(n===null||n===undefined)return"";return n>=10000?(n/10000).toFixed(1)+"万":String(n)}',
    'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}',
    'function log(t){state.logs.unshift("["+new Date().toLocaleTimeString()+"] "+t);if(state.logs.length>200)state.logs.pop();var le=document.getElementById("log");if(le)le.textContent=state.logs.join("\\n")}',
    'function el(id){return document.getElementById(id)}',
    'function stOf(p){return state.info[p]||{}}',
    'function subText(t){if(t.exists===false)return "未安装（已卸载/不存在）";var s=stOf(t.path);if(s.status==="scan")return "统计中…";if(s.cleaned)return "已清理";var x=fmtB(s.sizeBytes);if(s.files!==undefined&&s.files!==null)x+=" · "+fmtC(s.files)+"文件";return x}',
    'function badge(cls,t){return "<span class=\\"badge "+cls+"\\">"+esc(t)+"</span>"}',
    'function render(){var h="",i,t,s,total,any;',
    '  h+="<h1>C盘清理助手</h1><div class=\\"toolbar\\">";',
    '  h+="<button id=\\"b-refresh\\">刷新目录</button><button id=\\"b-scanall\\">重新扫描全部</button><button id=\\"b-sort\\">"+(state.sizeSort?"排序：按大小":"排序：按目录")+"</button>";',
    '  if(state.drives.length){for(i=0;i<state.drives.length;i++){var d=state.drives[i];h+="<span class=\\"chip\\">"+esc(d.drive)+": 剩余 "+fmtB(d.free)+" / 共 "+fmtB(d.free+d.used)+"</span>"}}',
    '  h+="</div>";',
    '  var clean=state.targets.filter(function(t){return t.cleanable});',
    '  var relo=state.targets.filter(function(t){return t.relocatable});',
    '  var infos=state.targets.filter(function(t){return t.kind==="info"});',
    '  var sel=clean.filter(function(t){return t.cleanMode!=="recycle"});',
    '  h+="<div class=\\"sec\\">① 可直接清理的缓存 ";',
    '  total=0;any=false;for(i=0;i<sel.length;i++){var selT=sel[i];if(selT.exists===false)continue;s=stOf(selT.path);if(s.sizeBytes!==undefined){total+=s.sizeBytes;any=true}}if(any)h+="<span class=\\"chip hot\\">合计 "+fmtB(total)+"</span>";',
    '  h+="<button id=\\"b-cleansel\\" class=\\"danger\\">清理选中</button></div>";',
    '  h+="<div class=\\"sub\\">勾选后点「清理选中」，缓存删除后由系统/应用自动重建，不触碰任何文档数据。</div>";',
    '  if(!clean.length)h+="<div class=\\"note\\">未发现可清理项</div>";',
    '  for(i=0;i<clean.length;i++){t=clean[i];var isR=t.cleanMode==="recycle";',
    '    h+="<div class=\\"item\\"><div class=\\"row\\">";',
    '    if(!isR)h+="<input type=\\"checkbox\\" data-ck=\\""+esc(t.path)+"\\""+(state.checked[t.path]?" checked":"")+">";',
    '    h+="<strong>"+esc(t.name)+"</strong>";',
    '    if(!isR)h+="<span class=\\"size\\">"+esc(subText(t))+"</span>";',
    '    if(t.admin)h+=badge("warn","需管理员");',
    '    if(stOf(t.path).linkType)h+=badge("ok","已是链接");',
    '    if(!isR)h+="<button data-rescan=\\""+esc(t.path)+"\\">重新统计</button>";',
    '    h+="</div><div class=\\"path\\">"+esc(t.path)+"</div>";',
    '    if(t.note)h+="<div class=\\"note\\">· "+esc(t.note)+"</div>";',
    '    h+="</div>"}',
    '  h+="<div class=\\"sec\\">② 迁移到指定盘（每个文件夹一对一迁移）<button id=\\"b-scanrelo\\">扫描本区</button></div>";',
    '  h+="<div class=\\"row\\"><span>目标盘根目录：</span><select id=\\"dstsel\\">";',
    '  var nd=state.drives.filter(function(d){return String(d.drive).toUpperCase()!=="C"});',
    '  var curL=((state.dstRoot||"").match(/^([A-Za-z]):/)||[])[1];curL=curL?curL.toUpperCase():"D";',
    '  if(!nd.length)h+="<option value=\\"\\">（未检测到非C盘）</option>";',
    '  for(var di=0;di<nd.length;di++){var dv=String(nd[di].drive).toUpperCase();h+="<option value=\\""+dv+"\\""+(dv===curL?" selected":"")+">"+dv+" 盘（剩余 "+fmtB(nd[di].free)+"）</option>"}',
    '  h+="</select><input type=\\"text\\" id=\\"dst\\" value=\\""+esc(state.dstRoot)+"\\"><label><input type=\\"checkbox\\" id=\\"lnk\\""+(state.wantLnk?" checked":"")+"> 迁移后在桌面创建快捷方式</label></div>";',
    '  h+="<div class=\\"sub\\">一一对应：C盘每个文件夹 → 目标盘根目录下各自的子文件夹；C盘原路径建立目录联接，程序仍按原路径访问。可下拉选盘符或直接改路径（不能选C盘）。</div>";',
    '  if(!relo.length)h+="<div class=\\"note\\">未发现可迁移项</div>";',
    '  for(i=0;i<relo.length;i++){t=relo[i];s=stOf(t.path);',
    '    h+="<div class=\\"item\\""+(t.exists===false?" style=\\"opacity:.45\\"":"")+"><div class=\\"row\\"><strong>"+esc(t.name)+"</strong><span class=\\"size\\">"+esc(subText(t))+"</span>";',
    '    if(t.admin)h+=badge("warn","需管理员");',
    '    if(s.linkType)h+=badge("ok","已是链接");',
    '    if(s.judging)h+=badge("","检测中…");else if(s.status==="move")h+=badge("","迁移中…");else if(s.status==="moved")h+=badge("ok","已迁移");else if(s.status==="err")h+=badge("bad","迁移失败");else if(s.movable===true)h+=badge("ok","可迁移");else if(s.movable===false&&s.reason)h+=badge("bad","不可迁移");',
    '    h+="</div><div class=\\"path\\">"+esc(t.path)+"</div>";',
    '    if(s.status==="err"&&s.reason)h+="<div class=\\"note\\">· "+esc(s.reason)+"</div>";',
    '    if(s.reason&&s.status!=="err")h+="<div class=\\"note\\">· "+esc(s.reason)+"</div>";',
    '    if(t.note)h+="<div class=\\"note\\">· "+esc(t.note)+"</div>";',
    '    if(t.exists&&s.status!=="moved"){var mbusy=state.moveBusy[t.path]||s.status==="move";h+="<div class=\\"row\\"><button data-judge=\\""+esc(t.path)+"\\" "+(mbusy?"disabled":"")+">"+(s.status==="err"?"重试检测":"重新检测")+"</button>";',
    '      if(mbusy){h+="<span class=\\"note\\">迁移进行中，请勿重复操作…</span>"}',
    '      else if(state.confirmPath===t.path){h+="<button class=\\"danger\\" data-relocate=\\""+esc(t.path)+"\\">确认迁移！</button><button data-cancel=\\""+esc(t.path)+"\\">取消</button>"}',
    '      else h+="<button "+(s.movable!==true?"disabled":"")+" data-relocate=\\""+esc(t.path)+"\\">迁移</button>";',
    '    h+="</div>"}',
    '    h+="</div>"}',
    '  h+="<div class=\\"sec\\">③ 系统强制C盘（仅供参考，本工具不会改动）<button id=\\"b-scaninfo\\">统计本区（较慢）</button></div>";',
    '  for(i=0;i<infos.length;i++){t=infos[i];s=stOf(t.path);var sysRe=(String(t.id).indexOf("sysinfo|")===0);',
    '    h+="<div class=\\"item\\"><div class=\\"row\\"><strong>"+esc(t.name)+"</strong><span class=\\"size\\">"+esc(subText(t))+"</span>"+badge("bad","不可移动");',
    '    if(sysRe)h+="<button data-readd=\\""+esc(t.path)+"\\">重测回②区</button>";',
    '    if(t.exists&&!s.sizeBytes)h+="<button data-rescan=\\""+esc(t.path)+"\\">统计</button>";',
    '    h+="</div><div class=\\"path\\">"+esc(t.path)+"</div>";',
    '    if(t.note)h+="<div class=\\"note\\">· "+esc(t.note)+"</div></div>"}',
    '  h+="<div class=\\"sec\\">④ AppData 占用排行（Local / Roaming / LocalLow）<button id=\\"b-scanad\\">重新扫描 AppData</button></div>";',
    '  if(state.adItems.length){var roots=["Local","Roaming","LocalLow"];for(var ri=0;ri<roots.length;ri++){var k=roots[ri],list=state.adItems.filter(function(x){return rootLabel(x.root)===k}).slice(0,15);if(!list.length)continue;',
    '    var tot=state.adItems.filter(function(x){return rootLabel(x.root)===k}).reduce(function(a,x){return a+(Number(x.sizeBytes)||0)},0);',
    '    h+="<div class=\\"row\\"><span class=\\"chip hot\\">AppData\\\\"+k+" 合计 "+fmtB(tot)+"</span></div>";',
    '    for(var j=0;j<list.length;j++){var it=list[j];var match=state.targets.find(function(t){return t.path===it.path});',
    '      h+="<div class=\\"row rank\\"><span class=\\"size\\">"+fmtB(it.sizeBytes)+"</span><span>"+esc(it.name)+"</span>";',
    '      if(it.files)h+="<span class=\\"note\\">"+fmtC(it.files)+"文件</span>";',
    '      if(it.isLink)h+=badge("ok","已是链接");',
    '      if(match){if(match.relocatable)h+=badge("","已在②区");else if(String(match.id).indexOf("sysinfo|")===0){h+=badge("bad","已归③区");h+="<button data-readd=\\""+esc(it.path)+"\\">重测回②区</button>"}else h+=badge("bad","系统强制·不可迁移")}',
    '      if(!it.isLink&&!match)h+="<button data-add=\\""+esc(it.path)+"\\">加入迁移</button>";',
    '      h+="</div>"}}}',
    '  else h+="<div class=\\"note\\">等待扫描 AppData，或点上方按钮手动开始。</div>";',
    '  h+="<div class=\\"log\\" id=\\"log\\">"+(state.logs.length?esc(state.logs.join("\\n")):"操作日志（扫描/清理/迁移结果都会显示在这里）")+"</div>";',
    '  el("app").innerHTML=h}',
    'function rootLabel(r){var s=String(r||"").toLowerCase();if(s.indexOf("roaming")!==-1)return "Roaming";if(s.indexOf("locallow")!==-1)return "LocalLow";return "Local"}',
    'function loadCatalog(){return api("catalog").then(function(r){if(!r||r.ok===false){log("加载失败："+((r&&r.error)||""));return}state.targets=r.targets||[];state.drives=r.drives||[];if(!state.dstTouched){var cur=((state.dstRoot||"").match(/^([A-Za-z]):/)||[])[1];var has=state.drives.some(function(d){return String(d.drive).toUpperCase()===String(cur||"").toUpperCase()});if(!has){var first=state.drives.filter(function(d){return String(d.drive).toUpperCase()!=="C"})[0];if(first)state.dstRoot=String(first.drive).toUpperCase()+":\\\\CRelocated"}}render()})}',
    'function scanOne(p,withJudge){state.info[p]={status:"scan"};render();return api("scan",{path:p}).then(function(r){if(r&&r.ok!==false&&r.error===undefined){state.info[p]={status:"done",exists:r.exists!==false,sizeBytes:r.exists===false?0:r.sizeBytes,files:r.files,linkType:r.linkType||null}}else state.info[p]={status:"error",msg:(r&&r.error)||"统计失败"};if(withJudge)return judge(p);render()})}',
    'function judge(p){var cur=state.info[p]||{};state.info[p]=Object.assign({},cur,{judging:true});render();return api("judge",{path:p,sizeBytes:cur.sizeBytes||0,dstRoot:state.dstRoot}).then(function(r){if(r&&r.reclassified){log("「"+p+"」重命名探测被拒，已归入③区");return loadCatalog()}if(r&&r.ok!==false){state.info[p]=Object.assign({},state.info[p],{judging:false,movable:r.movable===true,reason:r.reason||""})}else state.info[p]=Object.assign({},state.info[p],{judging:false,movable:false,reason:(r&&r.error)||"判定失败"});render()})}',
    'function scanAll(){var list=state.targets.filter(function(t){return (t.cleanable||t.relocatable)&&t.cleanMode!=="recycle"&&t.exists});if(!list.length){scanAppdata();return}Promise.all(list.map(function(t){return scanOne(t.path,true)})).then(function(){scanAppdata()},function(){scanAppdata()})}',
    'function scanAppdata(){state.adItems=[];render();api("appdataScan").then(function(r){if(r&&r.ok){state.adItems=r.items||[];log("✓ AppData 扫描完成："+state.adItems.length+" 个顶层目录")}else log("× AppData 扫描失败："+((r&&r.error)||""));render()})}',
    'function cleanChecked(){var list=state.targets.filter(function(t){return t.cleanable&&state.checked[t.path]});if(!list.length){log("请先勾选要清理的项目");return}state.busy=true;var i=0;(function next(){if(i>=list.length){state.busy=false;log("清理完成");loadCatalog();return}var t=list[i];state.info[t.path]={status:"clean"};render();api("clean",{path:t.path}).then(function(r){var freed=Math.max(0,(r&&r.freedBytes)||0);if(r&&r.ok)log("✓ "+t.name+"：清理 "+r.removed+" 项，释放约 "+fmtB(freed)+((r&&r.note)?"（"+r.note+"）":""));else log("△ "+t.name+"："+((r&&r.error)||("失败 "+(r&&r.failed)+" 项")));state.info[t.path]={status:"done",sizeBytes:0,files:0,cleaned:true};state.checked={};i++;next()})})()}',
    'function relocate(p){if(state.moveBusy[p]){log("「"+p+"」正在迁移中，请稍候");return}var cur=state.info[p]||{};if(cur.status==="move"){log("「"+p+"」正在迁移中，请稍候");return}if(state.confirmPath!==p){state.confirmPath=p;render();return}var s=state.info[p]||{};if(s.movable!==true){state.confirmPath=null;judge(p);return}state.confirmPath=null;state.moveBusy[p]=true;state.info[p]={status:"move",movable:true};render();log("开始迁移：「"+p+"」→ "+(state.dstRoot||"?"));var t=state.targets.find(function(x){return x.path===p});var dstName=String(p.split("\\\\").pop()||"dir").replace(/[\\\\/:*?"<>|]/g,"");api("relocate",{path:p,dstRoot:state.dstRoot,shortcut:state.wantLnk,dstName:dstName}).then(function(r){delete state.moveBusy[p];if(r&&r.ok){state.info[p]={status:"moved",movable:false,sizeBytes:0,reason:"已迁移至 "+r.dst};log("✓ 已迁移 → "+r.dst+"；C盘原路径已建立目录联接"+(r.shortcut?"；已创建桌面快捷方式":""))}else{var e=(r&&r.error)||"未知错误";state.info[p]={status:"err",movable:false,reason:e};log("× 「"+p+"」迁移失败："+e)}render();loadCatalog()})}',
    'document.addEventListener("click",function(ev){var b=ev.target.closest("button");var ck=ev.target.closest("input[data-ck]");if(!b&&!ck)return;if(ck){state.checked[ck.getAttribute("data-ck")]=ck.checked;return}var id=b.id,d;',
    '  if(id==="b-refresh"){loadCatalog().then(function(){log("目录已刷新，共 "+state.targets.length+" 个关注项")})}',
    '  else if(id==="b-scanall")scanAll();',
    '  else if(id==="b-sort"){state.sizeSort=!state.sizeSort;render()}',
    '  else if(id==="b-cleansel")cleanChecked();',
    '  else if(id==="b-scanrelo"){state.targets.filter(function(t){return t.relocatable&&t.exists}).forEach(function(t){scanOne(t.path,true)})}',
    '  else if(id==="b-scaninfo"){state.targets.filter(function(t){return t.kind==="info"&&t.exists}).forEach(function(t){scanOne(t.path,false)})}',
    '  else if(id==="b-scanad")scanAppdata();',
    '  else if(d=b.getAttribute("data-rescan"))scanOne(d,false);',
    '  else if(d=b.getAttribute("data-judge"))judge(d);',
    '  else if(d=b.getAttribute("data-relocate"))relocate(d);',
    '  else if(d=b.getAttribute("data-cancel")){state.confirmPath=null;render()}',
    '  else if(d=b.getAttribute("data-add")){var addBtn=b;addBtn.disabled=true;api("addTarget",{path:d}).then(function(r){if(r&&r.ok){log("✓ 已加入迁移："+d);loadCatalog().then(function(){judge(d)})}else{log("× 加入失败："+((r&&r.error)||""));render()}})}',
    '  else if(d=b.getAttribute("data-readd")){api("reAddTarget",{path:d}).then(function(r){if(r&&r.ok){log("✓ 已移回②区："+d);loadCatalog().then(function(){judge(d)})}else log("× 移回失败："+((r&&r.error)||""))})}',
    '});',
    'document.addEventListener("input",function(ev){if(ev.target.id==="dst"){state.dstRoot=ev.target.value;state.dstTouched=true}if(ev.target.id==="lnk")state.wantLnk=ev.target.checked;});',
    'document.addEventListener("change",function(ev){if(ev.target.id==="dstsel"){state.dstRoot=ev.target.value+":\\\\CRelocated";state.dstTouched=true;render()}});',
    'loadCatalog().then(function(){var list=state.targets.filter(function(t){return (t.cleanable||t.relocatable)&&t.cleanMode!=="recycle"&&t.exists});if(!list.length){scanAppdata();return}Promise.all(list.map(function(t){return scanOne(t.path,true)})).then(function(){scanAppdata()},function(){scanAppdata()})});',
    '</script></body></html>'
  ].join('')
}
