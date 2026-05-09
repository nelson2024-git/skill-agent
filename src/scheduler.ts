/**
 * Scheduler - 基于 node-cron 的定时调度器
 * 
 * 支持标准 cron 表达式，动态增删任务
 */

import cron from "node-cron";

export interface ScheduledJob {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  task: cron.ScheduledTask | null;
  running: boolean;
}

export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();

  /** 添加定时任务 */
  addJob(name: string, schedule: string, handler: () => Promise<void>): void {
    if (!cron.validate(schedule)) {
      console.error(`[Scheduler] 无效的 cron 表达式: ${schedule} (${name})`);
      return;
    }

    if (this.jobs.has(name)) {
      console.warn(`[Scheduler] 任务 "${name}" 已存在，将被覆盖`);
      this.removeJob(name);
    }

    this.jobs.set(name, {
      name,
      schedule,
      handler,
      task: null,
      running: false,
    });
  }

  /** 移除定时任务 */
  removeJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (!job) return false;

    if (job.task) {
      job.task.stop();
    }
    this.jobs.delete(name);
    return true;
  }

  /** 启动所有定时任务 */
  start(): void {
    for (const [name, job] of this.jobs) {
      if (job.task) continue; // 已启动

      const task = cron.schedule(job.schedule, async () => {
        if (job.running) {
          console.warn(`[Scheduler] 任务 "${name}" 仍在运行中，跳过本次触发`);
          return;
        }

        job.running = true;
        try {
          await job.handler();
        } catch (err) {
          console.error(`[Scheduler] 任务 "${name}" 执行失败:`, err);
        } finally {
          job.running = false;
        }
      }, {
        scheduled: true,
        timezone: "Asia/Shanghai",
      });

      job.task = task;
    }
  }

  /** 停止所有定时任务 */
  stop(): void {
    for (const [, job] of this.jobs) {
      if (job.task) {
        job.task.stop();
        job.task = null;
      }
    }
  }

  /** 列出所有任务 */
  listJobs(): Array<{ name: string; schedule: string; running: boolean }> {
    return Array.from(this.jobs.values()).map(job => ({
      name: job.name,
      schedule: job.schedule,
      running: job.running,
    }));
  }
}
