import { randomUUID } from 'node:crypto';
import { getRedisClient, isRedisConnected } from '../services/redis-client.ts';
import { env } from '../config/env.ts';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';

export interface JobError {
  message: string;
  stack?: string;
  code?: string;
  failedAt: string;
}

export interface JobData<T = any> {
  id: string;
  name: string;
  data: T;
  businessId?: string | null;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  status: JobStatus;
  claimedBy?: string | null;
  claimedAt?: number | null;
  error?: JobError | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueOptions {
  businessId?: string | null;
  maxAttempts?: number;
  backoffMs?: number;
  delayMs?: number;
}

export const QUEUE_KEYS = {
  READY: 'rota:queue:ready',
  PROCESSING: 'rota:queue:processing',
  DELAYED: 'rota:queue:delayed',
  DEAD_LETTER: 'rota:queue:dead_letter',
  DLQ_JOBS: 'rota:dlq:jobs',
  JOB_PREFIX: 'rota:job:',
  LOCK_SWEEPER: 'rota:lock:payment_sweeper',
};

/**
 * Serializes a JobData instance for Redis hash storage.
 */
function serializeJob(job: JobData): Record<string, string> {
  return {
    id: job.id,
    name: job.name,
    data: JSON.stringify(job.data),
    businessId: job.businessId || '',
    attempts: String(job.attempts),
    maxAttempts: String(job.maxAttempts),
    backoffMs: String(job.backoffMs),
    status: job.status,
    claimedBy: job.claimedBy || '',
    claimedAt: String(job.claimedAt || 0),
    error: job.error ? JSON.stringify(job.error) : '',
    createdAt: String(job.createdAt),
    updatedAt: String(job.updatedAt),
  };
}

/**
 * Deserializes Redis hash entries into a strongly-typed JobData object.
 */
function deserializeJob(fields: Record<string, string>): JobData | null {
  if (!fields || !fields.id) {
    return null;
  }

  let parsedData: any = {};
  try {
    parsedData = JSON.parse(fields.data);
  } catch {
    parsedData = fields.data;
  }

  let parsedError: JobError | null = null;
  if (fields.error) {
    try {
      parsedError = JSON.parse(fields.error);
    } catch {
      parsedError = { message: fields.error, failedAt: new Date().toISOString() };
    }
  }

  const claimedAtNum = parseInt(fields.claimedAt, 10);

  return {
    id: fields.id,
    name: fields.name,
    data: parsedData,
    businessId: fields.businessId || null,
    attempts: parseInt(fields.attempts, 10) || 0,
    maxAttempts: parseInt(fields.maxAttempts, 10) || 3,
    backoffMs: parseInt(fields.backoffMs, 10) || 1000,
    status: (fields.status as JobStatus) || 'pending',
    claimedBy: fields.claimedBy || null,
    claimedAt: isNaN(claimedAtNum) || claimedAtNum === 0 ? null : claimedAtNum,
    error: parsedError,
    createdAt: parseInt(fields.createdAt, 10) || Date.now(),
    updatedAt: parseInt(fields.updatedAt, 10) || Date.now(),
  };
}

/**
 * Enqueues a new background job into Redis.
 * If delayMs is provided, places the job in the delayed sorted set.
 * Otherwise, immediately pushes the job ID onto the ready queue.
 */
export async function enqueueJob<T = any>(
  name: string,
  data: T,
  options?: EnqueueOptions
): Promise<JobData<T>> {
  const redis = getRedisClient();
  const id = `job_${Date.now()}_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
  const now = Date.now();

  const maxAttempts = options?.maxAttempts ?? 3;
  const backoffMs = options?.backoffMs ?? 1000;
  const businessId = options?.businessId ?? null;
  const delayMs = options?.delayMs ?? 0;

  const job: JobData<T> = {
    id,
    name,
    data,
    businessId,
    attempts: 0,
    maxAttempts,
    backoffMs,
    status: 'pending',
    claimedBy: null,
    claimedAt: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  const serialized = serializeJob(job);
  const jobKey = `${QUEUE_KEYS.JOB_PREFIX}${id}`;

  const pipeline = redis.pipeline();
  pipeline.hset(jobKey, serialized);
  // Keep job metadata for 7 days
  pipeline.expire(jobKey, 86400 * 7);

  if (delayMs > 0) {
    const runAt = now + delayMs;
    pipeline.zadd(QUEUE_KEYS.DELAYED, runAt, id);
  } else {
    pipeline.lpush(QUEUE_KEYS.READY, id);
  }

  await pipeline.exec();

  return job;
}

/**
 * Retrieves a job by ID from Redis.
 */
export async function getJob(jobId: string): Promise<JobData | null> {
  const redis = getRedisClient();
  const jobKey = `${QUEUE_KEYS.JOB_PREFIX}${jobId}`;
  const fields = await redis.hgetall(jobKey);
  if (!fields || Object.keys(fields).length === 0) {
    return null;
  }
  return deserializeJob(fields);
}

/**
 * Updates a job's status and metadata in Redis.
 */
export async function updateJob(job: JobData): Promise<void> {
  const redis = getRedisClient();
  const jobKey = `${QUEUE_KEYS.JOB_PREFIX}${job.id}`;
  job.updatedAt = Date.now();
  await redis.hset(jobKey, serializeJob(job));
}

/**
 * Reliable claim Lua script:
 * Atomically pops a job ID from the ready queue and transfers it to the processing queue (RPOPLPUSH),
 * simultaneously setting claimedBy, claimedAt, status = 'processing' on the job hash.
 */
const CLAIM_JOB_LUA = `
  local readyKey = KEYS[1]
  local processingKey = KEYS[2]
  local jobPrefix = ARGV[1]
  local workerId = ARGV[2]
  local now = ARGV[3]

  local jobId = redis.call('RPOPLPUSH', readyKey, processingKey)
  if not jobId then
    return nil
  end

  local jobKey = jobPrefix .. jobId
  redis.call('HSET', jobKey, 'claimedBy', workerId, 'claimedAt', now, 'status', 'processing', 'updatedAt', now)
  return jobId
`;

/**
 * Atomically claims the next ready job for a specific worker.
 * Returns the JobData if claimed, or null if no ready jobs exist.
 */
export async function claimNextJob(workerId: string): Promise<JobData | null> {
  const redis = getRedisClient();
  const now = Date.now();

  try {
    const jobId = await redis.eval(
      CLAIM_JOB_LUA,
      2,
      QUEUE_KEYS.READY,
      QUEUE_KEYS.PROCESSING,
      QUEUE_KEYS.JOB_PREFIX,
      workerId,
      String(now)
    );

    if (!jobId || typeof jobId !== 'string') {
      return null;
    }

    const job = await getJob(jobId);
    if (!job) {
      // Clean up orphaned entry in processing list
      await redis.lrem(QUEUE_KEYS.PROCESSING, 0, jobId);
      return null;
    }

    return job;
  } catch (err: any) {
    console.error('[JobQueue] Error claiming next job:', err.message);
    return null;
  }
}

/**
 * Heartbeat Lua script:
 * Atomically verifies that the job is currently in 'processing' state and owned by workerId,
 * then updates claimedAt to the current timestamp.
 * Returns 1 if renewed, 0 if the claim was lost or superseded.
 */
const RENEW_CLAIM_LUA = `
  local jobKey = KEYS[1]
  local workerId = ARGV[1]
  local now = ARGV[2]

  local currentOwner = redis.call('HGET', jobKey, 'claimedBy')
  local status = redis.call('HGET', jobKey, 'status')
  if currentOwner == workerId and status == 'processing' then
    redis.call('HSET', jobKey, 'claimedAt', now, 'updatedAt', now)
    return 1
  else
    return 0
  end
`;

export async function renewJobClaim(jobId: string, workerId: string): Promise<boolean> {
  const redis = getRedisClient();
  const now = Date.now();
  const jobKey = `${QUEUE_KEYS.JOB_PREFIX}${jobId}`;

  try {
    const res = await redis.eval(
      RENEW_CLAIM_LUA,
      1,
      jobKey,
      workerId,
      String(now)
    );
    return Number(res) === 1;
  } catch (err: any) {
    console.error('[JobQueue] Error renewing job claim:', err.message);
    return false;
  }
}

/**
 * Atomically acknowledges successful job completion:
 * Enforces workerId ownership check so a stale worker cannot acknowledge or overwrite another worker's claim.
 * Removes the job from the processing queue, marks it 'completed', and clears claim details.
 */
const COMPLETE_JOB_LUA = `
  local processingKey = KEYS[1]
  local jobKey = KEYS[2]
  local jobId = ARGV[1]
  local now = ARGV[2]
  local workerId = ARGV[3] or ''

  local status = redis.call('HGET', jobKey, 'status')
  if status == 'completed' then
    return 1
  end

  if workerId ~= '' then
    local currentOwner = redis.call('HGET', jobKey, 'claimedBy')
    if currentOwner ~= workerId then
      return 0
    end
  end

  redis.call('LREM', processingKey, 0, jobId)
  redis.call('HSET', jobKey, 'status', 'completed', 'claimedBy', '', 'claimedAt', '0', 'updatedAt', now, 'error', '')
  return 1
`;

export async function completeJob(jobId: string, workerId?: string): Promise<boolean> {
  const redis = getRedisClient();
  const now = Date.now();
  const jobKey = `${QUEUE_KEYS.JOB_PREFIX}${jobId}`;

  const res = await redis.eval(
    COMPLETE_JOB_LUA,
    2,
    QUEUE_KEYS.PROCESSING,
    jobKey,
    jobId,
    String(now),
    workerId || ''
  );
  return Number(res) === 1;
}

/**
 * Handles a transient failure: verifies workerId claim ownership, removes from processing,
 * and schedules it in the delayed queue.
 */
const FAIL_RETRY_LUA = `
  local processingKey = KEYS[1]
  local delayedKey = KEYS[2]
  local jobKey = KEYS[3]
  local jobId = ARGV[1]
  local nextRunAt = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local workerId = ARGV[4] or ''
  local attempts = ARGV[5]
  local errorJson = ARGV[6] or ''

  if workerId ~= '' then
    local currentOwner = redis.call('HGET', jobKey, 'claimedBy')
    if currentOwner ~= workerId then
      return 0
    end
  end

  redis.call('LREM', processingKey, 0, jobId)
  redis.call('ZADD', delayedKey, nextRunAt, jobId)
  redis.call('HSET', jobKey, 'status', 'pending', 'attempts', attempts, 'error', errorJson, 'claimedBy', '', 'claimedAt', '0', 'updatedAt', tostring(now))
  return 1
`;

export async function failAndRetryJob(job: JobData, delayMs: number, workerId?: string): Promise<boolean> {
  const redis = getRedisClient();
  const now = Date.now();
  const nextRunAt = now + delayMs;
  const jobKey = `${QUEUE_KEYS.JOB_PREFIX}${job.id}`;
  const errorJson = job.error ? JSON.stringify(job.error) : '';

  job.status = 'pending';
  job.claimedBy = null;
  job.claimedAt = null;
  job.updatedAt = now;

  const res = await redis.eval(
    FAIL_RETRY_LUA,
    3,
    QUEUE_KEYS.PROCESSING,
    QUEUE_KEYS.DELAYED,
    jobKey,
    job.id,
    String(nextRunAt),
    String(now),
    workerId || '',
    String(job.attempts),
    errorJson
  );

  return Number(res) === 1;
}

/**
 * Promotes all delayed jobs whose scheduled run time <= now into the ready queue.
 * Atomic Lua script to prevent duplicate promotion across multiple backend instances.
 */
const PROMOTE_DELAYED_LUA = `
  local delayedKey = KEYS[1]
  local readyKey = KEYS[2]
  local now = tonumber(ARGV[1])
  local limit = tonumber(ARGV[2]) or 50

  local items = redis.call('ZRANGEBYSCORE', delayedKey, 0, now, 'LIMIT', 0, limit)
  if #items == 0 then
    return 0
  end

  for _, id in ipairs(items) do
    redis.call('ZREM', delayedKey, id)
    redis.call('LPUSH', readyKey, id)
  end

  return #items
`;

export async function promoteDelayedJobs(limit: number = 50): Promise<number> {
  const redis = getRedisClient();
  const now = Date.now();
  try {
    const promoted = await redis.eval(
      PROMOTE_DELAYED_LUA,
      2,
      QUEUE_KEYS.DELAYED,
      QUEUE_KEYS.READY,
      now,
      limit
    );
    return Number(promoted) || 0;
  } catch (err: any) {
    console.error('[JobQueue] Error promoting delayed jobs:', err.message);
    return 0;
  }
}

/**
 * Moves an exhausted job to the Dead Letter Queue (DLQ) and removes it from processing.
 * Enforces workerId ownership check if provided.
 */
const MOVE_DLQ_LUA = `
  local processingKey = KEYS[1]
  local dlqKey = KEYS[2]
  local dlqJobsKey = KEYS[3]
  local jobKey = KEYS[4]
  local jobId = ARGV[1]
  local now = tonumber(ARGV[2])
  local workerId = ARGV[3] or ''
  local attempts = ARGV[4]
  local errorJson = ARGV[5]
  local jobJson = ARGV[6]

  if workerId ~= '' then
    local currentOwner = redis.call('HGET', jobKey, 'claimedBy')
    if currentOwner ~= workerId then
      return 0
    end
  end

  redis.call('LREM', processingKey, 0, jobId)
  redis.call('LPUSH', dlqKey, jobId)
  redis.call('HSET', dlqJobsKey, jobId, jobJson)
  redis.call('HSET', jobKey, 'status', 'dead_letter', 'attempts', attempts, 'error', errorJson, 'claimedBy', '', 'claimedAt', '0', 'updatedAt', tostring(now))
  return 1
`;

export async function moveToDeadLetter(job: JobData, error: Error, workerId?: string): Promise<boolean> {
  const redis = getRedisClient();
  const now = Date.now();

  job.status = 'dead_letter';
  job.claimedBy = null;
  job.claimedAt = null;
  job.error = {
    message: error.message,
    stack: error.stack,
    code: (error as any).code,
    failedAt: new Date(now).toISOString(),
  };
  job.updatedAt = now;

  const jobKey = `${QUEUE_KEYS.JOB_PREFIX}${job.id}`;
  const errorJson = JSON.stringify(job.error);
  const jobJson = JSON.stringify(job);

  const res = await redis.eval(
    MOVE_DLQ_LUA,
    4,
    QUEUE_KEYS.PROCESSING,
    QUEUE_KEYS.DEAD_LETTER,
    QUEUE_KEYS.DLQ_JOBS,
    jobKey,
    job.id,
    String(now),
    workerId || '',
    String(job.attempts),
    errorJson,
    jobJson
  );

  if (process.env.NODE_ENV !== 'test' && Number(res) === 1) {
    console.warn(`[JobQueue] Job ${job.id} (${job.name}) moved to Dead Letter Queue after ${job.attempts} attempts:`, error.message);
  }

  return Number(res) === 1;
}

/**
 * Lua script for atomic stale-claim recovery:
 * Scans the processing list. For any job where (now - claimedAt) > visibilityTimeoutMs,
 * removes it from processing. If attempts >= maxAttempts, moves to DLQ.
 * Otherwise, increments attempts and returns it to the ready queue.
 */
const RECOVER_STALE_LUA = `
  local processingKey = KEYS[1]
  local readyKey = KEYS[2]
  local dlqKey = KEYS[3]
  local dlqJobsKey = KEYS[4]
  local jobPrefix = ARGV[1]
  local now = tonumber(ARGV[2])
  local visibilityTimeoutMs = tonumber(ARGV[3])
  local limit = tonumber(ARGV[4]) or 50

  local items = redis.call('LRANGE', processingKey, 0, limit - 1)
  local recovered = 0

  for _, jobId in ipairs(items) do
    local jobKey = jobPrefix .. jobId
    local claimedAt = tonumber(redis.call('HGET', jobKey, 'claimedAt') or '0')
    
    if claimedAt > 0 and (now - claimedAt) > visibilityTimeoutMs then
      local attempts = tonumber(redis.call('HGET', jobKey, 'attempts') or '0') + 1
      local maxAttempts = tonumber(redis.call('HGET', jobKey, 'maxAttempts') or '3')
      
      redis.call('LREM', processingKey, 0, jobId)
      
      if attempts >= maxAttempts then
        local errJson = '{"message":"Visibility timeout expired / worker abandoned job (crash recovery)","failedAt":"' .. tostring(now) .. '","code":"ERR_VISIBILITY_TIMEOUT"}'
        redis.call('HSET', jobKey, 'status', 'dead_letter', 'attempts', tostring(attempts), 'error', errJson, 'claimedBy', '', 'claimedAt', '0', 'updatedAt', tostring(now))
        redis.call('LPUSH', dlqKey, jobId)
        redis.call('HSET', dlqJobsKey, jobId, errJson)
      else
        local errJson = '{"message":"Visibility timeout expired / worker abandoned job (crash recovery)","failedAt":"' .. tostring(now) .. '","code":"ERR_VISIBILITY_TIMEOUT"}'
        redis.call('HSET', jobKey, 'status', 'pending', 'attempts', tostring(attempts), 'error', errJson, 'claimedBy', '', 'claimedAt', '0', 'updatedAt', tostring(now))
        redis.call('LPUSH', readyKey, jobId)
      end
      recovered = recovered + 1
    end
  end

  return recovered
`;

/**
 * Recovers stale or abandoned jobs from the processing queue after worker crashes or timeouts.
 */
export async function recoverStaleJobs(visibilityTimeoutMs: number = 30000, limit: number = 50): Promise<number> {
  const redis = getRedisClient();
  const now = Date.now();

  try {
    const recovered = await redis.eval(
      RECOVER_STALE_LUA,
      4,
      QUEUE_KEYS.PROCESSING,
      QUEUE_KEYS.READY,
      QUEUE_KEYS.DEAD_LETTER,
      QUEUE_KEYS.DLQ_JOBS,
      QUEUE_KEYS.JOB_PREFIX,
      now,
      visibilityTimeoutMs,
      limit
    );
    return Number(recovered) || 0;
  } catch (err: any) {
    console.error('[JobQueue] Error recovering stale jobs:', err.message);
    return 0;
  }
}

/**
 * Re-enqueues a job from the Dead Letter Queue for reprocessing.
 */
export async function retryDeadLetterJob(jobId: string): Promise<boolean> {
  const redis = getRedisClient();
  const job = await getJob(jobId);
  if (!job) {
    return false;
  }

  job.status = 'pending';
  job.attempts = 0;
  job.error = null;
  job.claimedBy = null;
  job.claimedAt = null;
  job.updatedAt = Date.now();

  const pipeline = redis.pipeline();
  pipeline.hset(`${QUEUE_KEYS.JOB_PREFIX}${job.id}`, serializeJob(job));
  pipeline.lrem(QUEUE_KEYS.DEAD_LETTER, 0, jobId);
  pipeline.hdel(QUEUE_KEYS.DLQ_JOBS, jobId);
  pipeline.lpush(QUEUE_KEYS.READY, jobId);
  await pipeline.exec();

  return true;
}

/**
 * Retrieves the latest dead-letter jobs for inspection/monitoring.
 */
export async function getDeadLetterJobs(limit: number = 50): Promise<JobData[]> {
  const redis = getRedisClient();
  const ids = await redis.lrange(QUEUE_KEYS.DEAD_LETTER, 0, limit - 1);
  if (!ids || ids.length === 0) {
    return [];
  }

  const jobs: JobData[] = [];
  for (const id of ids) {
    const job = await getJob(id);
    if (job) {
      jobs.push(job);
    }
  }
  return jobs;
}

/**
 * Returns current queue depths across ready, processing, delayed, and dead-letter queues.
 */
export async function getQueueMetrics(): Promise<{
  ready: number;
  processing: number;
  delayed: number;
  deadLetter: number;
}> {
  const redis = getRedisClient();
  const [ready, processing, delayed, deadLetter] = await Promise.all([
    redis.llen(QUEUE_KEYS.READY),
    redis.llen(QUEUE_KEYS.PROCESSING),
    redis.zcard(QUEUE_KEYS.DELAYED),
    redis.llen(QUEUE_KEYS.DEAD_LETTER),
  ]);

  return {
    ready: ready || 0,
    processing: processing || 0,
    delayed: delayed || 0,
    deadLetter: deadLetter || 0,
  };
}

/**
 * Clears queue keys in Redis. Primarily used in test setup/teardown.
 */
export async function clearAllQueues(): Promise<void> {
  const redis = getRedisClient();
  const keys = await redis.keys('rota:queue:*');
  const dlqKeys = await redis.keys('rota:dlq:*');
  const jobKeys = await redis.keys('rota:job:*');
  const emailIdemKeys = await redis.keys('email:idem:*');
  const lockKeys = await redis.keys('rota:lock:*');
  const all = [...keys, ...dlqKeys, ...jobKeys, ...emailIdemKeys, ...lockKeys];
  if (all.length > 0) {
    await redis.del(...all);
  }
}
