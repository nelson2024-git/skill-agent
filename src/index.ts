/**
 * Skill Agent - 基于 pi-agent-core + GitHub Copilot 的智能运维 Agent
 * 
 * 核心功能：
 * 1. 加载 skills/ 目录下的 Skill（SKILL.md + scripts/）
 * 2. 将 Skill 注册为 pi AgentTool
 * 3. 通过 node-cron 实现定时调度
 * 4. 使用 GitHub Copilot 订阅作为 LLM 提供商
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple, getModels, registerBuiltInApiProviders, getEnvApiKey } from "@mariozechner/pi-ai";
import { loadSkills, type SkillDefinition } from "./skill-loader.js";
import { Scheduler } from "./scheduler.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// ============================================================
// .env 加载（轻量实现，无需额外依赖）
// ============================================================
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotEnv();

// ============================================================
// Copilot Token 管理：gho_ token → 短期 API token + 定时刷新
// ============================================================

/** .env 中存的是 gho_ 开头的 OAuth token（长期有效，由 login.ts 获取） */
let oauthToken: string = "";        // gho_ token，用于刷新 API token
let cachedApiToken: string | null = null;  // 短期 API token（约 30 分钟有效）
let apiTokenExpiry = 0;             // API token 过期时间（unix 秒）
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const REFRESH_INTERVAL_MS = 25 * 60 * 1000; // 每 25 分钟刷新一次

/** 用 gho_ OAuth token 换取短期 Copilot API token */
async function refreshApiToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // 缓存未过期，直接返回
  if (cachedApiToken && apiTokenExpiry > now + 60) {
    return cachedApiToken;
  }

  if (!oauthToken) {
    // 从环境变量获取 gho_ token
    oauthToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  }

  if (!oauthToken) {
    throw new Error("未设置 GitHub Token，请先运行: npx tsx src/login.ts");
  }

  // gho_ token 不能直接调 Copilot API，需要换取 API token
  console.log("[Copilot] 正在刷新 API Token...");
  const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      "Authorization": `token ${oauthToken}`,
      "Accept": "application/json",
      "User-Agent": "skill-agent",
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    // 如果 gho_ token 也过期了，提示重新登录
    if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
      throw new Error(
        `Copilot Token 刷新失败 (HTTP ${resp.status})\n` +
        `  OAuth Token 可能已过期，请重新运行: npx tsx src/login.ts\n` +
        `  原因: ${body}`
      );
    }
    throw new Error(`Copilot Token 刷新失败 (HTTP ${resp.status}): ${body}`);
  }

  const data = await resp.json() as any;
  cachedApiToken = data.token;
  apiTokenExpiry = data.expires_at;
  const expiresAt = new Date(data.expires_at * 1000);
  console.log(`[Copilot] ✅ API Token 刷新成功，有效期至 ${expiresAt.toLocaleString("zh-CN")}`);

  // 更新环境变量供 pi-ai 内部使用
  process.env.COPILOT_GITHUB_TOKEN = cachedApiToken!;

  return cachedApiToken!;
}

/** 启动定时刷新（每 25 分钟） */
function startTokenRefresh(): void {
  if (refreshTimer) return; // 已启动

  refreshTimer = setInterval(async () => {
    try {
      await refreshApiToken();
    } catch (err) {
      console.error(`[Copilot] 定时刷新失败: ${err instanceof Error ? err.message : err}`);
    }
  }, REFRESH_INTERVAL_MS);

  // 不阻止进程退出
  if (refreshTimer.unref) refreshTimer.unref();
  console.log(`[Copilot] 定时刷新已启动 (每 ${REFRESH_INTERVAL_MS / 60000} 分钟)`);
}

/** 停止定时刷新 */
function stopTokenRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ============================================================
// 配置
// ============================================================
interface AgentConfig {
  /** LLM 提供商，默认 github-copilot */
  provider: string;
  /** 模型 ID，默认 gpt-4.1 */
  model: string;
  /** 思考级别 */
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
  /** skills 目录路径 */
  skillsDir: string;
  /** 系统提示词 */
  systemPrompt: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  provider: process.env.SKILL_AGENT_PROVIDER || "github-copilot",
  model: process.env.SKILL_AGENT_MODEL || "gpt-4.1",
  thinkingLevel: (process.env.SKILL_AGENT_THINKING as AgentConfig["thinkingLevel"]) || "low",
  skillsDir: process.env.SKILL_AGENT_SKILLS_DIR || "./skills",
  systemPrompt: process.env.SKILL_AGENT_SYSTEM_PROMPT || `你是 Skill Agent，一个智能运维助手。

你可以通过加载的 Skill 工具执行各种运维任务。每个 Skill 对应一个具体功能，调用时传入参数即可。

规则：
1. 执行任何操作前先分析影响范围
2. 危险操作（删除、清理等）需要确认
3. 输出结构化的分析结果和建议
4. 如果不确定，先做 dry-run`,
};

// ============================================================
// HTTP 辅助
// ============================================================
function readRequestBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: string) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ============================================================
// Agent 运行时
// ============================================================
export class SkillAgent {
  private config: AgentConfig;
  private skills: SkillDefinition[] = [];
  private scheduler: Scheduler;
  private agent: Agent | null = null;

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scheduler = new Scheduler();
  }

  /** 初始化：加载 Skills + 创建 Agent */
  async init() {
    console.log("[SkillAgent] 正在初始化...");

    // 1. 加载 Skills
    this.skills = await loadSkills(this.config.skillsDir);
    console.log(`[SkillAgent] 加载了 ${this.skills.length} 个 Skill:`);
    this.skills.forEach(s => {
      console.log(`  - ${s.name}: ${s.description}`);
      if (s.schedule) {
        console.log(`    定时: ${s.schedule}`);
      }
    });

    // 2. 刷新 Copilot API Token
    await refreshApiToken();
    startTokenRefresh();

    // 3. 获取 LLM 模型
    const model = getModel(this.config.provider, this.config.model);
    console.log(`[SkillAgent] 使用模型: ${model.provider}/${model.id}`);

    // 4. 将 Skills 转为 AgentTool
    const tools = this.skills.map(skill => skill.tool);

    // 5. 创建 Agent（getApiKey 自动刷新 Copilot Token）
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.config.systemPrompt,
        model,
        tools,
        thinkingLevel: this.config.thinkingLevel,
      },
      streamFn: streamSimple,
      getApiKey: async (provider: string) => {
        if (provider === "github-copilot") {
          return await refreshApiToken();
        }
        return getEnvApiKey(provider);
      },
    });

    // 6. 订阅事件
    this.agent.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          console.log("[Agent] 开始处理");
          break;
        case "message_update": {
          const e = event as any;
          if (e.assistantMessageEvent?.type === "text_delta") {
            process.stdout.write(e.assistantMessageEvent.delta);
          }
          break;
        }
        case "tool_execution_start":
          console.log(`\n[Tool] 执行: ${event.toolName}(${JSON.stringify(event.args)})`);
          break;
        case "tool_execution_end":
          console.log(`[Tool] 完成: ${event.isError ? "❌ 失败" : "✅ 成功"}`);
          break;
        case "message_end": {
          const e = event as any;
          if (e.message?.stopReason === "error") {
            console.error(`\n❌ LLM 错误: ${e.message.errorMessage || "未知错误"}`);
          }
          break;
        }
        case "agent_end":
          console.log("\n[Agent] 处理完成");
          break;
      }
    });

    // 7. 注册定时任务
    this.skills.forEach(skill => {
      if (skill.schedule) {
        this.scheduler.addJob(skill.name, skill.schedule, async () => {
          console.log(`[Scheduler] 定时触发 Skill: ${skill.name}`);
          await this.runPrompt(
            `定时执行 Skill "${skill.name}"，参数为默认值。请执行并报告结果。`
          );
        });
        console.log(`[Scheduler] 已注册定时任务: ${skill.name} (${skill.schedule})`);
      }
    });

    console.log("[SkillAgent] 初始化完成 ✓");
  }

  /** 手动发送 prompt 给 Agent */
  async runPrompt(prompt: string): Promise<string> {
    if (!this.agent) throw new Error("Agent 未初始化，请先调用 init()");

    let result = "";
    this.agent.subscribe((event) => {
      if (event.type === "message_update") {
        const e = event as any;
        if (e.assistantMessageEvent?.type === "text_delta") {
          result += e.assistantMessageEvent.delta;
        }
      }
    });

    await this.agent.prompt(prompt);
    return result;
  }

  /** 手动触发指定 Skill */
  async runSkill(skillName: string, args?: Record<string, unknown>): Promise<string> {
    const skill = this.skills.find(s => s.name === skillName);
    if (!skill) throw new Error(`Skill "${skillName}" 不存在`);

    const argsStr = args ? JSON.stringify(args) : "默认参数";
    return this.runPrompt(`执行 Skill "${skillName}"，参数: ${argsStr}`);
  }

  /** 列出所有 Skills */
  listSkills(): SkillDefinition[] {
    return this.skills;
  }

  /** 列出所有定时任务 */
  listSchedules() {
    return this.scheduler.listJobs();
  }

  /** 启动调度器 */
  startScheduler() {
    this.scheduler.start();
    console.log("[Scheduler] 定时调度已启动");
  }

  /** 停止调度器 */
  stopScheduler() {
    this.scheduler.stop();
    console.log("[Scheduler] 定时调度已停止");
  }

  /** 启动 HTTP API 服务（用于 systemd 后台模式下的远程交互） */
  async startApiServer(port: number = 38080): Promise<void> {
    const http = await import("http");

    const server = http.createServer(async (req, res) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const url = new URL(req.url || "/", `http://localhost:${port}`);

      try {
        // GET / — 状态页
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "running",
            skills: this.skills.map(s => ({ name: s.name, description: s.description, schedule: s.schedule || null })),
            schedules: this.listSchedules(),
          }));
          return;
        }

        // GET /skills — 列出 Skills
        if (req.method === "GET" && url.pathname === "/skills") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.skills.map(s => ({
            name: s.name, description: s.description, schedule: s.schedule || null,
            parameters: s.parameters,
          }))));
          return;
        }

        // POST /chat — 与 Agent 对话
        if (req.method === "POST" && url.pathname === "/chat") {
          const body = await readRequestBody(req);
          const { message } = JSON.parse(body);
          if (!message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "缺少 message 字段" }));
            return;
          }
          console.log(`[API] 收到消息: ${message}`);
          const result = await this.runPrompt(message);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply: result }));
          return;
        }

        // POST /run — 运行指定 Skill
        if (req.method === "POST" && url.pathname === "/run") {
          const body = await readRequestBody(req);
          const { skill, args } = JSON.parse(body);
          if (!skill) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "缺少 skill 字段" }));
            return;
          }
          console.log(`[API] 运行 Skill: ${skill}`);
          const result = await this.runSkill(skill, args);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply: result }));
          return;
        }

        // 404
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
      } catch (err) {
        console.error(`[API] 错误:`, err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });

    server.listen(port, () => {
      console.log(`[API] HTTP 服务已启动: http://localhost:${port}`);
      console.log(`[API]   GET  /         — 状态信息`);
      console.log(`[API]   GET  /skills   — 列出 Skills`);
      console.log(`[API]   POST /chat     — 与 Agent 对话 {"message":"你好"}`);
      console.log(`[API]   POST /run      — 运行 Skill {"skill":"harbor-check"}`);
    });
  }

  /** 交互式 REPL */
  async repl() {
    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log("\n=== Skill Agent REPL ===");
    console.log("输入问题或命令，Ctrl+C 退出\n");
    console.log("特殊命令:");
    console.log("  /skills   - 列出所有 Skills");
    console.log("  /schedule - 列出定时任务");
    console.log("  /run <skill> [args] - 运行指定 Skill");
    console.log("");

    const ask = (): void => {
      rl.question("你> ", async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          ask();
          return;
        }

        try {
          if (trimmed === "/skills") {
            this.listSkills().forEach(s => {
              console.log(`  ${s.name} - ${s.description}${s.schedule ? ` [定时: ${s.schedule}]` : ""}`);
            });
          } else if (trimmed === "/schedule") {
            const jobs = this.listSchedules();
            if (jobs.length === 0) {
              console.log("  暂无定时任务");
            } else {
              jobs.forEach(j => console.log(`  ${j.name}: ${j.schedule} [${j.running ? "运行中" : "已停止"}]`));
            }
          } else if (trimmed.startsWith("/run ")) {
            const parts = trimmed.substring(5).trim().split(/\s+/);
            const skillName = parts[0];
            const result = await this.runSkill(skillName);
            console.log(`\n${result}\n`);
          } else {
            const result = await this.runPrompt(trimmed);
            console.log(`\n${result}\n`);
          }
        } catch (err) {
          console.error(`错误: ${err}`);
        }

        ask();
      });
    };

    ask();
  }
}

// ============================================================
// CLI 入口
// ============================================================
async function main() {
  const args = process.argv.slice(2);

  // 解析命令行参数
  const config: Partial<AgentConfig> = {};
  let mode: "repl" | "list" | "run" | "serve" = "repl";
  let runSkillName = "";
  let apiPort = parseInt(process.env.SKILL_AGENT_PORT || "38080", 10);

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider":
        config.provider = args[++i];
        break;
      case "--model":
        config.model = args[++i];
        break;
      case "--skills-dir":
        config.skillsDir = args[++i];
        break;
      case "--list":
        mode = "list";
        break;
      case "--run":
        mode = "run";
        runSkillName = args[++i];
        break;
      case "--serve":
        mode = "serve";
        break;
      case "--port":
        apiPort = parseInt(args[++i], 10);
        break;
      case "--list-models": {
        registerBuiltInApiProviders();
        const models = getModels("github-copilot");
        console.log("GitHub Copilot 可用模型:");
        models.forEach(m => console.log(`  ${m.id} - ${m.name} (context: ${m.contextWindow}, maxOut: ${m.maxTokens})`));
        process.exit(0);
      }
      case "--help":
        console.log(`
Skill Agent - 基于 pi + GitHub Copilot 的智能运维 Agent

用法: skill-agent [选项]

  选项:
  --provider <provider>    LLM 提供商 (默认: github-copilot)
  --model <model>          模型 ID (默认: gpt-4.1)
  --skills-dir <path>      Skills 目录 (默认: ./skills)
  --list                   列出所有 Skills 并退出
  --list-models            列出 GitHub Copilot 可用模型并退出
  --run <skill-name>       运行指定 Skill 并退出
  --serve                  启动 HTTP API 服务 (后台模式)
  --port <port>            HTTP 端口 (默认: 38080)
  --help                   显示帮助

环境变量:
  COPILOT_GITHUB_TOKEN     GitHub Copilot token (优先级最高)
  GH_TOKEN                 GitHub CLI token
  GITHUB_TOKEN             GitHub token (优先级最低)

示例:
  # 交互式 REPL
  skill-agent

  # 列出可用模型
  skill-agent --list-models

  # 运行指定 Skill
  skill-agent --run harbor-check

  # 使用指定模型
  skill-agent --model claude-sonnet-4.5
`);
        process.exit(0);
    }
  }

  // 检查 Token
  const token = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("[SkillAgent] ⚠️ 未检测到 GitHub Token");
    console.warn("  请先运行登录工具获取 Copilot OAuth Token:");
    console.warn("    npx tsx src/login.ts");
    console.warn("");
    console.warn("  仅 --list / --list-models 模式可无 Token 运行");
    if (mode !== "list" && mode !== "list-models") {
      process.exit(1);
    }
  } else {
    const prefix = token.substring(0, 4);
    const typeLabel = prefix === "gho_" ? "Copilot OAuth ✅" : prefix === "ghp_" ? "PAT (建议换 gho_ token)" : "未知类型";
    console.log(`[SkillAgent] GitHub Token: ${prefix}...${token.substring(token.length - 4)} (${typeLabel})`);
  }

  // 创建 Agent
  const agent = new SkillAgent(config);
  await agent.init();

  switch (mode) {
    case "list": {
      console.log("\n已加载的 Skills:");
      agent.listSkills().forEach(s => {
        console.log(`  ${s.name} - ${s.description}`);
        if (s.schedule) console.log(`    定时: ${s.schedule}`);
        if (s.parameters) {
          const params = s.parameters as Record<string, Record<string, string>>;
          Object.entries(params).forEach(([k, v]) => {
            console.log(`    参数: ${k} (${v.type || "string"}) - ${v.description || ""}`);
          });
        }
      });
      break;
    }
    case "run": {
      const result = await agent.runSkill(runSkillName);
      console.log(result);
      break;
    }
    case "repl": {
      agent.startScheduler();
      await agent.startApiServer(apiPort); // REPL 模式也开 API
      await agent.repl();
      break;
    }
    case "serve": {
      agent.startScheduler();
      await agent.startApiServer(apiPort);
      console.log("[SkillAgent] 后台服务模式，通过 HTTP API 交互");
      // 保持进程运行
      process.on("SIGTERM", () => { agent.stopScheduler(); stopTokenRefresh(); process.exit(0); });
      process.on("SIGINT", () => { agent.stopScheduler(); stopTokenRefresh(); process.exit(0); });
      break;
    }
  }
}

// 仅在直接运行时执行 main
const isMainModule = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMainModule) {
  main().catch(console.error);
}

export { main };
