#!/usr/bin/env bash
set -euo pipefail

# 从环境变量读取参数
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
