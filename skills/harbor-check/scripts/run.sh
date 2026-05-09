#!/usr/bin/env bash
set -euo pipefail

# 从环境变量读取参数
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

# 1. API 可达性检查
echo "--- [1] API 可达性 ---"
HTTP_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" --connect-timeout 5 "${HARBOR_URL}/systeminfo" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "401" ]; then
  echo "  ✅ Harbor API 可达 (HTTP ${HTTP_STATUS})"
else
  echo "  ❌ Harbor API 不可达 (HTTP ${HTTP_STATUS})"
fi

# 2. 系统信息（无需认证的公开信息）
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

# 3. 项目检查（如果启用且 token 可用）
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
