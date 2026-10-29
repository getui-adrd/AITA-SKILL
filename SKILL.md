---
name: aita-marketing
description: 调用 AITA 营销智能体，完成人群圈选、人群洞察报告和营销策略报告。当用户想分析某类目标人群（如"上海25-35岁的宝妈"）、做人群画像或洞察、圈选营销人群、或基于人群制定营销策略时使用。任务在 AITA 云端异步执行，人群洞察通常需要数十分钟。
---

# AITA 营销智能体

AITA 根据用户的自然语言描述完成人群圈选、人群洞察，并产出洞察报告或营销策略报告。所有分析在 AITA 云端完成，本技能负责把用户的话交给 AITA、等待结果、把需要用户决定的事情交还给用户。

## 首次使用：先完成配置

每次使用前先运行：

```bash
node scripts/aita.mjs status
```

返回 `CONFIGURED` 就直接进入下面的流程。返回 `NOT_CONFIGURED` 时，先帮用户完成配置，再继续用户原本的请求：

1. **向用户要 API Key**：请用户打开 [AITA MCP 服务页](https://aita.gai.cn/datapan/mcp) ，生成并复制 API Key。
2. **确认要不要同时连上 AITA MCP**：如果你知道当前平台的 MCP 配置文件位置（`mcpServers` 格式的 JSON 文件），告诉用户会把 AITA 写进去，征得同意；不知道就跳过这一步，不要猜路径。
3. **运行 setup**：

```bash
node scripts/aita.mjs setup --api-key <Key> --client <当前平台名，如 workbuddy> [--mcp-config <MCP 配置文件路径>]
```

setup 会先校验 Key（不创建任务、不消耗额度），通过后才写入技能目录的 `config.json`；带了 `--mcp-config` 时，同时把 AITA 写进该文件（已有 `aita` 条目就更新，其他条目保留，改前备份为 `.bak`）。

4. **按结果告知用户**：
   - `CONFIGURED`：告诉用户配置完成。输出里有 `mcp_server` 时，说明 MCP 连接还没加，把这段配置给用户，请他在当前平台的 MCP/连接器设置里添加（Key 由用户自己填，不要替他填进回复里）。只用本技能的话，不加也能正常使用。
   - `ERROR`：把 `message` 转述给用户，通常是 Key 无效、已停用或已过期。

其他注意：
- 用户说 Key 换了、重置了，或调用时提示凭证无效，重新运行 setup。
- **不要**把 Key 复述到回复里，也不要写进其他文件。
- 需要 `node`（18 及以上）。

## 怎么调用

统一通过脚本调用，**不要自己循环调用查询工具**。发起和等待是**两个独立的命令**：

```bash
# 1. 发起新任务（不带 task-id）。几秒内返回，输出里有 task_id
node scripts/aita.mjs start --instruction "<用户原话>"

# 在已有任务上继续：确认、修改规则、补充信息、终止，都用它
node scripts/aita.mjs start --task-id <task_id> --instruction "<用户原话>"

# 2. 等待结果：按服务端建议的间隔轮询，直到出现需要用户参与的状态才返回
node scripts/aita.mjs poll --task-id <task_id>

# 只查一次当前状态（用户要可视化报告链接时用）
node scripts/aita.mjs query --task-id <task_id>
```

参数用引号包好；用户原话里有引号、换行时注意转义。

**标准流程**：

1. 运行 `start`，拿到 `task_id`。
   - 返回 `status: RUNNING`（任务已受理）时，**立刻**进入第 2 步。
   - 返回其他状态（如 `REJECTED`、`BUSY`），按下面「按状态处理」办。
2. **后台运行 `poll`**，等它完成后读取输出，再按 `status` 处理。**不要同步运行 `poll`**：规则生成、人群洞察动辄几十分钟，同步运行会被工具超时杀掉。

`poll` 没有等待时长上限，注意：
- 不要加 `--max-wait` 之类的参数，也不要加 `timeout` 或自己限制运行时长；
- 不要额外加载环境变量文件，配置只在技能目录的 `config.json` 里；
- `poll` 被中断了（超时、被杀、后台任务丢失），任务仍在 AITA 云端运行，**用同一个 `task_id` 重新 `poll` 即可**。
- **绝不要因为 `poll` 中断就用同一句话重新 `start`**：那会新建一个任务，之前的规则全部丢失，旧任务还会留在后台。`task_id` 在 `start` 的输出里，务必在对话里保留。

## 必须遵守

1. **原话转述**：`--instruction` 传用户的原话，不要改写、拆解、补全，也不要替用户加条件。AITA 需要原始表述来理解意图。
2. **始终带上 task_id**：同一件事的后续对话（确认、修改、补充、终止）都要传回第一次拿到的 `task_id`。不带就会新开一个任务，之前的规则全部丢失。只有用户明确要做一件新的事时才不带。
3. **确认必须由用户本人做出**：状态为 `NEEDS_CONFIRM` 时，展示规则和额度说明后**停下来等用户回复**。绝不替用户回"确认"——确认会真实消耗用户的洞察额度。
4. **单次输入不超过 2000 字**。超长时请用户精简，不要自行截断。
5. 不要猜测或编造 AITA 的内部流程、规则含义或报告内容，只转述返回结果里的信息。

## 按状态处理

脚本输出一个 JSON，按 `status` 处理。`message` 字段是写给用户的，可以直接转述；`next_action` 是给你的操作指引，按它做。

| status | 含义 | 你要做的 |
|---|---|---|
| `NEEDS_CONFIRM` | 人群规则已生成，等用户确认 | 展示 `rule_summary`；有 `quota_notice` 时一并展示额度说明。问用户"是否按这个规则开始？"，然后**等待**。用户确认或提出修改后，用 `start --task-id` 把用户原话发回去 |
| `NEEDS_INPUT` | 还缺信息 | 把 `message` 里的问题转述给用户，拿到回答后用 `start --task-id` 发回去 |
| `DONE` | 有结果了 | 见下方「交付结果」 |
| `FAILED` | 任务失败 | 转述 `message`，询问用户是否重新发起。**若带 `error_code: QUOTA_EXHAUSTED`**：这是额度不足，属于终态——把 `message` 和 `recharge_url` 原样告诉用户，引导充值；**不要**再用 `start --task-id` 重发确认（重发也只会得到同样的结果），等用户补充额度后再重新发起 |
| `RUNNING` | 任务已受理或仍在执行（`start` 的返回） | 立刻后台运行 `poll --task-id <task_id>` 等结果，不要让用户等你 |
| `BUSY` | 上一轮还没跑完 | 转述 `message`，告诉用户稍候；稍后用 `poll --task-id` 等它跑完 |
| `REJECTED` | 请求被拒绝 | 转述 `message` |
| `ERROR` | 脚本或网络问题、Key 无效、额度不足等 | 转述 `message`。其中带了 AITA 页面链接的（续期、充值等），把链接原样给用户 |

`start` 返回 `RUNNING` 表示任务已受理，接着后台运行 `poll`。`poll` 返回了 `RUNNING` 以外的状态后，不要再自动 poll。

`start` 的输出里如果有 `start_message`，那是 AITA 对本次发送内容的直接答复，**先看它**。比如在额度确认阶段提出修改，AITA 会先取消这次确认并答复"请用同一任务号再发送一次您的修改要求"——这时把用户刚才的修改原话再用 `start --task-id` 发一次即可，不用再问用户。

## 交付结果

`DONE` 时报告正文已经由脚本保存为 Markdown 文件，路径在 `result_file`。

- 把这个文件交付给用户，用两三句话概括报告讲了什么即可，**不要把全文贴进对话**，也**不要自己把报告转成 HTML、PPT 或其他格式**。
- `result_type`：`INSIGHT_REPORT` 为人群洞察报告，`MARKETING_STRATEGY` 为营销策略报告。
- 有些回合没有报告（比如只是回答了一个问题），这时没有 `result_file`，直接转述 `message`。

**可视化报告**只在用户主动要（"有没有图表版""给我个链接分享给同事"）时再处理：

- `visual_report_status` 为 `READY`：把 `visual_report_url` 给用户。
- 为 `RENDERING`：用 `query --task-id` 再查一次；仍未就绪就告诉用户还在生成，稍后再试。
- 为 `FAILED`：告诉用户可视化报告这次没有生成成功，Markdown 报告不受影响，可以稍后再试。

## 终止任务

用户说"取消""停止""不用做了"时，用 `start --task-id <task_id> --instruction "<用户原话>"` 把这句话发回去，AITA 会终止执行中的任务。人群洞察尚未完成的，冻结的额度会自动退回；已经完成的，额度按正常消耗。

关掉对话或停止脚本**不会**终止 AITA 上的任务，任务会继续在后台执行，之后凭任务编号仍可查询结果。

## 示例

```
用户：帮我看看一线城市喜欢露营的年轻人，出一份洞察报告
→ node scripts/aita.mjs start --instruction "帮我看看一线城市喜欢露营的年轻人，出一份洞察报告"
← status: RUNNING, task_id: mcp_xxx（几秒内返回）
→ node scripts/aita.mjs poll --task-id mcp_xxx   （后台运行，等完成通知）
← status: NEEDS_CONFIRM, task_id: mcp_xxx, rule_summary: ..., quota_notice: 本次将消耗 1 次洞察额度...

你：展示规则和额度，问用户是否开始。

用户：年龄改成 20-30 岁
→ node scripts/aita.mjs start --task-id mcp_xxx --instruction "年龄改成 20-30 岁"
← status: RUNNING
→ node scripts/aita.mjs poll --task-id mcp_xxx   （后台运行）
← status: NEEDS_CONFIRM（规则已更新）

用户：可以，开始吧
→ node scripts/aita.mjs start --task-id mcp_xxx --instruction "可以，开始吧"
← status: RUNNING
→ node scripts/aita.mjs poll --task-id mcp_xxx   （后台运行，可能要几十分钟）
← status: DONE, result_file: aita-reports/mcp_xxx.md

你：交付文件，简要概括报告结论。
```
