#!/usr/bin/env bash
set -euo pipefail

# 从环境变量读取参数
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

# CPU
echo "--- CPU ---"
echo "  核心数 : $(nproc)"
CPU_LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}' || echo "N/A")
echo "  负载   : ${CPU_LOAD}"
echo ""

# 内存
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

# 磁盘
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

# 关键进程
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
