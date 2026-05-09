---
name: hello
version: "1.0"
description: "Agent 健康检查 - 输出系统信息和参数，验证 Skill 运行正常"
executor: bash
entry: scripts/run.sh
timeout: 10000
parameters:
  greeting:
    type: string
    description: "问候语"
    default: "Hello from Skill Agent!"
    required: false
---

# Hello Skill

用于验证 Skill Agent 基础功能的测试技能。

## 触发条件
当用户要求测试 Agent 是否正常工作时触发。

## 执行步骤
1. 输出当前时间
2. 输出系统基本信息
3. 打印传入的参数

## 输出格式
结构化文本，包含时间戳和参数值
