# AI还没忘 · SillyTavern 服务端插件（内嵌模式）

把AI还没忘的记忆服务**跑在 SillyTavern 自己的进程里**：不用单独开 Node.js 窗口、不占用端口、不需要配对码，随 SillyTavern 启动/停止，并按 ST 用户隔离数据。

## 与「独立服务」的区别

| | 内嵌插件（本目录） | 独立服务（`server/` + 启动脚本） |
|---|---|---|
| 运行位置 | SillyTavern 进程内 | 独立 Node.js 进程 |
| 启动方式 | 随 SillyTavern 自动 | 手动双击 `启动AI还没忘.cmd` |
| 端口 | 无 | 127.0.0.1:8787（可漂移） |
| 鉴权 | 复用 SillyTavern 登录 | 配对码 + 本机凭证 |
| 数据目录 | `<ST数据目录>/<用户>/not-forgotten/` | `server/data/` |
| 多用户 | 按 `req.user` 天然隔离 | 单实例共享 |
| 适合 | 日常单机使用（推荐） | 想让记忆服务不随 ST 重启 / 多个 ST 共用一个记忆库 |

两者共用同一套核心代码（`server/src`），设置项与接口完全一致。

## 安装

1. 在 SillyTavern 的 `config.yaml` 里确认已开启服务端插件：

   ```yaml
   enableServerPlugins: true
   ```

2. 把**本目录**连同 `server/src` 复制到 SillyTavern 的插件目录：

   ```
   SillyTavern/plugins/not-forgotten/
     ├── index.mjs
     ├── package.json
     ├── README.md
     └── src/          ← 复制自 AI还没忘/server/src
   ```

   仓库里的 `launcher/安装到SillyTavern.cmd` 会自动完成这一步。

3. 重启 SillyTavern。启动日志里应出现：

   ```
   Initializing plugin from .../plugins/not-forgotten/index.mjs
   [AI还没忘] 服务端插件 v0.4.0 已加载：挂载 N 条路由于 /api/plugins/not-forgotten
   ```

4. 浏览器里打开 SillyTavern 页面，扩展面板会自动探测到插件模式并连接（无需配对）。

## 配置（可选）

同目录 `config.json`：

```json
{
  "serverRoot": "<仓库目录>/server/src",
  "dataSubdir": "not-forgotten",
  "storeKind": "auto",
  "logLevel": "info",
  "seedSettings": { "autoManage": true, "shadowMode": "first-n", "shadowTurns": 20 }
}
```

- `serverRoot`：内核代码位置。默认 `./src`（安装时复制进来的副本）；开发时可直接指向仓库的 `server/src`。
- `dataSubdir`：每个 ST 用户目录下的子目录名。
- `storeKind`：`auto` | `sqlite` | `journal`。`auto` 在 Node ≥ 22.5 用内置 `node:sqlite`，否则自动降级为 journal 存储。
- `seedSettings`：**首次**为本用户建库时写入的初始设置；已存在 `settings.json` 则不再覆盖。

## 接口

路径前缀 `/api/plugins/not-forgotten`（SillyTavern 已在 `requireLoginMiddleware` 之后加载插件，因此这些接口同样受 ST 登录保护）：

- `GET  /health`、`GET /status`、`GET|POST /settings`
- `POST /ingest`、`POST /plan`、`POST /preview`、`POST /plans/:planId/feedback`
- `GET  /memories`、`PATCH /memories/:id`、`POST /memories/:id/forget|restore`
- `GET  /snapshots`、`GET /health-check`、`POST /index/rebuild`、`GET /export`、导入与迁移接口等
- 插件模式**不暴露** `/pair/*`（无配对）与 `/shutdown`（会连带停掉 SillyTavern）

## 卸载

1. 删除 `SillyTavern/plugins/not-forgotten/` 目录；
2. （可选）删除各用户目录下的 `not-forgotten/` 数据目录 —— **这会删除该用户的记忆数据**，删除前请先确认或先导出；
3. 重启 SillyTavern。

## 注意

- 插件与 SillyTavern **共享同一个 Node 事件循环**：AI还没忘已把重活放在后台任务队列里，但首次为大量历史消息建索引（10k 条约 100ms）会短暂占用 ST。极低配机器上如遇卡顿，可把 `storeKind` 设为 `journal`，或改用独立服务模式。
- 内置 `node:sqlite` 需要 Node ≥ 22.5（22.13 之前需 `--experimental-sqlite`）；不满足时自动降级 journal 存储，功能一致、性能略低。
- 插件更新需要重启 SillyTavern；若插件目录是 git 仓库且开启了 `enableServerPluginsAutoUpdate`，ST 会在启动时自动拉取。
