# Skill Agent

基于 **pi-agent-core** + **GitHub Copilot** 的智能运维 Agent，支持 Skill 加载与定时调度。

## 架构

```
┌──────────────────────────────────────────────┐
│           Skill Agent (主程序)                │
├──────────────┬───────────────────────────────┤
│  Scheduler   │     pi-agent-core             │
│  (node-cron) │     Agent Runtime             │
│              │  ┌────────────────────────┐   │
│  ┌────────┐  │  │  Tool Registry         │   │
│  │ 9:00   │──┼─►│  ┌──────┐ ┌─────────┐ │   │
│  │ Harbor │  │  │  │Skill │ │Skill    │ │   │
│  ├────────┤  │  │  │ A    │ │ B       │ │   │
│  │ */30   │──┼─►│  └──┬───┘ └────┬────┘ │   │
│  │ Info   │  │  │  ┌──▼──────────▼──┐   │   │
│  └────────┘  │  │  │  scripts/      │   │   │
│              │  │  │  run.sh / .py  │   │   │
│              │  │  └───────────────┘   │   │
│              │  └────────────────────────┘   │
├──────────────┴───────────────────────────────┤
│  pi-ai (GitHub Copilot)                      │
│  26 个模型: Claude Opus 4.7, GPT-5.5, ...   │
└──────────────────────────────────────────────┘
```

## 快速开始

### 1. 设置 GitHub Copilot Token

```bash
# 方式 1: 环境变量（服务器推荐）
export COPILOT_GITHUB_TOKEN="gho_xxxx"

# 方式 2: GitHub CLI token
export GH_TOKEN="$(gh auth token)"
```

> 获取 Token: `gh auth login` → 浏览器授权 → `gh auth token`

### 2. 运行

```bash
# 交互式 REPL
pnpm dev

# 列出 Skills
pnpm dev -- --list

# 列出可用模型
pnpm dev -- --list-models

# 运行指定 Skill
pnpm dev -- --run hello

# 使用指定模型
pnpm dev -- --model claude-sonnet-4.5
```

## Skill 规范

每个 Skill 是 `skills/` 下的一个目录：

```
skills/<skill-name>/
├── SKILL.md        # 技能描述 (agentskills.io 标准)
├── skill.yaml      # 元数据 + 参数 + 调度规则
└── scripts/
    ├── run.sh      # Shell 入口 (默认)
    └── run.py      # Python 入口 (可选)
```

### skill.yaml 格式

```yaml
name: my-skill
version: "1.0"
description: "技能描述"
schedule: "0 9 * * 1-5"     # 可选，cron 表达式
executor: bash               # bash | python3
entry: scripts/run.sh        # 入口脚本
timeout: 30000               # 超时 (ms)
parameters:
  url:
    type: string
    description: "目标 URL"
    default: "https://example.com"
    required: true
env:
  MY_VAR: "value"
```

### 脚本约定

- 参数通过环境变量 `SKILL_ARGS` 传入（JSON 格式）
- 运行目录通过 `SKILL_DIR` 获取
- Skill 名称通过 `SKILL_NAME` 获取
- 自定义环境变量在 `skill.yaml` 的 `env` 中定义

```bash
#!/usr/bin/env bash
ARGS="${SKILL_ARGS:-{}}"
MY_PARAM=$(echo "$ARGS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))")
```

## 已内置的 Skills

| Skill | 描述 | 定时 |
|-------|------|------|
| `hello` | Agent 健康检查 | 手动 |
| `harbor-check` | Harbor V1.8 仓库巡检 | 工作日 9:00 |
| `system-info` | 系统信息采集 | 每 30 分钟 |

## 可用模型 (GitHub Copilot)

| 模型 | Context | Max Output |
|------|---------|------------|
| claude-opus-4.7 | 144K | 64K |
| claude-sonnet-4.6 | 1M | 32K |
| gpt-5.5 | 400K | 128K |
| gpt-5.1-codex-max | 400K | 128K |
| gemini-3.1-pro-preview | 128K | 64K |
| ...共 26 个模型 | | |

## 项目结构

```
skill-agent/
├── src/
│   ├── index.ts          # 主入口 + Agent 逻辑
│   ├── skill-loader.ts   # Skill 加载器
│   └── scheduler.ts      # 定时调度器
├── skills/               # Skill 目录
│   ├── hello/
│   ├── harbor-check/
│   └── system-info/
├── package.json
└── tsconfig.json
```
