#!/usr/bin/env node
// AITA 营销智能体 MCP 调用脚本。零依赖，需要 Node.js 18+（内置 fetch）。
//
// 用法：
//   node aita.mjs status
//   node aita.mjs setup --api-key <Key> [--url <MCP 地址>] [--client <平台名>] [--mcp-config <MCP 配置文件>]
//   node aita.mjs start --instruction "<用户原话>" [--task-id <id>]   发起后立即返回，不等待结果
//   node aita.mjs poll  --task-id <id>                                 一直等到出结果或需要用户参与
//   node aita.mjs query --task-id <id>
//
// 配置只来自技能目录下的 config.json，由 setup 写入。不读环境变量，也不读任何平台自己的配置文件。
//
// 输出：始终向 stdout 打印一个 JSON 对象。报告正文写入文件，只返回路径，不把长文本塞进对话。

import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const DEFAULT_URL = "https://aita.gai.cn/mcp";
// 服务端对同一任务有 3 秒查询节流，间隔再短只会拿到缓存。
const MIN_POLL_SECONDS = 3;
const DEFAULT_POLL_SECONDS = 10;
const MAX_NETWORK_RETRIES = 3;

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = path.join(SKILL_DIR, "config.json");
/** 写进 MCP 配置时用的服务名。 */
const MCP_SERVER_NAME = "aita";

class UserFacingError extends Error {}

/** 连不上服务这类临时问题：轮询时不该因此放弃，任务还在服务端继续执行。 */
class TransientError extends UserFacingError {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      i++;
    }
  }
  return { command, options };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new UserFacingError(`配置文件 ${file} 无法解析：${error.message}`);
  }
}

async function loadConfig() {
  const local = await readJson(CONFIG_FILE);
  return local?.apiKey ? local : undefined;
}

async function config() {
  const local = await loadConfig();
  if (!local) {
    throw new UserFacingError(
      "尚未配置 AITA。请在 AITA「MCP 服务」页面生成 API Key，然后运行 setup --api-key <Key> 完成配置。",
    );
  }
  return {
    apiKey: local.apiKey,
    url: local.url || DEFAULT_URL,
    client: local.client || "unknown",
    reportDir: local.reportDir || "aita-reports",
  };
}

function maskKey(key) {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 先写临时文件再改名，写到一半中断也不会留下坏掉的配置。 */
async function writeJsonAtomic(file, data, mode) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temp, file);
  if (mode) await chmod(file, mode);
}

/**
 * 用一个不存在的任务号查一次：Key 无效会返回鉴权错误；Key 有效会正常返回「任务编号不存在」。
 * 不会创建任务，也不消耗额度。
 */
async function verifyKey(cfg) {
  await callTool(cfg, "aita_query_task", { task_id: "mcp_setup_check" });
}

/** 标准 mcpServers 格式的 AITA 条目，大多数支持 MCP 的客户端都认这个结构。 */
function mcpServerEntry(url, apiKey) {
  return { type: "http", url, headers: { Authorization: `Bearer ${apiKey}` } };
}

function expandHome(file) {
  return file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
}

/**
 * 把 AITA 写进调用方指定的 MCP 配置文件（mcpServers 格式）：已有 aita 条目就更新，其余条目原样保留。
 * 不猜任何平台的配置位置，文件路径由调用方给出。
 */
async function upsertMcpConfig(file, url, apiKey) {
  const target = path.resolve(expandHome(file));
  const existing = (await readJson(target)) ?? {};
  if (typeof existing !== "object" || Array.isArray(existing)) {
    throw new UserFacingError(`${target} 不是 mcpServers 格式的配置文件，未做修改。`);
  }
  const servers = { ...(existing.mcpServers ?? {}) };
  const updated = MCP_SERVER_NAME in servers;
  const previous = servers[MCP_SERVER_NAME] ?? {};
  servers[MCP_SERVER_NAME] = {
    ...previous,
    ...mcpServerEntry(url, apiKey),
    headers: { ...(previous.headers ?? {}), Authorization: `Bearer ${apiKey}` },
  };
  try {
    await copyFile(target, `${target}.bak`);
    // 备份里同样有各个 MCP 的凭证，权限和原文件一样收紧。
    await chmod(`${target}.bak`, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeJsonAtomic(target, { ...existing, mcpServers: servers }, 0o600);
  return { file: target, server: MCP_SERVER_NAME, action: updated ? "updated" : "added" };
}

async function setup(options) {
  const apiKey = typeof options["api-key"] === "string" ? options["api-key"].trim() : "";
  if (!apiKey) {
    throw new UserFacingError("缺少 --api-key。请在 AITA「MCP 服务」页面复制 API Key。");
  }
  const current = await loadConfig();
  const url = (typeof options.url === "string" && options.url.trim()) || current?.url || DEFAULT_URL;
  const client = (typeof options.client === "string" && options.client.trim()) || current?.client || "unknown";

  // 先校验再落盘：Key 不可用时不留下任何配置。
  await verifyKey({ apiKey, url, client });

  await writeJsonAtomic(CONFIG_FILE, { url, apiKey, client }, 0o600);
  const result = {
    status: "CONFIGURED",
    url,
    api_key: maskKey(apiKey),
    skill_config: CONFIG_FILE,
  };

  if (typeof options["mcp-config"] === "string" && options["mcp-config"].trim()) {
    result.mcp = await upsertMcpConfig(options["mcp-config"].trim(), url, apiKey);
    result.message = "配置完成，MCP 连接已写入。客户端如未自动加载，重启后生效。";
  } else {
    // 没给配置文件时不猜位置，把标准条目交回去，由当前平台按自己的方式添加。
    result.mcp_server = { name: MCP_SERVER_NAME, config: mcpServerEntry(url, "<API Key>") };
    result.message = "技能配置完成。如需同时连接 AITA MCP，请按当前平台的方式添加 mcp_server 中的配置（把 <API Key> 换成刚才的 Key）。";
  }
  return result;
}

async function status() {
  const local = await loadConfig();
  if (!local) {
    return {
      status: "NOT_CONFIGURED",
      message: "尚未配置 AITA。请向用户索取 AITA API Key（在 AITA「MCP 服务」页面生成），然后运行 setup。",
    };
  }
  return {
    status: "CONFIGURED",
    url: local.url || DEFAULT_URL,
    api_key: maskKey(local.apiKey),
    client: local.client || "unknown",
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let requestSeq = 0;

/** 调一次 MCP 工具，返回工具结果里的 JSON 对象。 */
async function callTool(cfg, name, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: ++requestSeq,
    method: "tools/call",
    params: { name, arguments: args },
  });

  let lastError;
  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    let response;
    try {
      response = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${cfg.apiKey}`,
          "User-Agent": `aita-skill/${VERSION} (${cfg.client})`,
        },
        body,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    // 5xx 和网关错误可重试；4xx 是请求本身的问题，重试无意义。
    if (response.status >= 500) {
      lastError = new Error(`HTTP ${response.status}`);
      continue;
    }
    if (!response.ok) {
      throw new UserFacingError(`AITA 服务返回 HTTP ${response.status}，请检查 MCP 服务地址是否正确，可用 setup --url 重新配置。`);
    }
    return parseToolResult(await readJsonRpc(response));
  }
  throw new TransientError(`暂时连不上 AITA 服务（${lastError?.message ?? "未知错误"}），请稍后重试。`);
}

/** 服务端可能直接回 JSON，也可能回 SSE；两种都兼容。 */
async function readJsonRpc(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const message = JSON.parse(dataLines[i]);
    if (message.result !== undefined || message.error !== undefined) return message;
  }
  throw new UserFacingError("AITA 服务返回了无法识别的响应。");
}

function parseToolResult(message) {
  if (message.error) {
    throw new UserFacingError(message.error.message || "AITA 服务调用失败。");
  }
  const result = message.result || {};
  const text = (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  // 鉴权失败、额度不足等：服务端给的就是面向用户的提示，原样交给模型转述。
  if (result.isError) {
    throw new UserFacingError(text || "AITA 服务调用失败。");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UserFacingError("AITA 服务返回了无法识别的响应。");
  }
}

/** 报告正文落盘，只把路径交给模型。 */
async function saveReport(cfg, payload) {
  if (!payload.result_markdown) return payload;
  const dir = path.resolve(cfg.reportDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${payload.task_id || "aita-report"}.md`);
  await writeFile(file, payload.result_markdown, "utf8");
  const { result_markdown: markdown, ...rest } = payload;
  return { ...rest, result_file: file, result_length: markdown.length };
}

/** 一直等到任务不再是 RUNNING。不设总时长上限：洞察可能跑几十分钟，中途退出只会让模型再起一次轮询。 */
async function poll(cfg, taskId) {
  let interval = DEFAULT_POLL_SECONDS;
  for (;;) {
    let payload;
    try {
      payload = await callTool(cfg, "aita_query_task", { task_id: taskId });
    } catch (error) {
      // 网络抖动、服务重启：任务在服务端不受影响，隔一会儿接着查。鉴权失败等其他错误照常退出。
      if (!(error instanceof TransientError)) throw error;
      process.stderr.write(`[aita] ${error.message} ${interval} 秒后重试\n`);
      await sleep(interval * 1000);
      continue;
    }
    if (payload.status !== "RUNNING") return payload;

    interval = Math.max(MIN_POLL_SECONDS, Number(payload.next_poll_after_seconds) || DEFAULT_POLL_SECONDS);
    await sleep(interval * 1000);
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "status" || command === "setup") {
    console.log(JSON.stringify(command === "status" ? await status() : await setup(options), null, 2));
    return;
  }
  const cfg = await config();
  const taskId = typeof options["task-id"] === "string" ? options["task-id"].trim() : undefined;

  let payload;
  switch (command) {
    case "start": {
      if (typeof options.instruction !== "string" || !options.instruction.trim()) {
        throw new UserFacingError("缺少 --instruction。");
      }
      const args = { instruction: options.instruction };
      if (taskId) args.task_id = taskId;
      // 只发起、立即返回：task_id 要先落到模型上下文里，再由单独的 poll 去等结果。
      // 两者放在同一个进程里，进程一旦被工具超时杀掉，task_id 就丢了，模型只能重新发起、留下孤儿任务。
      payload = await callTool(cfg, "aita_start_task", args);
      break;
    }
    case "poll":
      if (!taskId) throw new UserFacingError("缺少 --task-id。");
      payload = await poll(cfg, taskId);
      break;
    case "query":
      if (!taskId) throw new UserFacingError("缺少 --task-id。");
      payload = await callTool(cfg, "aita_query_task", { task_id: taskId });
      break;
    default:
      throw new UserFacingError(
        "用法：aita.mjs <status|setup|start|poll|query> [--api-key <Key>] [--instruction <文本>] [--task-id <任务编号>]",
      );
  }
  console.log(JSON.stringify(await saveReport(cfg, payload), null, 2));
}

main().catch((error) => {
  const message = error instanceof UserFacingError ? error.message : `脚本执行异常：${error.message}`;
  console.log(JSON.stringify({ status: "ERROR", message }, null, 2));
  process.exitCode = 1;
});
