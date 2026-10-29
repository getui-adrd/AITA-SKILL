# AITA 营销智能体 Skill

配合 AITA 对外 MCP 服务使用：把用户的人群需求交给 AITA，自动等待异步任务，并把报告保存为 Markdown 文件。

## 目录

```
aita-marketing/
├── SKILL.md          # 给 AI 看的使用说明（何时调用、各状态怎么处理）
├── scripts/aita.mjs  # 调用脚本：发起、轮询、查询，零依赖
└── README.md         # 本文件，给安装的人看
```

## 安装

1. 环境要求：Node.js 18 及以上。
2. 把整个 `aita-marketing` 目录导入为技能（WorkBuddy 等平台的导入方式以平台文档为准）。
3. 不需要配置环境变量。首次使用时 AI 会请你提供 AITA API Key，自动完成配置。

也可以手动配置：

```bash
node scripts/aita.mjs setup --api-key <你的 Key> --client <平台名> [--url <MCP 服务地址>] [--mcp-config <MCP 配置文件>]
node scripts/aita.mjs status
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--api-key` | 是 | AITA「MCP 服务」页面生成的 Key |
| `--client` | 否 | 调用来源名称，如 `workbuddy`，会出现在 AITA 的调用记录里 |
| `--url` | 否 | MCP 服务地址，默认 `https://aita.gai.cn/mcp` |
| `--mcp-config` | 否 | 平台的 MCP 配置文件（`mcpServers` 格式）。给了就把 AITA 写进去 |

`setup` 做的事：
- 用一个不存在的任务号查询一次，校验 Key 可用（不创建任务、不消耗额度）；不可用时什么都不写；
- 写入技能目录下的 `config.json`（权限 600，已在 `.gitignore` 中，不要提交或分享）。脚本只从这个文件读配置；
- 给了 `--mcp-config` 时，在该文件里新增或更新 `aita` 条目，其他条目原样保留，修改前备份为 `.bak`；没给时，输出一段标准的 MCP 条目，由用户在平台里自行添加。

## 脚本行为

- `start`：发起或继续一个任务。返回 `RUNNING` 时自动接着轮询，直到出现需要用户参与的状态，不设等待时长上限。
- `poll`：继续等待一个任务。
- `query`：只查一次。
- 轮询间隔按服务端返回的 `next_poll_after_seconds`，最短 3 秒。
- 网络错误和 5xx 自动重试 3 次；轮询期间连不上服务时不退出，按间隔继续重试（任务在服务端不受影响）。
- `DONE` 时把报告正文写入 当前目录下的 `aita-reports/<task_id>.md`，输出里用 `result_file` 给出路径，不输出正文。
- 输出始终是一个 JSON 对象；出错时为 `{"status": "ERROR", "message": "..."}`。

## 注意

- 停止脚本或关闭对话不会终止 AITA 上的任务；要终止，需要对 AI 明确说"取消/停止"。
- 本目录会公开发布，只能写对外协议里的内容，不要写入内部流程、内部技能名或标签体系。
