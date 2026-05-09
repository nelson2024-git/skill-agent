/**
 * Skill Agent CLI 客户端 — 连接后台 Agent 进程交互
 *
 * 用法: npx tsx src/cli.ts [http://localhost:38080]
 *
 * 前提: 后台 Agent 已启动 (npx tsx src/index.ts --serve)
 */

import { createInterface } from "readline";

const BASE_URL = process.argv[2] || `http://localhost:${process.env.SKILL_AGENT_PORT || 38080}`;

// ============================================================
// API 调用
// ============================================================

async function apiGet(path: string): Promise<any> {
  const resp = await fetch(`${BASE_URL}${path}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ============================================================
// 命令处理
// ============================================================

async function cmdStatus(): Promise<string> {
  const data = await apiGet("/");
  const lines = [`🟢 运行中`];
  if (data.skills?.length) {
    lines.push(`Skills: ${data.skills.length} 个`);
    data.skills.forEach((s: any) => {
      lines.push(`  ${s.name} - ${s.description}${s.schedule ? ` [${s.schedule}]` : ""}`);
    });
  }
  if (data.schedules?.length) {
    lines.push(`定时任务: ${data.schedules.length} 个`);
    data.schedules.forEach((s: any) => {
      lines.push(`  ${s.name}: ${s.schedule}`);
    });
  }
  return lines.join("\n");
}

async function cmdSkills(): Promise<string> {
  const data = await apiGet("/skills");
  if (!data.length) return "暂无 Skill";
  return data.map((s: any) =>
    `${s.name} - ${s.description}${s.schedule ? ` [定时: ${s.schedule}]` : ""}`
  ).join("\n");
}

async function cmdChat(message: string): Promise<string> {
  const data = await apiPost("/chat", { message });
  return data.reply || data.error || "(无回复)";
}

async function cmdRun(skillName: string): Promise<string> {
  const data = await apiPost("/run", { skill: skillName });
  return data.reply || data.error || "(无结果)";
}

// ============================================================
// REPL
// ============================================================

async function main() {
  // 检查后台进程
  try {
    await apiGet("/");
  } catch {
    console.error(`❌ 无法连接后台 Agent: ${BASE_URL}`);
    console.error("   请先启动: npx tsx src/index.ts --serve");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n=== Skill Agent CLI ===`);
  console.log(`连接: ${BASE_URL}`);
  console.log(`输入问题或命令，Ctrl+C 退出\n`);
  console.log(`命令:`);
  console.log(`  /status   - 后台状态`);
  console.log(`  /skills   - 列出 Skills`);
  console.log(`  /run <name> - 运行 Skill`);
  console.log(``);

  const ask = (): void => {
    rl.question("你> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { ask(); return; }

      try {
        let output: string;

        if (trimmed === "/status") {
          output = await cmdStatus();
        } else if (trimmed === "/skills") {
          output = await cmdSkills();
        } else if (trimmed.startsWith("/run ")) {
          const skillName = trimmed.substring(5).trim();
          if (!skillName) { output = "用法: /run <skill-name>"; }
          else { output = await cmdRun(skillName); }
        } else if (trimmed === "/help") {
          output = `/status  - 后台状态\n/skills  - 列出 Skills\n/run <name> - 运行 Skill\n/help    - 显示帮助`;
        } else {
          output = await cmdChat(trimmed);
        }

        console.log(`\n${output}\n`);
      } catch (err) {
        console.error(`\n❌ ${err instanceof Error ? err.message : err}\n`);
      }

      ask();
    });
  };

  ask();

  rl.on("close", () => {
    console.log("\n👋 已断开（后台 Agent 继续运行）");
    process.exit(0);
  });
}

main().catch(console.error);
