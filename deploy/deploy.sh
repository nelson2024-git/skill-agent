#!/usr/bin/env bash
# ============================================================
# Skill Agent 一键部署脚本
# 用法: sudo bash deploy.sh
# ============================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/skill-agent}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================="
echo "  Skill Agent 部署脚本"
echo "========================================="
echo ""

# 1. 检查 Node.js
echo "[1/6] 检查 Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  echo "  ✅ Node.js ${NODE_VER}"
else
  echo "  ❌ Node.js 未安装"
  echo ""
  echo "请先安装 Node.js 22+:"
  echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs"
  echo "  RHEL/CentOS:   curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo yum install -y nodejs"
  echo "  通用(nvm):     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash && nvm install 22"
  exit 1
fi

# 2. 复制项目
echo ""
echo "[2/6] 复制项目到 ${INSTALL_DIR}..."
if [ "$SCRIPT_DIR" = "$INSTALL_DIR" ]; then
  echo "  已在目标目录，跳过复制"
else
  mkdir -p "$INSTALL_DIR"
  cp -r "$SCRIPT_DIR"/* "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR"/.env.example "$INSTALL_DIR/" 2>/dev/null || true
  echo "  ✅ 已复制"
fi

# 3. 安装依赖
echo ""
echo "[3/6] 安装依赖..."
cd "$INSTALL_DIR"
if command -v pnpm &>/dev/null; then
  pnpm install --production
elif command -v npm &>/dev/null; then
  npm install --production
else
  echo "  ❌ npm/pnpm 均不可用"
  exit 1
fi
echo "  ✅ 依赖安装完成"

# 4. 配置环境变量
echo ""
echo "[4/6] 配置环境变量..."
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  echo "  ⚠️ 已创建 .env 文件，请编辑填入 COPILOT_GITHUB_TOKEN:"
  echo "     vi $INSTALL_DIR/.env"
  echo ""
  echo "  获取 Token 方式:"
  echo "     方式1: gh auth token"
  echo "     方式2: https://github.com/settings/tokens → Generate new token → copilot scope"
else
  echo "  ✅ .env 已存在"
fi

# 5. 验证 Skills 加载
echo ""
echo "[5/6] 验证 Skills 加载..."
npx tsx src/index.ts --list
echo "  ✅ Skills 加载正常"

# 6. 注册 systemd 服务
echo ""
echo "[6/6] 注册 systemd 服务..."
if [ -f "$INSTALL_DIR/deploy/skill-agent.service" ]; then
  cp "$INSTALL_DIR/deploy/skill-agent.service" /etc/systemd/system/skill-agent.service
  systemctl daemon-reload
  systemctl enable skill-agent
  echo "  ✅ 服务已注册"
  echo ""
  echo "========================================="
  echo "  部署完成！"
  echo "========================================="
  echo ""
  echo "下一步:"
  echo "  1. 编辑 .env 填入 Token:"
  echo "     vi $INSTALL_DIR/.env"
  echo ""
  echo "  2. 启动服务:"
  echo "     systemctl start skill-agent"
  echo ""
  echo "  3. 查看日志:"
  echo "     journalctl -u skill-agent -f"
  echo ""
  echo "  4. 停止服务:"
  echo "     systemctl stop skill-agent"
else
  echo "  ⚠️ 未找到 service 文件，跳过 systemd 注册"
  echo ""
  echo "  手动启动: cd $INSTALL_DIR && npx tsx src/index.ts"
fi
