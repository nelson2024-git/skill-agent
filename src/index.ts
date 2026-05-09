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
    // 仅设置未定义的环境变量（不覆盖已有的）
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

    // 2. 获取 LLM 模型
    const model = getModel(this.config.provider, this.config.model);
    console.log(`[SkillAgent] 使用模型: ${model.provider}/${model.id}`);

    // 3. 将 Skills 转为 AgentTool
    const tools = this.skills.map(skill => skill.tool);

    // 4. 创建 Agent
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.config.systemPrompt,
        model,
        tools,
        thinkingLevel: this.config.thinkingLevel,
      },
      streamFn: streamSimple,
    });

    // 5. 订阅事件
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

    // 6. 注册定时任务
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
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        result += event.assistantMessageEvent.delta;
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
  let mode: "repl" | "list" | "run" = "repl";
  let runSkillName = "";

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

  // 检查 Copilot Token
  const token = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("[SkillAgent] ⚠️ 未检测到 GitHub Copilot Token");
    console.warn("  请设置环境变量: COPILOT_GITHUB_TOKEN=gho_xxxx");
    console.warn("  或创建 .env 文件: cp .env.example .env && vi .env");
    console.warn("");
    console.warn("  仅 --list / --list-models 模式可无 Token 运行");
    if (mode !== "list" && mode !== "list-models") {
      process.exit(1);
    }
  } else {
    console.log(`[SkillAgent] GitHub Copilot Token: ${token.substring(0, 8)}...${token.substring(token.length - 4)}`);
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
      // 启动定时调度
      agent.startScheduler();
      // 进入交互模式
      await agent.repl();
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
