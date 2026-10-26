import { randomUUID } from 'node:crypto';
import { getRedisClient, isRedisConnected } from '../services/redis-client.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { env } from '../config/env.ts';
import {
  claimNextJob,
  completeJob,
  failAndRetryJob,
  moveToDeadLetter,
  promoteDelayedJobs,
  recoverStaleJobs,
  renewJobClaim,
  enqueueJob,
  QUEUE_KEYS,
  type JobData,
} from './job-queue.ts';
import {
  CONTROL_PLANE_JOB_WHITELIST,
  handlePushNotification,
  handlePaymentWebhook,
  handlePasswordResetEmail,
  handleInvitationEmail,
  handlePaymentInboxSweeper,
} from './handlers.ts';
import { errorTracker } from '../utils/error-tracker.ts';

export type JobHandler<T = any> = (job: JobData<T>) => Promise<any>;

export interface WorkerOptions {
  pollIntervalMs?: number;
  delayedCheckIntervalMs?: number;
  staleCheckIntervalMs?: number;
  visibilityTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  sweeperIntervalMs?: number;
  enableSweeper?: boolean;
  workerId?: string;
}

export class JobWorker {
  private isRunning = false;
  private handlers = new Map<string, JobHandler>();
  private activeJobs = new Set<string>();
  private activeHeartbeats = new Map<string, NodeJS.Timeout>();
  private pollTimeout: NodeJS.Timeout | null = null;
  private delayedInterval: NodeJS.Timeout | null = null;
  private staleInterval: NodeJS.Timeout | null = null;
  private sweeperInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private delayedCheckIntervalMs: number;
  private staleCheckIntervalMs: number;
  private visibilityTimeoutMs: number;
  private heartbeatIntervalMs: number;
  private sweeperIntervalMs: number;
  private enableSweeper: boolean;
  public readonly workerId: string;

  constructor(options?: WorkerOptions) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 200;
    this.delayedCheckIntervalMs = options?.delayedCheckIntervalMs ?? 500;
    this.staleCheckIntervalMs = options?.staleCheckIntervalMs ?? 2000;
    this.visibilityTimeoutMs = options?.visibilityTimeoutMs ?? env.QUEUE_VISIBILITY_TIMEOUT_MS ?? 30000;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? Math.max(500, Math.floor(this.visibilityTimeoutMs / 3));
    this.sweeperIntervalMs = options?.sweeperIntervalMs ?? env.SWEEPER_INTERVAL_MS ?? 60000;
    this.enableSweeper = options?.enableSweeper ?? false;
    this.workerId = options?.workerId ?? `worker_${process.pid}_${randomUUID().substring(0, 8)}`;
  }

  /**
   * Registers a handler for a given job name.
   */
  public registerHandler<T = any>(name: string, handler: JobHandler<T>): this {
    this.handlers.set(name, handler);
    return this;
  }

  /**
   * Starts the worker polling loop, delayed job promotion, stale claim recovery,
   * and optional payment inbox sweeper scheduler.
   */
  public start(): this {
    if (this.isRunning) {
      return this;
    }
    this.isRunning = true;

    // 1. Periodic delayed jobs promotion
    this.delayedInterval = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        await promoteDelayedJobs();
      } catch (err: any) {
        console.error('[JobWorker] Error in delayed job promotion:', err.message);
      }
    }, this.delayedCheckIntervalMs);

    if (process.env.NODE_ENV === 'test' && this.delayedInterval.unref) {
      this.delayedInterval.unref();
    }

    // 2. Periodic stale claims recovery (crash & abandonment protection)
    this.staleInterval = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        await recoverStaleJobs(this.visibilityTimeoutMs);
      } catch (err: any) {
        console.error('[JobWorker] Error in stale jobs recovery:', err.message);
      }
    }, this.staleCheckIntervalMs);

    if (process.env.NODE_ENV === 'test' && this.staleInterval.unref) {
      this.staleInterval.unref();
    }

    // 3. Periodic payment inbox sweeper with distributed mutual exclusion
    if (this.enableSweeper) {
      this.sweeperInterval = setInterval(async () => {
        if (!this.isRunning) return;
        await this.triggerPaymentInboxSweep();
      }, this.sweeperIntervalMs);

      if (process.env.NODE_ENV === 'test' && this.sweeperInterval.unref) {
        this.sweeperInterval.unref();
      }
    }

    // 4. Begin polling ready jobs
    this.scheduleNextPoll(0);

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[JobWorker] Worker ${this.workerId} started successfully (sweeper=${this.enableSweeper})`);
    }

    return this;
  }

  /**
   * Attempts to acquire a distributed lock to run or enqueue the payment inbox sweeper.
   * Prevents duplicate or overlapping sweeps across multiple worker instances.
   */
  public async triggerPaymentInboxSweep(): Promise<boolean> {
    try {
      const redis = getRedisClient();
      if (!isRedisConnected()) return false;

      // Lock TTL slightly less than interval to allow timely subsequent sweeps
      const lockTtlMs = Math.max(5000, this.sweeperIntervalMs - 1000);
      const lockAcquired = await redis.set(
        QUEUE_KEYS.LOCK_SWEEPER,
        this.workerId,
        'PX',
        lockTtlMs,
        'NX'
      );

      if (lockAcquired === 'OK') {
        await enqueueJob('sweeper.payment_inbox', { thresholdSeconds: 60 });
        return true;
      }
      return false;
    } catch (err: any) {
      console.warn('[JobWorker] Failed to trigger payment inbox sweeper:', err.message);
      return false;
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) return;
    this.pollTimeout = setTimeout(() => {
      this.pollAndProcess();
    }, delayMs);

    if (process.env.NODE_ENV === 'test' && this.pollTimeout.unref) {
      this.pollTimeout.unref();
    }
  }

  private async pollAndProcess(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const processed = await this.processNext();
      // If we processed a job, poll immediately for more; otherwise wait pollIntervalMs
      this.scheduleNextPoll(processed ? 0 : this.pollIntervalMs);
    } catch (err: any) {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[JobWorker] Polling loop error:', err.message);
      }
      this.scheduleNextPoll(this.pollIntervalMs);
    }
  }

  /**
   * Claims and processes a single job from the ready queue using atomic ready-to-processing transfer.
   * Returns true if a job was claimed and executed, false if the queue was empty.
   */
  public async processNext(): Promise<boolean> {
    const job = await claimNextJob(this.workerId);
    if (!job) {
      return false;
    }

    await this.executeJob(job);
    return true;
  }

  /**
   * Executes a single claimed job with tenant isolation (SEC-018, AC-TEN-08),
   * exponential backoff retries, dead letter queue routing, and heartbeat claim renewal.
   */
  public async executeJob(job: JobData): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      const error = new Error(`No registered handler for job '${job.name}'`);
      await moveToDeadLetter(job, error, this.workerId);
      return;
    }

    this.activeJobs.add(job.id);

    // Heartbeat timer to periodically renew claim while execution is active
    const heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await renewJobClaim(job.id, this.workerId);
        if (!renewed && process.env.NODE_ENV !== 'test') {
          console.warn(`[JobWorker] Worker ${this.workerId} lost claim for in-flight job ${job.id}`);
        }
      } catch (err: any) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn(`[JobWorker] Error renewing heartbeat for job ${job.id}:`, err.message);
        }
      }
    }, this.heartbeatIntervalMs);

    if (process.env.NODE_ENV === 'test' && (heartbeatTimer as any).unref) {
      (heartbeatTimer as any).unref();
    }
    this.activeHeartbeats.set(job.id, heartbeatTimer);

    const attemptStartTime = Date.now();
    const currentAttempt = job.attempts + 1;

    if (process.env.NODE_ENV !== 'test') {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'job_attempt_start',
          workerId: this.workerId,
          jobId: job.id,
          jobName: job.name,
          attempt: currentAttempt,
          maxAttempts: job.maxAttempts,
          businessId: job.businessId || null,
        })
      );
    }

    try {
      // SEC-018 & AC-TEN-08: Tenant context enforcement
      if (job.businessId) {
        await withTenantContext(job.businessId, async () => {
          await handler(job);
        });
      } else {
        // Enforce whitelist for jobs running without tenant context
        const isControlPlane = CONTROL_PLANE_JOB_WHITELIST.has(job.name) || job.name.startsWith('test.control');
        if (!isControlPlane) {
          throw new Error(
            `AC-TEN-08: Background job '${job.name}' missing required tenant context (businessId)`
          );
        }
        await handler(job);
      }

      // Success: acknowledge and remove from processing queue (with workerId verification)
      const completed = await completeJob(job.id, this.workerId);
      if (!completed && process.env.NODE_ENV !== 'test') {
        console.warn(`[JobWorker] Worker ${this.workerId} could not complete job ${job.id}: claim was lost or superseded`);
      }
      job.status = completed ? 'completed' : 'processing';
      job.error = null;
      job.claimedBy = null;
      job.claimedAt = null;

      if (process.env.NODE_ENV !== 'test') {
        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'job_attempt_success',
            workerId: this.workerId,
            jobId: job.id,
            jobName: job.name,
            attempt: currentAttempt,
            durationMs: Date.now() - attemptStartTime,
            businessId: job.businessId || null,
          })
        );
      }
    } catch (err: any) {
      job.attempts += 1;
      const errorDetails = {
        message: err.message,
        stack: err.stack,
        code: err.code || err.statusCode,
        failedAt: new Date().toISOString(),
      };
      job.error = errorDetails;

      errorTracker.captureException(err, {
        businessId: job.businessId || null,
        tags: {
          workerId: this.workerId,
          jobName: job.name,
          jobId: job.id,
        },
        extra: {
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
        },
      });

      if (job.attempts < job.maxAttempts) {
        // Exponential backoff: backoffMs * 2^(attempts - 1)
        const delay = job.backoffMs * Math.pow(2, job.attempts - 1);
        await failAndRetryJob(job, delay, this.workerId);

        if (process.env.NODE_ENV !== 'test') {
          console.log(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              event: 'job_attempt_retry',
              workerId: this.workerId,
              jobId: job.id,
              jobName: job.name,
              attempt: job.attempts,
              maxAttempts: job.maxAttempts,
              durationMs: Date.now() - attemptStartTime,
              delayMs: delay,
              error: err.message,
              businessId: job.businessId || null,
            })
          );
        }
      } else {
        // Max attempts exhausted: move to Dead Letter Queue
        await moveToDeadLetter(job, err, this.workerId);

        if (process.env.NODE_ENV !== 'test') {
          console.log(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              event: 'job_attempt_dead_letter',
              workerId: this.workerId,
              jobId: job.id,
              jobName: job.name,
              attempts: job.attempts,
              durationMs: Date.now() - attemptStartTime,
              error: err.message,
              businessId: job.businessId || null,
            })
          );
        }
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.activeHeartbeats.delete(job.id);
      this.activeJobs.delete(job.id);
    }
  }

  /**
   * Gracefully shuts down the worker, waiting for in-flight jobs to complete.
   */
  public async stop(timeoutMs: number = 5000): Promise<void> {
    this.isRunning = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    if (this.delayedInterval) {
      clearInterval(this.delayedInterval);
      this.delayedInterval = null;
    }
    if (this.staleInterval) {
      clearInterval(this.staleInterval);
      this.staleInterval = null;
    }
    if (this.sweeperInterval) {
      clearInterval(this.sweeperInterval);
      this.sweeperInterval = null;
    }

    // Clear all active heartbeats
    for (const timer of this.activeHeartbeats.values()) {
      clearInterval(timer);
    }
    this.activeHeartbeats.clear();

    // Wait for active in-flight jobs to finish
    const startTime = Date.now();
    while (this.activeJobs.size > 0 && Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[JobWorker] Worker ${this.workerId} stopped cleanly`);
    }
  }

  public getStatus(): { isRunning: boolean; activeJobsCount: number; workerId: string } {
    return {
      isRunning: this.isRunning,
      activeJobsCount: this.activeJobs.size,
      workerId: this.workerId,
    };
  }
}

/**
 * Creates and registers a JobWorker configured with all standard Rota handlers.
 */
export function createDefaultWorker(options?: WorkerOptions): JobWorker {
  const worker = new JobWorker(options);

  worker
    .registerHandler('push.notification', handlePushNotification)
    .registerHandler('payment.webhook', handlePaymentWebhook)
    .registerHandler('email.password_reset', handlePasswordResetEmail)
    .registerHandler('email.invitation', handleInvitationEmail)
    .registerHandler('sweeper.payment_inbox', handlePaymentInboxSweeper);

  return worker;
}
