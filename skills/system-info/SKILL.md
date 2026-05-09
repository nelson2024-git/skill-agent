---
name: system-info
version: "1.0"
description: "系统信息采集 - 收集 CPU/内存/磁盘/进程状态"
schedule: "*/30 * * * *"
executor: bash
entry: scripts/run.sh
timeout: 15000
parameters:
  check_disk:
    type: boolean
    description: "是否检查磁盘使用详情"
    default: true
  disk_threshold:
    type: number
    description: "磁盘告警阈值(%)"
    default: 80
---

# 系统信息 Skill

收集当前运行环境的系统信息，用于运维监控和故障排查。

## 触发条件
- 定时触发（每 30 分钟）
- 手动请求系统信息时触发

## 执行步骤
1. 收集 CPU、内存、磁盘信息
2. 检查关键进程状态
3. 输出系统摘要

## 输出格式
结构化系统报告
