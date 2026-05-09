/**
 * Skill Loader - 扫描 skills/ 目录，解析 SKILL.md + skill.yaml，注册为 pi AgentTool
 * 
 * Skill 目录规范:
 *   skills/<skill-name>/
 *   ├── SKILL.md        # agentskills.io 标准格式的技能描述
 *   ├── skill.yaml      # 元数据：参数定义、调度规则、配置
 *   └── scripts/
 *       ├── run.sh      # Shell 脚本入口（可选）
 *       └── run.py      # Python 脚本入口（可选）
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { load as loadYaml } from "js-yaml";
import { execFile } from "child_process";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// ============================================================
// 类型定义
// ============================================================
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
  /** cron 表达式，如 "0 9 * * 1-5" = 工作日 9:00 */
  schedule?: string;
  /** 脚本执行器: bash | python3 */
  executor?: "bash" | "python3";
  /** 入口脚本路径（相对于 skill 目录），默认 scripts/run.sh */
  entry?: string;
  /** 超时时间(ms) */
  timeout?: number;
  /** 参数定义 */
  parameters?: Record<string, SkillParameter>;
  /** 环境变量 */
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

// ============================================================
// Skill 加载
// ============================================================

/** 解析 SKILL.md 文件 */
function parseSkillMd(filePath: string): string {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf-8");
}

/** 解析 skill.yaml 文件 */
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

/** 构建 TypeBox 参数 Schema */
function buildParametersSchema(params: Record<string, SkillParameter> | undefined) {
  if (!params || Object.keys(params).length === 0) {
    return Type.Object({});
  }

  const properties: Record<string, ReturnType<typeof Type.String | typeof Type.Number | typeof Type.Boolean>> = {};
  const required: string[] = [];

  for (const [key, param] of Object.entries(params)) {
    const opts: Record<string, unknown> = {};
    if (param.description) opts.description = param.description;
    if (param.default !== undefined) opts.default = param.default;
    if (param.enum) opts.enum = param.enum;

    switch (param.type) {
      case "number":
        properties[key] = Type.Number(opts);
        break;
      case "boolean":
        properties[key] = Type.Boolean(opts);
        break;
      default:
        properties[key] = Type.String(opts);
    }

    if (param.required) required.push(key);
  }

  return Type.Object(properties, { required });
}

/** 执行 Skill 脚本 */
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

    // 检查脚本是否存在
    if (!existsSync(scriptPath)) {
      reject(new Error(`脚本不存在: ${scriptPath}`));
      return;
    }

    // 构建参数（作为 JSON 字符串传入环境变量 SKILL_ARGS）
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SKILL_ARGS: JSON.stringify(params),
      SKILL_DIR: skillDir,
      SKILL_NAME: skillYaml.name,
    };

    // 追加 skill.yaml 中定义的环境变量
    if (skillYaml.env) {
      Object.entries(skillYaml.env).forEach(([k, v]) => {
        env[k] = v;
      });
    }

    const timeout = skillYaml.timeout || 60000;

    const child = execFile(
      executor,
      [scriptPath],
      { env, timeout, signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stderr) {
          reject(error);
          return;
        }
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: error ? (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? -1 : 1 : 0,
        });
      }
    );

    // 处理 abort signal
    signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
    });
  });
}

/** 创建 pi AgentTool */
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

/** 扫描并加载所有 Skills */
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

    // 尝试解析 skill.yaml
    const yamlPath = join(skillPath, "skill.yaml");
    const skillYaml = parseSkillYaml(yamlPath);

    if (!skillYaml) {
      console.warn(`[SkillLoader] 跳过 ${entry}: 缺少 skill.yaml`);
      continue;
    }

    // 解析 SKILL.md（可选）
    const mdPath = join(skillPath, "SKILL.md");
    const skillMd = parseSkillMd(mdPath);

    // 创建 Tool
    const tool = createSkillTool(skillPath, skillYaml, skillMd);

    skills.push({
      name: skillYaml.name,
      description: skillYaml.description,
      schedule: skillYaml.schedule,
      parameters: skillYaml.parameters,
      skillYaml,
      skillMd,
      dir: skillPath,
      tool,
    });
  }

  return skills;
}
