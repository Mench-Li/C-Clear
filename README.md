# C-Clear · C盘清理助手

面向 **DeepSeek Harness（DSH）** 的 C 盘清理插件，用于 Windows 上自动识别、清理 C 盘占用，并把可搬的数据一对一迁到 D 盘。

> 当前版本是 **正式 DSH 预设插件**（宿主 HTTP 面板），固化在本地预设里，**重启不失效**。历史版本（`plugin/` 下的动态 Cordis 插件）已保留作参考。

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
├── preset/                     # 正式持久化预设（当前版本）
│   ├── preset.yml              #   预设元数据（名称/描述）
│   ├── agent.cordis.yml        #   组合：standard 全量能力 + cclean 插件行
│   └── plugins/
│       └── cclean.mjs          #   宿主插件：/cclean 网页 + /cclean/api/* JSON RPC
├── plugin/                     # 历史动态插件（进程内，重启失效）
│   ├── host.js
│   └── client.js
├── scripts/
│   └── pause-and-purge-windows-update.ps1   # 提权：暂停更新 + 清空更新缓存
└── docs/
    └── design.md
```

## 安装（DSH 预设）

把 `preset/` 整目录复制到本地预设根目录，并把默认预设设为 `cclean`：

```powershell
$root = Join-Path $HOME '.dsh\.agent-presets'
Copy-Item .\preset (Join-Path $root 'cclean') -Recurse -Force
# settings.yaml 中： agent-presets.default: cclean
```

重启 DSH 后，面板即常驻：

```
http://127.0.0.1:3080/cclean
```

插件是**宿主侧 HTTP 面板**：`GET /cclean` 返回自包含网页，`POST /cclean/api/*` 是 JSON RPC（`catalog`/`scan`/`judge`/`clean`/`relocate`/`appdataScan`/`addTarget`/`reAddTarget`），消费宿主 `webServer` 与 `shell` 服务、不发布任何服务，故无需 isolate realm，可安全放进预设。

## 环境要求

- Windows，C/D 双盘（迁移目标默认 `D:\CRelocated`，面板里可改）。
- DSH 会话文件策略为 `danger-full-access`（迁移/清理/判定需要）。
- 部分系统级清理与更新缓存清理需要 UAC 提权（脚本会弹窗）。

## 免责声明

迁移会移动真实数据并建立 junction；虽带两段确认与失败回滚，仍建议在迁移前退出相关程序。③区系统目录一律不触碰。
