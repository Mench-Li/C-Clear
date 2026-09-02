# 设计说明

## 目标

Windows 上自动识别 C 盘占用，两个方向释放空间：

1. **直接删除的缓存**：临时文件、更新缓存、浏览器缓存、缩略图、崩溃转储、回收站——删除后自动重建，不碰文档数据。
2. **一对一迁移到 D 盘**：C 盘文件夹 → `D:\CRelocated\<名>`，原路径建 **目录联接（junction）**，程序仍按原路径访问。

## 关键设计决策

### 迁移前「判定」可否移动
迁移前对目标目录做一次**重命名探测**（rename 过去再 rename 回来）：若 `Access denied`，说明目录被占用或受保护（可能是「安装器强制 C 盘」的路径），则拒绝迁移并归入③区；占用方退出后可「重测回②区」。同时校验 D 盘空间 ≥ 大小×1.05 + 64MB。

### 迁移安全性
- 两段确认（先点「迁移」再点「确认迁移！」）。
- `robocopy /E /MOVE /COPY:DAT /DCOPY:DAT /XJ`：`/XJ` 不跟随源目录内的 junction。
- robocopy 返回码 ≥8（复制失败）→ 反向 robocopy 把数据搬回 C 盘原位置。
- 残留 ReparsePoint 先移到目标，再删除空目录；删除失败 2 秒后重试。
- 建 junction 失败 → 数据移回 C 盘。

### ③区系统强制区（不动）
Program Files / WinSxS / Windows.old / $WINDOWS.~BT / WPS 云盘本地副本等：只统计，不迁移不删除。WPS 云盘建议在 WPS 设置里改同步目录到 D 盘，而不是 junction 硬搬（同步客户端会重建目录）。

### 沙箱策略
- 只读/统计：`workspace-write`（读）。
- 判定/清理/迁移：`danger-full-access`（要真实改动 C/D 盘）。
- 系统级清理（更新缓存、$WINDOWS.~BT、回收站）另需 UAC 提权。

## 迁移账本（本机实际执行记录）

| 目标 | 结果 |
|---|---|
| `.cache` / npm-cache / pip / pnpm-store / .codex | 已迁（junction） |
| OpenAI / Postman / Tencent / LarkShell / Kingsoft / DoubaoWork / Feishu 等 AppData 目录 | 已迁（junction） |
| WPS Cloud（7.4GB） | 改为清空本地副本 / 改同步目录 |
| Windows 24H2 升级暂存（$WINDOWS.~BT 17.5GB + Download 14GB） | 提权暂停更新 + 清空 |

> 迁移目标默认 `D:\CRelocated`；重复迁移重试会在目标名后加随机后缀，可能留下孤儿目录（如 `OpenAI_xxxx`），需人工核对清理。
