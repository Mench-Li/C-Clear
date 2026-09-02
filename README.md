# C-Clear · C盘清理助手

面向 **DeepSeek Harness（DSH）** 的动态 Cordis 插件，用于 Windows 上自动识别、清理 C 盘占用，并把可搬的数据一对一迁到 D 盘。

> 这是一个 **Cordis 动态插件**：通过 `cordis_define` + `cordis_run` 挂载到当前 DSH 进程。它只活在进程内存里，进程重启即失效（磁盘上的迁移成果不受影响）；如需常驻，可将其固化进 DSH 宿主配置 `cordis.yml`。

## 两个清理方向

1. **可直接删除的缓存**：临时文件、更新缓存、浏览器缓存、缩略图缓存、崩溃转储、回收站等。删除后由系统/应用自动重建，不触碰任何文档数据。
2. **一对一迁移到 D 盘 + 原路径目录联接（junction）**：C 盘每个文件夹 → `D:\CRelocated` 下各自的子文件夹，原 C 盘路径建立 junction，程序仍按原路径访问。**迁移前会判断**：目录是否被占用、D 盘空间是否足够、是否为「安装器强制 C 盘」不可搬的系统目录。

## 面板四区

| 区 | 内容 | 动作 |
|---|---|---|
| ① | 可直接清理的缓存 | 勾选 → 「清理选中」 |
| ② | 可迁移目录（`.cache`/`.codex`/`pnpm-store`/npm/pip 等） | 「迁移」→「确认迁移！」 |
| ③ | 系统强制 C 盘 / 占用被拒（仅供参考） | 本工具不动；占用方退出后可「重测回②区」 |
| ④ | AppData 占用排行（Local/Roaming/LocalLow） | 「加入迁移」进②区 |

迁移全程**两段确认 + 失败自动回滚**：先重命名探测占用与 D 盘空间 → robocopy `/MOVE` → 原路径建 junction → 失败则把数据搬回 C 盘原位置。

## 目录结构

```
C-Clear/
├── README.md
├── plugin/
│   ├── host.js          # Host 半体：目录枚举、扫描、判定、清理、迁移、回滚
│   └── client.js        # Client 半体：React 面板（①②③④四区）
├── scripts/
│   └── pause-and-purge-windows-update.ps1   # 提权：暂停更新 + 清空更新缓存
└── docs/
    └── design.md        # 设计说明与迁移账本
```

## 在 DSH 中使用

1. `cordis_define`（`kind: 'new'`，`idPrefix: 'cclean'`），把 `plugin/host.js` 的内容作为 `code.host`、`plugin/client.js` 的内容作为 `code.client`。
2. `cordis_run`（`mode: 'run'`）。
3. 浏览器里批准插件卡片（建议 ✅✅ 双勾），刷新页面，面板即出现在 Run 卡片上并自动扫描。

## 环境要求

- Windows，C/D 双盘（迁移目标默认 `D:\CRelocated`，可改）。
- DSH 会话文件策略为 `danger-full-access`（迁移/清理/判定需要）。
- 部分系统级清理与更新缓存清理需要 UAC 提权（脚本会弹窗）。

## 免责声明

迁移会移动真实数据并建立 junction；虽带两段确认与失败回滚，仍建议在迁移前退出相关程序。③区系统目录一律不触碰。
