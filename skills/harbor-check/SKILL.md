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

## 输出格式
结构化巡检报告，包含状态标识（✅/⚠️/❌）
