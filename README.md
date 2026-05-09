# Skill Agent

基于 **pi** + **GitHub Copilot** 的智能运维 Agent，遵循 [agentskills.io](https://agentskills.io) 规范，支持 Skill 加载、定时调度与渐进式上下文加载。

## 架构

```
┌─────────────────────────────────────────────────┐
│              Skill Agent (主程序)                 │
├───────────────┬─────────────────────────────────┤
│   Scheduler   │       pi-agent-core             │
│  (node-cron)  │       Agent Runtime             │
│               │  ┌───────────────────────────┐  │
│  ┌─────────┐  │  │  Tool Registry            │  │
│  │  9:00   │──┼─►│  ┌────────┐ ┌──────────┐ │  │
│  │ Harbor  │  │  │  │Skill A │ │Skill B   │ │  │
│  ├─────────┤  │  │  └───┬────┘ └────┬─────┘ │  │
│  │  */30   │──┼─►│  ┌───▼──────────▼─────┐ │  │
│  │ Info    │  │  │  │  scripts/run.sh/.py │ │  │
│  └─────────┘  │  │  │  references/*.md    │ │  │
│               │  │  │  assets/*           │ │  │
│               │  │  └────────────────────┘ │  │
│               │  └───────────────────────────┘  │
├───────────────┴─────────────────────────────────┤
│  pi-ai (GitHub Copilot)                         │
│  26 个模型: claude-opus-4.7, gpt-5.5, ...      │
└─────────────────────────────────────────────────┘
```

## 快速部署

### 方式一：一行命令安装（推荐）

服务器需能访问 github.com 和 registry.npmjs.org：

```bash
curl -sL -H "Authorization: token <你的GitHubToken>" \
  https://raw.githubusercontent.com/nelson2024-git/skill-agent/main/setup-skill-agent.sh \
  | bash
```

默认安装到 `/opt/skill-agent`，可指定目录：

```bash
bash setup-skill-agent.sh /data/skill-agent
```

### 方式二：git clone

```bash
git clone https://github.com/nelson2024-git/skill-agent.git
cd skill-agent
npm install
cp .env.example .env
vi .env    # 填入 COPILOT_GITHUB_TOKEN
npx tsx src/index.ts --list   # 验证 Skill 加载
```

## 环境配置

### 必填：GitHub Copilot Token

| 环境变量 | 优先级 | 说明 |
|----------|--------|------|
| `COPILOT_GITHUB_TOKEN` | 最高 | Copilot 专用 token |
| `GH_TOKEN` | 中 | GitHub CLI token |
| `GITHUB_TOKEN` | 最低 | GitHub PAT (需 `copilot` scope) |

**获取方式（任选其一）**：

1. **VS Code Copilot**：`Ctrl+Shift+P` → `Copilot: Show Copilot Token`
2. **GitHub Settings**：https://github.com/settings/tokens → Generate new token (classic) → 勾选 `copilot`
3. **GitHub CLI**：`gh auth login` → `gh auth token`

写入 `.env`：

```bash
COPILOT_GITHUB_TOKEN=gho_xxxxxxxxxxxx
```

### 可选配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `SKILL_AGENT_PROVIDER` | `github-copilot` | LLM 提供商 |
| `SKILL_AGENT_MODEL` | `gpt-4.1` | 模型 ID |
| `SKILL_AGENT_THINKING` | `low` | 思考级别：off/minimal/low/medium/high |
| `SKILL_AGENT_SKILLS_DIR` | `./skills` | Skills 目录路径 |
| `HARBOR_TOKEN` | — | Harbor API Token（harbor-check 使用） |
| `HTTPS_PROXY` | — | 代理地址 |

## 运行

```bash
cd /opt/skill-agent

# 交互式 REPL
npx tsx src/index.ts

# 列出所有 Skills
npx tsx src/index.ts --list

# 列出 GitHub Copilot 可用模型
npx tsx src/index.ts --list-models

# 运行指定 Skill
npx tsx src/index.ts --run harbor-check

# 使用指定模型
npx tsx src/index.ts --model claude-sonnet-4.5
```

### REPL 命令

| 命令 | 说明 |
|------|------|
| `/skills` | 列出所有已加载的 Skill |
| `/schedule` | 列出定时任务状态 |
| `/run <skill-name>` | 运行指定 Skill |
| 直接输入 | 发送给 LLM 处理 |

## systemd 服务（生产部署）

```bash
# 注册服务
cp deploy/skill-agent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now skill-agent

# 管理
systemctl start skill-agent
systemctl stop skill-agent
systemctl status skill-agent

# 查看日志
journalctl -u skill-agent -f
```

> service 文件默认 `WorkingDirectory=/opt/skill-agent`，如安装到其他路径需修改。

## Skill 规范（agentskills.io）

遵循 [agentskills.io](https://agentskills.io/specification) 开放标准。每个 Skill 是 `skills/` 下的一个目录，**最少只需一个 `SKILL.md`**。

### 目录结构

```
skills/<skill-name>/
├── SKILL.md            # 必需：YAML frontmatter (元数据) + Markdown (技能指令)
├── scripts/            # 可选：可执行脚本
│   ├── run.sh          #   Bash 入口
│   └── run.py          #   Python 入口
├── references/         # 可选：附加参考文档（Agent 按需加载）
│   ├── REFERENCE.md    #   详细技术参考
│   └── api-spec.md     #   API 规范等
└── assets/             # 可选：模板、数据等静态资源
    ├── config.tpl      #   配置模板
    └── schema.json     #   数据结构
```

### SKILL.md 格式

```markdown
---
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
---

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
```

### Frontmatter 字段

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | ✅ | Skill 标识，小写字母+数字+连字符，需与目录名一致 |
| `description` | ✅ | 描述功能和使用场景，帮助 Agent 判断何时激活 |
| `version` | ❌ | 版本号 |
| `schedule` | ❌ | cron 表达式，如 `"0 9 * * 1-5"` = 工作日 9:00 |
| `executor` | ❌ | 脚本执行器：`bash`（默认）或 `python3` |
| `entry` | ❌ | 入口脚本路径，默认 `scripts/run.sh` 或 `scripts/run.py` |
| `timeout` | ❌ | 超时时间(ms)，默认 60000 |
| `parameters` | ❌ | 参数定义，每个参数含 type/description/default/required |
| `env` | ❌ | 注入脚本的环境变量 |

### 渐进式加载（Progressive Disclosure）

| 层级 | 加载内容 | Token 量 | 时机 |
|------|---------|---------|------|
| L1 | `name` + `description` | ~100 | 启动时加载所有 Skill 元数据 |
| L2 | `SKILL.md` 正文 | <5000 | Skill 被 Agent 激活时加载 |
| L3 | `scripts/` + `references/` + `assets/` | 按需 | 执行时按需读取 |

### 脚本编写约定

| 环境变量 | 说明 |
|----------|------|
| `SKILL_ARGS` | 参数 JSON，如 `{"harbor_url":"https://...","check_projects":false}` |
| `SKILL_DIR` | Skill 目录绝对路径 |
| `SKILL_NAME` | Skill 名称 |
| `env` 中定义的 | 自定义环境变量，如 `HARBOR_URL` |

**Bash 示例**：

```bash
#!/usr/bin/env bash
set -euo pipefail

ARGS="${SKILL_ARGS:-{}}"
MY_PARAM=$(echo "$ARGS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('my_param',''))")

echo "Skill: ${SKILL_NAME}, Dir: ${SKILL_DIR}"
echo "参数值: ${MY_PARAM}"
```

**Python 示例**：

```python
#!/usr/bin/env python3
import os, json

args = json.loads(os.environ.get('SKILL_ARGS', '{}'))
skill_dir = os.environ.get('SKILL_DIR', '')
skill_name = os.environ.get('SKILL_NAME', '')

# 读取 references
ref_path = os.path.join(skill_dir, 'references', 'REFERENCE.md')
if os.path.exists(ref_path):
    with open(ref_path) as f:
        reference = f.read()

# 读取 assets
asset_path = os.path.join(skill_dir, 'assets', 'schema.json')
if os.path.exists(asset_path):
    with open(asset_path) as f:
        schema = json.load(f)

print(f"Skill: {skill_name}, 参数: {args}")
```

## 已内置的 Skills

| Skill | 描述 | 定时 | 脚本 |
|-------|------|------|------|
| `hello` | Agent 健康检查，输出系统信息 | 手动 | bash |
| `harbor-check` | Harbor V1.8 仓库巡检 | 工作日 9:00 | bash |
| `system-info` | CPU/内存/磁盘/进程采集 | 每 30 分钟 | bash |

## 可用模型（GitHub Copilot）

| 模型 | Context Window | Max Output |
|------|---------------|------------|
| claude-opus-4.7 | 144K | 64K |
| claude-sonnet-4.6 | 1M | 32K |
| claude-sonnet-4.5 | 200K | 16K |
| gpt-5.5 | 400K | 128K |
| gpt-5.1-codex-max | 400K | 128K |
| gpt-4.1 | 1M | 32K |
| gemini-3.1-pro-preview | 128K | 64K |
| ... | 共 26 个模型 | |

运行 `npx tsx src/index.ts --list-models` 查看完整列表。

## 新增 Skill

1. 创建目录：`mkdir -p skills/my-skill/scripts`
2. 编写 `skills/my-skill/SKILL.md`（frontmatter + 指令）
3. 编写 `skills/my-skill/scripts/run.sh`（或 `run.py`）
4. 重启 Agent，自动加载

## 项目结构

```
skill-agent/
├── src/
│   ├── index.ts              # 主入口 + Agent + CLI
│   ├── skill-loader.ts       # Skill 加载器（frontmatter 解析）
│   └── scheduler.ts          # 定时调度器（node-cron）
├── skills/                   # Skill 目录
│   ├── hello/
│   ├── harbor-check/
│   └── system-info/
├── deploy/
│   ├── skill-agent.service   # systemd 服务文件
│   └── deploy.sh             # 一键部署脚本
├── setup-skill-agent.sh      # 一键安装脚本（独立运行）
├── .env.example              # 环境变量模板
├── package.json
└── tsconfig.json
```

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| Agent Runtime | [pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core) | OpenClaw 底层 Agent 框架 |
| LLM API | [pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai) | 统一 LLM 接口，支持 GitHub Copilot |
| 定时调度 | [node-cron](https://www.npmjs.com/package/node-cron) | 标准 cron 表达式 |
| Skill 规范 | [agentskills.io](https://agentskills.io) | 开放 Skill 格式标准 |
| 运行时 | Node.js 22+ / TypeScript | ESM 模式 |
