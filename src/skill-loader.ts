/**
 * Skill Loader - 扫描 skills/ 目录，解析 SKILL.md（frontmatter + 正文），注册为 pi AgentTool
 *
 * 符合 agentskills.io 规范：一个 SKILL.md 文件搞定所有元数据和描述
 *
 * Skill 目录规范:
 *   skills/<skill-name>/
 *   ├── SKILL.md        # agentskills.io 标准：YAML frontmatter (元数据) + Markdown (技能描述)
 *   └── scripts/
 *       ├── run.sh      # Shell 脚本入口
 *       └── run.py      # Python 脚本入口
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
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

export interface SkillFrontmatter {
  name: string;
  version?: string;
  description?: string;
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
  frontmatter: SkillFrontmatter;
  skillMd: string;
  dir: string;
  tool: AgentTool;
}

// ============================================================
// Frontmatter 解析
// ============================================================

/**
 * 解析 SKILL.md 的 YAML frontmatter
 * 格式: ---\n<yaml>\n---\n<markdown>
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];

  // 轻量 YAML 解析（无需 js-yaml 依赖）
  // 支持: 键值对、嵌套缩进、列表、引号字符串
  const frontmatter: Record<string, unknown> = parseYaml(yamlStr);

  return { frontmatter, body };
}

/**
 * 轻量 YAML 解析器 — 覆盖 SKILL.md frontmatter 的常见结构
 * 不依赖 js-yaml，减少一个运行时依赖
 */
function parseYaml(input: string): Record<string, unknown> {
  const lines = input.split("\n");
  return parseYamlLines(lines, 0, lines.length).result;
}

function parseYamlLines(lines: string[], start: number, end: number): { result: Record<string, unknown>; nextLine: number } {
  const result: Record<string, unknown> = {};
  let i = start;

  while (i < end) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trimStart();

    // 键值对: key: value
    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kvMatch) {
      i++;
      continue;
    }

    const key = kvMatch[1];
    const val = kvMatch[2].trim();

    if (val === "" || val === "|" || val === ">") {
      // 值为空 → 可能是嵌套对象或下一行是值
      // 检查下一行的缩进
      const nextLine = i + 1;
      if (nextLine < end) {
        const nextIndent = lines[nextLine].length - lines[nextLine].trimStart().length;
        if (nextIndent > indent) {
          // 嵌套块
          const nested = parseYamlLines(lines, nextLine, end);
          // 判断是对象还是参数字典
          const nestedKeys = Object.keys(nested.result);
          if (nestedKeys.length > 0 && isParameterBlock(nested.result)) {
            result[key] = nested.result;
          } else {
            result[key] = nested.result;
          }
          i = nested.nextLine;
          continue;
        }
      }
      result[key] = "";
      i++;
      continue;
    }

    // 解析值
    result[key] = parseYamlValue(val);
    i++;
  }

  return { result, nextLine: i };
}

/** 判断嵌套块是否是参数字典（包含 type/description/default 等 key） */
function isParameterBlock(obj: Record<string, unknown>): boolean {
  for (const val of Object.values(obj)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return true;
    }
  }
  return false;
}

function parseYamlValue(val: string): unknown {
  // 引号字符串
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }

  // 布尔
  if (val === "true") return true;
  if (val === "false") return false;

  // 数字
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);

  // 列表 [a, b, c]
  if (val.startsWith("[") && val.endsWith("]")) {
    return val.slice(1, -1).split(",").map(s => parseYamlValue(s.trim()));
  }

  return val;
}

// ============================================================
// Skill 加载
// ============================================================

/** 解析 SKILL.md 文件 */
function parseSkillMd(filePath: string): { frontmatter: SkillFrontmatter; body: string } | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    return { frontmatter: frontmatter as unknown as SkillFrontmatter, body };
  } catch (err) {
    console.error(`[SkillLoader] 解析 ${filePath} 失败:`, err);
    return null;
  }
}

/** 构建 TypeBox 参数 Schema */
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

/** 执行 Skill 脚本 */
function executeSkillScript(
  skillDir: string,
  frontmatter: SkillFrontmatter,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const executor = frontmatter.executor || "bash";
    const entry = frontmatter.entry || (executor === "python3" ? "scripts/run.py" : "scripts/run.sh");
    const scriptPath = join(skillDir, entry);

    if (!existsSync(scriptPath)) {
      reject(new Error(`脚本不存在: ${scriptPath}`));
      return;
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SKILL_ARGS: JSON.stringify(params),
      SKILL_DIR: skillDir,
      SKILL_NAME: frontmatter.name,
    };

    if (frontmatter.env) {
      Object.entries(frontmatter.env).forEach(([k, v]) => { env[k] = v; });
    }

    const timeout = frontmatter.timeout || 60000;

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

/** 创建 pi AgentTool */
function createSkillTool(skillDir: string, frontmatter: SkillFrontmatter, skillMdBody: string): AgentTool {
  const parametersSchema = buildParametersSchema(frontmatter.parameters);
  const description = `${frontmatter.description || skillMdBody.split("\n")[0] || frontmatter.name}\n\nSchedule: ${frontmatter.schedule || "手动触发"}\nExecutor: ${frontmatter.executor || "bash"}`;

  return {
    name: frontmatter.name,
    label: frontmatter.name,
    description,
    parameters: parametersSchema,
    execute: async (toolCallId, params, signal, onUpdate) => {
      try {
        onUpdate?.({ type: "progress", message: `正在执行 Skill: ${frontmatter.name}...` });
        const result = await executeSkillScript(skillDir, frontmatter, params as Record<string, unknown>, signal);
        const output = result.stderr
          ? `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
          : result.stdout;
        return {
          content: [{ type: "text" as const, text: output }],
          details: { exitCode: result.exitCode, skill: frontmatter.name },
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Skill 执行失败: ${errorMsg}` }],
          details: { error: true, skill: frontmatter.name },
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

    // 解析 SKILL.md（agentskills.io 标准入口）
    const mdPath = join(skillPath, "SKILL.md");
    const parsed = parseSkillMd(mdPath);

    if (!parsed || !parsed.frontmatter.name) {
      console.warn(`[SkillLoader] 跳过 ${entry}: 缺少 SKILL.md 或 frontmatter 中无 name`);
      continue;
    }

    const { frontmatter, body } = parsed;
    const tool = createSkillTool(skillPath, frontmatter, body);

    skills.push({
      name: frontmatter.name,
      description: frontmatter.description || body.split("\n").find(l => l.trim())?.replace(/^#+\s*/, "") || frontmatter.name,
      schedule: frontmatter.schedule,
      parameters: frontmatter.parameters,
      frontmatter,
      skillMd: body,
      dir: skillPath,
      tool,
    });
  }

  return skills;
}
