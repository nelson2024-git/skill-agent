#!/usr/bin/env bash
# ============================================================
# Skill Agent 一键安装脚本 (源码版)
# 适用: Linux 服务器，需能访问外网 (npm install)
# 用法: bash setup-skill-agent.sh [/opt/skill-agent]
# ============================================================
set -euo pipefail

INSTALL_DIR="${1:-/opt/skill-agent}"

echo "========================================="
echo "  Skill Agent 安装脚本"
echo "  目标目录: ${INSTALL_DIR}"
echo "========================================="
echo ""

# 1. 检查 Node.js
echo "[1/5] 检查 Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  echo "  ✅ Node.js ${NODE_VER}"
else
  echo "  ❌ Node.js 未安装"
  echo ""
  echo "请先安装 Node.js 22+:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs"
  exit 1
fi

# 2. 创建目录并写入源文件
echo ""
echo "[2/5] 写入项目文件..."
mkdir -p "${INSTALL_DIR}"/{src,deploy,skills/{hello/scripts,harbor-check/scripts,system-info/scripts}}

# --- package.json ---
cat > "${INSTALL_DIR}/package.json" << 'PKGJSON'
{
  "name": "skill-agent",
  "version": "1.0.0",
  "description": "基于 pi + GitHub Copilot 的智能运维 Agent",
  "main": "dist/index.js",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "dependencies": {
    "@mariozechner/pi-agent-core": "^0.73.1",
    "@mariozechner/pi-ai": "^0.73.1",
    "chalk": "^5.6.2",
    "js-yaml": "^4.1.1",
    "node-cron": "^4.2.1"
  },
  "devDependencies": {
    "@types/node": "^25.6.2",
    "@types/node-cron": "^3.0.11",
    "tsx": "^4.21.0",
    "typescript": "^6.0.3"
  }
}
PKGJSON

# --- tsconfig.json ---
cat > "${INSTALL_DIR}/tsconfig.json" << 'TSCONFIG'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
TSCONFIG

# --- .env.example ---
cat > "${INSTALL_DIR}/.env.example" << 'ENVEGX'
# ============================================================
# Skill Agent 环境变量配置
# 复制此文件为 .env 并填入实际值: cp .env.example .env
# ============================================================

# --- GitHub Copilot Token (必填) ---
# 获取方式:
#   方式1: gh auth token          (需要 GitHub CLI)
#   方式2: https://github.com/settings/tokens → Generate new token (classic) → copilot scope
# 优先级: COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN
COPILOT_GITHUB_TOKEN=gho_xxxx

# --- LLM 模型配置 (可选) ---
#SKILL_AGENT_PROVIDER=github-copilot
#SKILL_AGENT_MODEL=gpt-4.1
#SKILL_AGENT_THINKING=low
#SKILL_AGENT_SKILLS_DIR=./skills

# --- Harbor 巡检 (可选) ---
#HARBOR_TOKEN=
#HARBOR_URL=https://xcloud.lenovo.com/api/v2.0

# --- 代理设置 (可选) ---
#HTTPS_PROXY=http://proxy.lenovo.com:8080
#HTTP_PROXY=http://proxy.lenovo.com:8080
#NO_PROXY=localhost,127.0.0.1,xcloud.lenovo.com
ENVEGX

# --- src/index.ts ---
cat > "${INSTALL_DIR}/src/index.ts" << 'INDEXTS'
/**
 * Skill Agent - 基于 pi-agent-core + GitHub Copilot 的智能运维 Agent
 *
 * 核心功能：
 * 1. 加载 skills/ 目录下的 Skill（SKILL.md + skill.yaml + scripts/）
 * 2. 将 Skill 注册为 pi AgentTool
 * 3. 通过 node-cron 实现定时调度
 * 4. 使用 GitHub Copilot 订阅作为 LLM 提供商
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple, getModels, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
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
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}
loadDotEnv();

// ============================================================
// 配置
// ============================================================
interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
  skillsDir: string;
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

  async init() {
    console.log("[SkillAgent] 正在初始化...");

    this.skills = await loadSkills(this.config.skillsDir);
    console.log(`[SkillAgent] 加载了 ${this.skills.length} 个 Skill:`);
    this.skills.forEach(s => {
      console.log(`  - ${s.name}: ${s.description}`);
      if (s.schedule) console.log(`    定时: ${s.schedule}`);
    });

    const model = getModel(this.config.provider, this.config.model);
    console.log(`[SkillAgent] 使用模型: ${model.provider}/${model.id}`);

    const tools = this.skills.map(skill => skill.tool);

    this.agent = new Agent({
      initialState: {
        systemPrompt: this.config.systemPrompt,
        model,
        tools,
        thinkingLevel: this.config.thinkingLevel,
      },
      streamFn: streamSimple,
    });

    this.agent.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          console.log("[Agent] 开始处理");
          break;
        case "tool_execution_start":
          console.log(`[Tool] 执行: ${event.toolName}(${JSON.stringify(event.args)})`);
          break;
        case "tool_execution_end":
          console.log(`[Tool] 完成: ${event.isError ? "❌ 失败" : "✅ 成功"}`);
          break;
        case "agent_end":
          console.log("[Agent] 处理完成");
          break;
      }
    });

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

  async runPrompt(prompt: string): Promise<string> {
    if (!this.agent) throw new Error("Agent 未初始化，请先调用 init()");

    let result = "";
    this.agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        result += event.assistantMessageEvent.delta;
      }
    });

    await this.agent.prompt(prompt);
    return result;
  }

  async runSkill(skillName: string, args?: Record<string, unknown>): Promise<string> {
    const skill = this.skills.find(s => s.name === skillName);
    if (!skill) throw new Error(`Skill "${skillName}" 不存在`);
    const argsStr = args ? JSON.stringify(args) : "默认参数";
    return this.runPrompt(`执行 Skill "${skillName}"，参数: ${argsStr}`);
  }

  listSkills(): SkillDefinition[] { return this.skills; }
  listSchedules() { return this.scheduler.listJobs(); }
  startScheduler() { this.scheduler.start(); console.log("[Scheduler] 定时调度已启动"); }
  stopScheduler() { this.scheduler.stop(); console.log("[Scheduler] 定时调度已停止"); }

  async repl() {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log("\n=== Skill Agent REPL ===");
    console.log("输入问题或命令，Ctrl+C 退出\n");
    console.log("特殊命令:");
    console.log("  /skills   - 列出所有 Skills");
    console.log("  /schedule - 列出定时任务");
    console.log("  /run <skill> [args] - 运行指定 Skill\n");

    const ask = (): void => {
      rl.question("你> ", async (input) => {
        const trimmed = input.trim();
        if (!trimmed) { ask(); return; }

        try {
          if (trimmed === "/skills") {
            this.listSkills().forEach(s => {
              console.log(`  ${s.name} - ${s.description}${s.schedule ? ` [定时: ${s.schedule}]` : ""}`);
            });
          } else if (trimmed === "/schedule") {
            const jobs = this.listSchedules();
            if (jobs.length === 0) console.log("  暂无定时任务");
            else jobs.forEach(j => console.log(`  ${j.name}: ${j.schedule} [${j.running ? "运行中" : "已停止"}]`));
          } else if (trimmed.startsWith("/run ")) {
            const parts = trimmed.substring(5).trim().split(/\s+/);
            const result = await this.runSkill(parts[0]);
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
  const config: Partial<AgentConfig> = {};
  let mode: "repl" | "list" | "run" = "repl";
  let runSkillName = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider": config.provider = args[++i]; break;
      case "--model": config.model = args[++i]; break;
      case "--skills-dir": config.skillsDir = args[++i]; break;
      case "--list": mode = "list"; break;
      case "--run": mode = "run"; runSkillName = args[++i]; break;
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
  --help                   显示帮助

环境变量:
  COPILOT_GITHUB_TOKEN     GitHub Copilot token (优先级最高)
  GH_TOKEN                 GitHub CLI token
  GITHUB_TOKEN             GitHub token (优先级最低)

示例:
  skill-agent                        # 交互式 REPL
  skill-agent --list-models          # 列出可用模型
  skill-agent --run harbor-check     # 运行指定 Skill
  skill-agent --model claude-sonnet-4.5
`);
        process.exit(0);
    }
  }

  const token = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("[SkillAgent] ⚠️ 未检测到 GitHub Copilot Token");
    console.warn("  请设置环境变量: COPILOT_GITHUB_TOKEN=gho_xxxx");
    console.warn("  或创建 .env 文件: cp .env.example .env && vi .env");
    console.warn("  仅 --list / --list-models 模式可无 Token 运行");
    if (mode !== "list") process.exit(1);
  } else {
    console.log(`[SkillAgent] GitHub Copilot Token: ${token.substring(0, 8)}...${token.substring(token.length - 4)}`);
  }

  const agent = new SkillAgent(config);
  await agent.init();

  switch (mode) {
    case "list": {
      console.log("\n已加载的 Skills:");
      agent.listSkills().forEach(s => {
        console.log(`  ${s.name} - ${s.description}`);
        if (s.schedule) console.log(`    定时: ${s.schedule}`);
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
      await agent.repl();
      break;
    }
  }
}

const isMainModule = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMainModule) main().catch(console.error);

export { main };
INDEXTS

# --- src/skill-loader.ts ---
cat > "${INSTALL_DIR}/src/skill-loader.ts" << 'SKILLLOADER'
/**
 * Skill Loader - 扫描 skills/ 目录，解析 SKILL.md + skill.yaml，注册为 pi AgentTool
 *
 * Skill 目录规范:
 *   skills/<skill-name>/
 *   ├── SKILL.md        # agentskills.io 标准格式的技能描述
 *   ├── skill.yaml      # 元数据：参数定义、调度规则、配置
 *   └── scripts/
 *       ├── run.sh      # Shell 脚本入口
 *       └── run.py      # Python 脚本入口
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { load as loadYaml } from "js-yaml";
import { execFile } from "child_process";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export interface SkillParameter {
  type: "string" | "number" | "boolean";
  description?: string;
  default?: unknown;
  required?: boolean;
  enum?: string[];
}

export interface SkillYaml {
  name: string;
  version?: string;
  description: string;
  schedule?: string;
  executor?: "bash" | "python3";
  entry?: string;
  timeout?: number;
  parameters?: Record<string, SkillParameter>;
  env?: Record<string, string>;
}

export interface SkillDefinition {
  name: string;
  description: string;
  schedule?: string;
  parameters?: Record<string, SkillParameter>;
  skillYaml: SkillYaml;
  skillMd: string;
  dir: string;
  tool: AgentTool;
}

function parseSkillMd(filePath: string): string {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf-8");
}

function parseSkillYaml(filePath: string): SkillYaml | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    return loadYaml(content) as SkillYaml;
  } catch (err) {
    console.error(`[SkillLoader] 解析 ${filePath} 失败:`, err);
    return null;
  }
}

function buildParametersSchema(params: Record<string, SkillParameter> | undefined) {
  if (!params || Object.keys(params).length === 0) return Type.Object({});

  const properties: Record<string, ReturnType<typeof Type.String | typeof Type.Number | typeof Type.Boolean>> = {};
  const required: string[] = [];

  for (const [key, param] of Object.entries(params)) {
    const opts: Record<string, unknown> = {};
    if (param.description) opts.description = param.description;
    if (param.default !== undefined) opts.default = param.default;
    if (param.enum) opts.enum = param.enum;

    switch (param.type) {
      case "number": properties[key] = Type.Number(opts); break;
      case "boolean": properties[key] = Type.Boolean(opts); break;
      default: properties[key] = Type.String(opts);
    }
    if (param.required) required.push(key);
  }

  return Type.Object(properties, { required });
}

function executeSkillScript(
  skillDir: string,
  skillYaml: SkillYaml,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const executor = skillYaml.executor || "bash";
    const entry = skillYaml.entry || (executor === "python3" ? "scripts/run.py" : "scripts/run.sh");
    const scriptPath = join(skillDir, entry);

    if (!existsSync(scriptPath)) {
      reject(new Error(`脚本不存在: ${scriptPath}`));
      return;
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SKILL_ARGS: JSON.stringify(params),
      SKILL_DIR: skillDir,
      SKILL_NAME: skillYaml.name,
    };

    if (skillYaml.env) {
      Object.entries(skillYaml.env).forEach(([k, v]) => { env[k] = v; });
    }

    const timeout = skillYaml.timeout || 60000;

    const child = execFile(
      executor, [scriptPath],
      { env, timeout, signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stderr) { reject(error); return; }
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: error ? (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? -1 : 1 : 0,
        });
      }
    );

    signal?.addEventListener("abort", () => { child.kill("SIGTERM"); });
  });
}

function createSkillTool(skillDir: string, skillYaml: SkillYaml, skillMd: string): AgentTool {
  const parametersSchema = buildParametersSchema(skillYaml.parameters);
  const description = `${skillYaml.description}\n\nSchedule: ${skillYaml.schedule || "手动触发"}\nExecutor: ${skillYaml.executor || "bash"}`;

  return {
    name: skillYaml.name,
    label: skillYaml.name,
    description,
    parameters: parametersSchema,
    execute: async (toolCallId, params, signal, onUpdate) => {
      try {
        onUpdate?.({ type: "progress", message: `正在执行 Skill: ${skillYaml.name}...` });
        const result = await executeSkillScript(skillDir, skillYaml, params as Record<string, unknown>, signal);
        const output = result.stderr
          ? `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
          : result.stdout;
        return {
          content: [{ type: "text" as const, text: output }],
          details: { exitCode: result.exitCode, skill: skillYaml.name },
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Skill 执行失败: ${errorMsg}` }],
          details: { error: true, skill: skillYaml.name },
        };
      }
    },
  };
}

export async function loadSkills(skillsDir: string): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];

  if (!existsSync(skillsDir)) {
    console.warn(`[SkillLoader] Skills 目录不存在: ${skillsDir}`);
    return skills;
  }

  const entries = readdirSync(skillsDir);

  for (const entry of entries) {
    const skillPath = join(skillsDir, entry);
    if (!statSync(skillPath).isDirectory()) continue;

    const yamlPath = join(skillPath, "skill.yaml");
    const skillYaml = parseSkillYaml(yamlPath);

    if (!skillYaml) {
      console.warn(`[SkillLoader] 跳过 ${entry}: 缺少 skill.yaml`);
      continue;
    }

    const mdPath = join(skillPath, "SKILL.md");
    const skillMd = parseSkillMd(mdPath);
    const tool = createSkillTool(skillPath, skillYaml, skillMd);

    skills.push({
      name: skillYaml.name,
      description: skillYaml.description,
      schedule: skillYaml.schedule,
      parameters: skillYaml.parameters,
      skillYaml, skillMd, dir: skillPath, tool,
    });
  }

  return skills;
}
SKILLLOADER

# --- src/scheduler.ts ---
cat > "${INSTALL_DIR}/src/scheduler.ts" << 'SCHEDTS'
/**
 * Scheduler - 基于 node-cron 的定时调度器
 */

import cron from "node-cron";

export interface ScheduledJob {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  task: cron.ScheduledTask | null;
  running: boolean;
}

export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();

  addJob(name: string, schedule: string, handler: () => Promise<void>): void {
    if (!cron.validate(schedule)) {
      console.error(`[Scheduler] 无效的 cron 表达式: ${schedule} (${name})`);
      return;
    }
    if (this.jobs.has(name)) {
      console.warn(`[Scheduler] 任务 "${name}" 已存在，将被覆盖`);
      this.removeJob(name);
    }
    this.jobs.set(name, { name, schedule, handler, task: null, running: false });
  }

  removeJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (!job) return false;
    if (job.task) job.task.stop();
    this.jobs.delete(name);
    return true;
  }

  start(): void {
    for (const [name, job] of this.jobs) {
      if (job.task) continue;
      const task = cron.schedule(job.schedule, async () => {
        if (job.running) {
          console.warn(`[Scheduler] 任务 "${name}" 仍在运行中，跳过本次触发`);
          return;
        }
        job.running = true;
        try { await job.handler(); }
        catch (err) { console.error(`[Scheduler] 任务 "${name}" 执行失败:`, err); }
        finally { job.running = false; }
      }, { scheduled: true, timezone: "Asia/Shanghai" });
      job.task = task;
    }
  }

  stop(): void {
    for (const [, job] of this.jobs) {
      if (job.task) { job.task.stop(); job.task = null; }
    }
  }

  listJobs(): Array<{ name: string; schedule: string; running: boolean }> {
    return Array.from(this.jobs.values()).map(job => ({
      name: job.name, schedule: job.schedule, running: job.running,
    }));
  }
}
SCHEDTS

# --- Skill: hello ---
cat > "${INSTALL_DIR}/skills/hello/skill.yaml" << 'HELLOYAML'
name: hello
version: "1.0"
description: "Agent 健康检查 - 输出系统信息和参数，验证 Skill 运行正常"
executor: bash
entry: scripts/run.sh
timeout: 10000
parameters:
  greeting:
    type: string
    description: "问候语"
    default: "Hello from Skill Agent!"
    required: false
HELLOYAML

cat > "${INSTALL_DIR}/skills/hello/SKILL.md" << 'HELLOMD'
# Hello Skill

用于验证 Skill Agent 基础功能的测试技能。

## 触发条件
当用户要求测试 Agent 是否正常工作时触发。

## 执行步骤
1. 输出当前时间
2. 输出系统基本信息
3. 打印传入的参数

## 输出格式
结构化文本，包含时间戳和参数值
HELLOMD

cat > "${INSTALL_DIR}/skills/hello/scripts/run.sh" << 'HELLOSH'
#!/usr/bin/env bash
set -euo pipefail

ARGS="${SKILL_ARGS:-{}}"
GREETING=$(echo "$ARGS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('greeting','Hello!'))" 2>/dev/null || echo "Hello!")

echo "========================================="
echo "  Skill Agent - Health Check"
echo "========================================="
echo ""
echo "Timestamp : $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Hostname  : $(hostname)"
echo "Skill Dir : ${SKILL_DIR:-N/A}"
echo "Skill Name: ${SKILL_NAME:-N/A}"
echo "Greeting  : ${GREETING}"
echo ""
echo "System Info:"
echo "  OS       : $(uname -s) $(uname -r)"
echo "  CPU      : $(nproc) cores"
echo "  Memory   : $(free -h | awk '/^Mem:/{print $2}')"
echo "  Uptime   : $(uptime -p)"
echo ""
echo "✅ Skill Agent 运行正常!"
HELLOSH
chmod +x "${INSTALL_DIR}/skills/hello/scripts/run.sh"

# --- Skill: harbor-check ---
cat > "${INSTALL_DIR}/skills/harbor-check/skill.yaml" << 'HARBORYAML'
name: harbor-check
version: "1.0"
description: "Harbor V1.8 仓库巡检 - 检查 API 可达性、存储使用、项目统计"
schedule: "0 9 * * 1-5"
executor: bash
entry: scripts/run.sh
timeout: 30000
parameters:
  harbor_url:
    type: string
    description: "Harbor API 地址"
    default: "https://xcloud.lenovo.com/api/v2.0"
    required: true
  check_projects:
    type: boolean
    description: "是否检查项目详情"
    default: false
env:
  HARBOR_URL: "https://xcloud.lenovo.com/api/v2.0"
HARBORYAML

cat > "${INSTALL_DIR}/skills/harbor-check/SKILL.md" << 'HARBORMD'
# Harbor 仓库巡检 Skill

检查 Harbor V1.8 镜像仓库的健康状态和资源使用情况。

## 触发条件
- 定时触发（工作日 9:00）
- 手动请求巡检时触发

## 执行步骤
1. 检查 Harbor API 可达性
2. 获取系统信息（版本、存储）
3. 检查各项目仓库统计
4. 输出巡检报告

## 输出格式
结构化巡检报告，包含状态标识（✅/⚠️/❌）
HARBORMD

cat > "${INSTALL_DIR}/skills/harbor-check/scripts/run.sh" << 'HARBORSH'
#!/usr/bin/env bash
set -euo pipefail

ARGS="${SKILL_ARGS:-{}}"
HARBOR_URL=$(echo "$ARGS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('harbor_url','https://xcloud.lenovo.com/api/v2.0'))" 2>/dev/null || echo "https://xcloud.lenovo.com/api/v2.0")
CHECK_PROJECTS=$(echo "$ARGS" | python3 -c "import sys,json; print(str(json.load(sys.stdin).get('check_projects',False)).lower())" 2>/dev/null || echo "false")

echo "========================================="
echo "  Harbor V1.8 仓库巡检报告"
echo "========================================="
echo ""
echo "巡检时间 : $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "目标地址 : ${HARBOR_URL}"
echo ""

echo "--- [1] API 可达性 ---"
HTTP_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" --connect-timeout 5 "${HARBOR_URL}/systeminfo" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "401" ]; then
  echo "  ✅ Harbor API 可达 (HTTP ${HTTP_STATUS})"
else
  echo "  ❌ Harbor API 不可达 (HTTP ${HTTP_STATUS})"
fi

echo ""
echo "--- [2] 系统信息 ---"
SYSINFO=$(curl -sk --connect-timeout 5 "${HARBOR_URL}/systeminfo" 2>/dev/null || echo "{}")
if [ "$SYSINFO" != "{}" ]; then
  HARBOR_VERSION=$(echo "$SYSINFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('harbor_version','unknown'))" 2>/dev/null || echo "unknown")
  STORAGE=$(echo "$SYSINFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('storage','unknown'))" 2>/dev/null || echo "unknown")
  echo "  版本: ${HARBOR_VERSION}"
  echo "  存储: ${STORAGE}"
else
  echo "  ⚠️ 无法获取系统信息（可能需要认证）"
fi

if [ "$CHECK_PROJECTS" = "true" ]; then
  echo ""
  echo "--- [3] 项目统计 ---"
  if [ -n "${HARBOR_TOKEN:-}" ]; then
    PROJECTS=$(curl -sk -H "Authorization: Bearer ${HARBOR_TOKEN}" --connect-timeout 5 "${HARBOR_URL}/projects?pageSize=20" 2>/dev/null || echo "[]")
    PROJECT_COUNT=$(echo "$PROJECTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "  项目数量: ${PROJECT_COUNT}"
  else
    echo "  ⚠️ 未设置 HARBOR_TOKEN，跳过项目检查"
  fi
fi

echo ""
echo "--- 巡检完成 ---"
echo "提示: 设置 HARBOR_TOKEN 环境变量可获取更详细的巡检数据"
HARBORSH
chmod +x "${INSTALL_DIR}/skills/harbor-check/scripts/run.sh"

# --- Skill: system-info ---
cat > "${INSTALL_DIR}/skills/system-info/skill.yaml" << 'SYSINFOYAML'
name: system-info
version: "1.0"
description: "系统信息采集 - 收集 CPU/内存/磁盘/进程状态"
schedule: "*/30 * * * *"
executor: bash
entry: scripts/run.sh
timeout: 15000
parameters:
  check_disk:
    type: boolean
    description: "是否检查磁盘使用详情"
    default: true
  disk_threshold:
    type: number
    description: "磁盘告警阈值(%)"
    default: 80
SYSINFOYAML

cat > "${INSTALL_DIR}/skills/system-info/SKILL.md" << 'SYSINFOMD'
# 系统信息 Skill

收集当前运行环境的系统信息，用于运维监控和故障排查。

## 触发条件
- 定时触发（每 30 分钟）
- 手动请求系统信息时触发

## 执行步骤
1. 收集 CPU、内存、磁盘信息
2. 检查关键进程状态
3. 输出系统摘要

## 输出格式
结构化系统报告
SYSINFOMD

cat > "${INSTALL_DIR}/skills/system-info/scripts/run.sh" << 'SYSINFOSH'
#!/usr/bin/env bash
set -euo pipefail

ARGS="${SKILL_ARGS:-{}}"
CHECK_DISK=$(echo "$ARGS" | python3 -c "import sys,json; print(str(json.load(sys.stdin).get('check_disk',True)).lower())" 2>/dev/null || echo "true")
DISK_THRESHOLD=$(echo "$ARGS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('disk_threshold',80))" 2>/dev/null || echo "80")

echo "========================================="
echo "  系统信息报告"
echo "========================================="
echo ""
echo "采集时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "主机名  : $(hostname)"
echo ""

echo "--- CPU ---"
echo "  核心数 : $(nproc)"
CPU_LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}' || echo "N/A")
echo "  负载   : ${CPU_LOAD}"
echo ""

echo "--- 内存 ---"
MEM_INFO=$(free -h | awk '/^Mem:/{print $2, $3, $4, $5}')
MEM_TOTAL=$(echo "$MEM_INFO" | awk '{print $1}')
MEM_USED=$(echo "$MEM_INFO" | awk '{print $2}')
MEM_AVAIL=$(echo "$MEM_INFO" | awk '{print $3}')
MEM_PCT=$(free | awk '/^Mem:/{printf "%.1f", $3/$2*100}')
MEM_STATUS="✅"
if (( $(echo "$MEM_PCT > 80" | bc -l 2>/dev/null || echo "0") )); then
  MEM_STATUS="⚠️"
fi
echo "  总量   : ${MEM_TOTAL}"
echo "  已用   : ${MEM_USED} (${MEM_PCT}%) ${MEM_STATUS}"
echo "  可用   : ${MEM_AVAIL}"
echo ""

if [ "$CHECK_DISK" = "true" ]; then
  echo "--- 磁盘 ---"
  df -h --output=target,size,used,avail,pcent -x tmpfs -x devtmpfs 2>/dev/null | while read -r line; do
    PCT=$(echo "$line" | awk '{print $NF}' | tr -d '%')
    if [ "$PCT" -ge "$DISK_THRESHOLD" ] 2>/dev/null; then
      echo "  ⚠️ $line"
    else
      echo "  ✅ $line"
    fi
  done
  echo ""
fi

echo "--- 关键进程 ---"
PROCS="docker containerd sshd systemd"
for proc in $PROCS; do
  if pgrep -x "$proc" > /dev/null 2>&1; then
    echo "  ✅ ${proc} - 运行中"
  else
    echo "  ❌ ${proc} - 未运行"
  fi
done

echo ""
echo "--- 报告完成 ---"
SYSINFOSH
chmod +x "${INSTALL_DIR}/skills/system-info/scripts/run.sh"

# --- systemd service ---
cat > "${INSTALL_DIR}/deploy/skill-agent.service" << 'SERVICE'
[Unit]
Description=Skill Agent - 智能运维 Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/skill-agent
EnvironmentFile=/opt/skill-agent/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/skill-agent/data /opt/skill-agent/skills

[Install]
WantedBy=multi-user.target
SERVICE

echo "  ✅ 项目文件写入完成"

# 3. 安装依赖
echo ""
echo "[3/5] 安装 npm 依赖 (需要外网访问)..."
cd "${INSTALL_DIR}"
npm install 2>&1 | tail -3
echo "  ✅ 依赖安装完成"

# 4. 配置环境变量
echo ""
echo "[4/5] 配置环境变量..."
if [ ! -f "${INSTALL_DIR}/.env" ]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  echo "  ⚠️ 已创建 .env 文件，请编辑填入 COPILOT_GITHUB_TOKEN:"
  echo "     vi ${INSTALL_DIR}/.env"
else
  echo "  ✅ .env 已存在"
fi

# 5. 验证
echo ""
echo "[5/5] 验证 Skills 加载..."
cd "${INSTALL_DIR}"
npx tsx src/index.ts --list
echo ""
echo "========================================="
echo "  安装完成！"
echo "========================================="
echo ""
echo "下一步:"
echo "  1. 编辑 .env 填入 GitHub Copilot Token:"
echo "     vi ${INSTALL_DIR}/.env"
echo ""
echo "  2. 交互式运行:"
echo "     cd ${INSTALL_DIR} && npx tsx src/index.ts"
echo ""
echo "  3. 注册为 systemd 服务 (可选):"
echo "     cp ${INSTALL_DIR}/deploy/skill-agent.service /etc/systemd/system/"
echo "     systemctl daemon-reload"
echo "     systemctl enable --now skill-agent"
echo ""
echo "  4. 查看日志:"
echo "     journalctl -u skill-agent -f"
