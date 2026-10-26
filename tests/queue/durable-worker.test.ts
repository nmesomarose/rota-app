import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processPaymentWebhook } from '../../src/services/payment-provider.ts';
import {
  enqueueJob,
  getJob,
  getQueueMetrics,
  getDeadLetterJobs,
  retryDeadLetterJob,
  clearAllQueues,
  promoteDelayedJobs,
  claimNextJob,
  recoverStaleJobs,
  renewJobClaim,
  completeJob,
  failAndRetryJob,
  moveToDeadLetter,
  QUEUE_KEYS,
  type JobData,
} from '../../src/queue/job-queue.ts';
import { JobWorker, createDefaultWorker } from '../../src/queue/job-worker.ts';
import {
  handlePushNotification,
  handlePaymentWebhook,
  handlePasswordResetEmail,
  handleInvitationEmail,
  handlePaymentInboxSweeper,
  CONTROL_PLANE_JOB_WHITELIST,
} from '../../src/queue/handlers.ts';
import {
  sendPushNotification,
  getPushDispatchHistory,
  clearPushDispatchHistory,
  setSimulatedPushFailure,
} from '../../src/services/push-service.ts';
import {
  sendEmail,
  getEmailInbox,
  clearEmailInbox,
  setSimulatedEmailFailure,
} from '../../src/services/email-service.ts';
import {
  getRedisClient,
  ensureRedisConnected,
  closeRedisClient,
} from '../../src/services/redis-client.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { onboardBusiness } from '../../src/services/organization-service.ts';
import { requestPasswordReset } from '../../src/services/auth-service.ts';
import { registerPushToken } from '../../src/services/notification-service.ts';

describe('Durable Background Jobs, Queues & Worker Architecture (PRD 8.6, BILL-007, SEC-018, AC-TEN-08)', () => {
  const originalEnv = { ...process.env };

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_PROVIDER = 'simulated';
    process.env.PUSH_PROVIDER = 'simulated';
    delete process.env.RESEND_API_KEY;
    await ensureRedisConnected();
  });

  after(async () => {
    process.env = { ...originalEnv };
    await clearAllQueues();
    await closeAllPools();
  });

  beforeEach(async () => {
    await clearAllQueues();
    clearEmailInbox();
    clearPushDispatchHistory();
  });

  it('1. Successfully enqueues and executes background jobs across queues', async () => {
    const worker = new JobWorker({ pollIntervalMs: 50, delayedCheckIntervalMs: 100 });
    let executedJob: JobData | null = null;

    worker.registerHandler('test.control_simple', async (job) => {
      executedJob = job;
      return { success: true };
    });

    // Enqueue
    const enqueued = await enqueueJob('test.control_simple', { foo: 'bar', timestamp: 12345 });
    assert.ok(enqueued.id);
    assert.strictEqual(enqueued.name, 'test.control_simple');
    assert.strictEqual(enqueued.status, 'pending');

    const metricsBefore = await getQueueMetrics();
    assert.strictEqual(metricsBefore.ready, 1);

    // Process single job
    const processed = await worker.processNext();
    assert.strictEqual(processed, true);
    assert.ok(executedJob);
    assert.strictEqual((executedJob as any).data.foo, 'bar');

    // Confirm job state updated in Redis
    const storedJob = await getJob(enqueued.id);
    assert.ok(storedJob);
    assert.strictEqual(storedJob.status, 'completed');
    assert.strictEqual(storedJob.error, null);

    const metricsAfter = await getQueueMetrics();
    assert.strictEqual(metricsAfter.ready, 0);
  });

  it('2. Enforces exponential-backoff retries for transient failures', async () => {
    const worker = new JobWorker({ pollIntervalMs: 50 });
    let attemptsCount = 0;

    worker.registerHandler('test.control_transient', async () => {
      attemptsCount++;
      if (attemptsCount < 3) {
        throw new Error(`Transient failure attempt ${attemptsCount}`);
      }
      return { ok: true };
    });

    // Enqueue with backoffMs = 200, maxAttempts = 5
    const job = await enqueueJob(
      'test.control_transient',
      { action: 'retry-test' },
      { maxAttempts: 5, backoffMs: 200 }
    );

    // Attempt 1 -> throws
    await worker.processNext();
    assert.strictEqual(attemptsCount, 1);

    let jobAfter1 = await getJob(job.id);
    assert.ok(jobAfter1);
    assert.strictEqual(jobAfter1.status, 'pending');
    assert.strictEqual(jobAfter1.attempts, 1);
    assert.ok(jobAfter1.error?.message.includes('Transient failure attempt 1'));

    // Delayed queue must contain this job
    let metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 0);
    assert.strictEqual(metrics.delayed, 1);

    // Fast-forward: promote delayed jobs manually (simulating scheduler sweep)
    const redis = getRedisClient();
    // Set score to 0 to make it immediately ready for promotion
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, job.id);
    const promoted1 = await promoteDelayedJobs();
    assert.strictEqual(promoted1, 1);

    // Attempt 2 -> throws
    await worker.processNext();
    assert.strictEqual(attemptsCount, 2);

    let jobAfter2 = await getJob(job.id);
    assert.ok(jobAfter2);
    assert.strictEqual(jobAfter2.attempts, 2);

    // Promote again
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, job.id);
    await promoteDelayedJobs();

    // Attempt 3 -> succeeds
    await worker.processNext();
    assert.strictEqual(attemptsCount, 3);

    let jobAfter3 = await getJob(job.id);
    assert.ok(jobAfter3);
    assert.strictEqual(jobAfter3.status, 'completed');
    assert.strictEqual(jobAfter3.error, null);
  });

  it('3. Moves exhausted jobs to Dead Letter Queue (DLQ) with rich debugging details', async () => {
    const worker = new JobWorker({ pollIntervalMs: 50 });

    worker.registerHandler('test.control_exhaust', async () => {
      const err = new Error('Database connection reset during credit operation');
      (err as any).code = 'ECONNRESET';
      throw err;
    });

    // Enqueue with maxAttempts = 2
    const job = await enqueueJob(
      'test.control_exhaust',
      { accountId: 'acc_999', amount: 5000 },
      { maxAttempts: 2, backoffMs: 100 }
    );

    // Attempt 1 -> fails
    await worker.processNext();
    const redis = getRedisClient();
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, job.id);
    await promoteDelayedJobs();

    // Attempt 2 -> exhausted!
    await worker.processNext();

    const deadJob = await getJob(job.id);
    assert.ok(deadJob);
    assert.strictEqual(deadJob.status, 'dead_letter');
    assert.strictEqual(deadJob.attempts, 2);
    assert.ok(deadJob.error);
    assert.strictEqual(deadJob.error.message, 'Database connection reset during credit operation');
    assert.strictEqual(deadJob.error.code, 'ECONNRESET');
    assert.ok(deadJob.error.stack);
    assert.ok(deadJob.error.failedAt);

    // Verify presence in Dead Letter Queue
    const metrics = await getQueueMetrics();
    assert.strictEqual(metrics.deadLetter, 1);

    const dlqJobs = await getDeadLetterJobs();
    assert.strictEqual(dlqJobs.length, 1);
    assert.strictEqual(dlqJobs[0].id, job.id);
    assert.strictEqual(dlqJobs[0].name, 'test.control_exhaust');

    // Test operator DLQ re-queue capability
    const requeueOk = await retryDeadLetterJob(job.id);
    assert.strictEqual(requeueOk, true);

    const metricsAfterRequeue = await getQueueMetrics();
    assert.strictEqual(metricsAfterRequeue.deadLetter, 0);
    assert.strictEqual(metricsAfterRequeue.ready, 1);

    const requeuedJob = await getJob(job.id);
    assert.ok(requeuedJob);
    assert.strictEqual(requeuedJob.status, 'pending');
    assert.strictEqual(requeuedJob.attempts, 0);
  });

  it('4. Enforces tenant context isolation on background jobs (SEC-018, AC-TEN-08)', async () => {
    const worker = new JobWorker();
    let handlerExecuted = false;

    worker.registerHandler('tenant.scoped.job', async (job) => {
      handlerExecuted = true;
    });

    // 4a. A non-whitelisted job without businessId MUST fail and move to DLQ when maxAttempts is exhausted
    const invalidJob = await enqueueJob('tenant.scoped.job', { foo: 'bar' }, { maxAttempts: 1 });
    await worker.processNext();

    const deadInvalidJob = await getJob(invalidJob.id);
    assert.ok(deadInvalidJob);
    assert.strictEqual(deadInvalidJob.status, 'dead_letter');
    assert.ok(
      deadInvalidJob.error?.message.includes('AC-TEN-08: Background job') &&
      deadInvalidJob.error?.message.includes('missing required tenant context')
    );

    // 4b. Whitelisted control plane jobs succeed without businessId
    let controlJobRan = false;
    worker.registerHandler('test.control_job', async () => {
      controlJobRan = true;
    });

    const validControlJob = await enqueueJob('test.control_job', { action: 'cleanup' });
    await worker.processNext();

    const finishedControlJob = await getJob(validControlJob.id);
    assert.ok(finishedControlJob);
    assert.strictEqual(finishedControlJob.status, 'completed');
    assert.strictEqual(controlJobRan, true);
  });

  it('5. Delivers push notifications and handles Expo formatting and inbox fallback idempotently', async () => {
    const worker = createDefaultWorker();

    const testEmail = `worker_push_${Date.now()}@example.com`;
    const userRes = await controlPool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, status)
       VALUES ($1, 'hash', 'Push Worker Test', 'active')
       RETURNING id`,
      [testEmail]
    );
    const userId = userRes.rows[0].id;

    const sessionId = randomUUID();
    const onboard = await onboardBusiness(userId, testEmail, sessionId, {
      name: 'Push Worker Corp',
      timezone: 'UTC',
      branchName: 'HQ',
      departments: ['Support'],
    });
    const businessId = onboard.business.id;

    // Register a valid Expo token in control plane
    const testPushToken = `ExponentPushToken[device_${Date.now()}]`;
    await registerPushToken({
      userId,
      deviceId: 'dev_123',
      token: testPushToken,
    });

    // Create a pending delivery record in tenant DB
    const dedupeKey = `pub_shift_test_${Date.now()}`;
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, channel, dedupe_key, status)
         VALUES ($1, 'evt_1', $2, 'push', $3, 'pending')`,
        [businessId, userId, dedupeKey]
      );
    });

    // Enqueue push notification job
    const job = await enqueueJob(
      'push.notification',
      {
        businessId,
        userId,
        deviceId: 'dev_123',
        title: 'Your Shift Starts Soon',
        body: 'Please review your upcoming shift.',
        urgent: true,
        dedupeKey,
      },
      { businessId }
    );

    // Process job directly through worker execution pipeline
    await worker.executeJob(job);

    // Check push dispatch history
    const history = getPushDispatchHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].pushToken, testPushToken);
    assert.strictEqual(history[0].urgent, true);

    // Verify delivery updated in tenant database
    await withTenantContext(businessId, async (client) => {
      const deliveryRes = await client.query<{ status: string; ticket_id: string }>(
        'SELECT status, ticket_id FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      assert.strictEqual(deliveryRes.rows[0].status, 'delivered_expo');
      assert.ok(deliveryRes.rows[0].ticket_id);
    });

    // Idempotency: Re-processing identical job skips duplicate push dispatch
    await worker.executeJob(job);
    assert.strictEqual(getPushDispatchHistory().length, 1, 'Did not re-dispatch push notification');
  });

  it('6. Delivers password reset and invitation emails with Redis-backed idempotency', async () => {
    const worker = createDefaultWorker();
    const uniqueRawToken = `secure_reset_token_${Date.now()}_${randomUUID()}`;

    // 6a. Password Reset Email
    const resetEmailJob = await enqueueJob('email.password_reset', {
      userId: randomUUID(),
      email: 'staff@example.com',
      rawToken: uniqueRawToken,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    await worker.processNext();

    const inbox = getEmailInbox();
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].to, 'staff@example.com');
    assert.ok(inbox[0].subject.includes('Reset Your Rota Password'));
    assert.ok(inbox[0].text?.includes(uniqueRawToken));

    // Replay/retry of identical reset job does not deliver duplicate email
    await worker.executeJob(resetEmailJob);
    assert.strictEqual(getEmailInbox().length, 1, 'Idempotency prevented duplicate reset email');

    // 6b. Invitation Email
    const inviteId = randomUUID();
    const uniqueInviteToken = `invite_secret_token_${Date.now()}_${randomUUID()}`;
    const inviteEmailJob = await enqueueJob(
      'email.invitation',
      {
        businessId: randomUUID(),
        invitationId: inviteId,
        email: 'newhire@example.com',
        role: 'Staff',
        inviterName: 'Alice Owner',
        rawToken: uniqueInviteToken,
      },
      { businessId: null } // Control-plane email handler
    );

    await worker.processNext();
    assert.strictEqual(getEmailInbox().length, 2);
    assert.strictEqual(getEmailInbox()[1].to, 'newhire@example.com');
    assert.ok(getEmailInbox()[1].subject.includes('invited'));

    // Replay of identical invite job does not deliver duplicate email
    await worker.executeJob(inviteEmailJob);
    assert.strictEqual(getEmailInbox().length, 2, 'Idempotency prevented duplicate invitation email');
  });

  it('7. Re-enqueues unprocessed payment inbox events via sweeper (BILL-007 step 3)', async () => {
    const worker = createDefaultWorker();
    const providerEventId = `sweep_test_${Date.now()}`;

    // Ensure no stale 'received' rows pollute the test count
    await controlPool.query("DELETE FROM payment_events WHERE status = 'received'");

    // Insert an old 'received' payment event simulating a dropped event or Redis failure
    await controlPool.query(
      `INSERT INTO payment_events (provider, provider_event_id, payload, status, created_at)
       VALUES ('paystack', $1, '{"data": {"reference": "sweep_ref_1"}}'::jsonb, 'received', NOW() - INTERVAL '120 seconds')`,
      [providerEventId]
    );

    // Run payment inbox sweeper with threshold 60 seconds
    const sweepJob = await enqueueJob('sweeper.payment_inbox', { thresholdSeconds: 60 });
    await worker.processNext();

    // Verify a payment.webhook job was enqueued in the ready queue
    const metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 1);

    const queuedJobId = await getRedisClient().rpop(QUEUE_KEYS.READY);
    assert.ok(queuedJobId);
    const queuedJob = await getJob(queuedJobId);
    assert.ok(queuedJob);
    assert.strictEqual(queuedJob.name, 'payment.webhook');
    assert.strictEqual(queuedJob.data.providerEventId, providerEventId);
  });

  it('8. Supports graceful worker shutdown and in-flight completion', async () => {
    const worker = new JobWorker({ pollIntervalMs: 20 });
    let jobFinished = false;

    worker.registerHandler('test.control_slow', async () => {
      await new Promise((r) => setTimeout(r, 100));
      jobFinished = true;
    });

    await enqueueJob('test.control_slow', {});

    worker.start();
    assert.strictEqual(worker.getStatus().isRunning, true);

    // Allow worker to pick up job into in-flight state, then initiate graceful shutdown
    const claimWaitStart = Date.now();
    while (worker.getStatus().activeJobsCount === 0 && Date.now() - claimWaitStart < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await worker.stop(2000);

    assert.strictEqual(worker.getStatus().isRunning, false);
    assert.strictEqual(jobFinished, true, 'In-flight job completed before worker shutdown resolved');
  });

  it('9. Ingests payment webhooks with immediate queue response and fulfills via background worker (BILL-007)', async () => {
    const worker = createDefaultWorker();
    const testSecret = 'simulated_secret_test_key_12345';

    // 1. Setup user and business
    const testEmail = `webhook_async_${Date.now()}@example.com`;
    const userRes = await controlPool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, status)
       VALUES ($1, 'hash', 'Webhook User', 'active')
       RETURNING id`,
      [testEmail]
    );
    const userId = userRes.rows[0].id;
    const sessionId = randomUUID();
    const onboard = await onboardBusiness(userId, testEmail, sessionId, {
      name: 'Async Billing Corp',
      timezone: 'UTC',
    });
    const businessId = onboard.business.id;

    // 2. Create payment intent in tenant DB
    const providerReference = `async_ref_${Date.now()}`;
    await withTenantContext(businessId, async (client) => {
      const qRes = await client.query<{ id: string }>(
        `INSERT INTO billing_quotes (
           business_id, currency, amount_minor, base_usd_amount_minor,
           subscription_version, target_plan, target_seat_quantity,
           effective_local_date, period_days, remaining_days, status,
           expires_at, created_by
         ) VALUES (
           $1, 'USD', 5000, 5000,
           1, 'team', 10,
           CURRENT_DATE, 30, 30, 'confirmed',
           NOW() + INTERVAL '1 hour', $2
         )
         RETURNING id`,
        [businessId, onboard.membership.id]
      );
      const quoteId = qRes.rows[0].id;

      await client.query(
        `INSERT INTO payment_intents (business_id, quote_id, idempotency_key, provider, provider_reference, amount_minor, currency, status, expires_at)
         VALUES ($1, $2, $3, 'simulated', $4, 5000, 'USD', 'awaiting_payment', NOW() + INTERVAL '1 hour')`,
        [businessId, quoteId, `idem_${providerReference}`, providerReference]
      );
    });

    const providerEventId = `async_evt_${Date.now()}`;
    const webhookPayload = {
      event: 'charge.success',
      data: {
        id: providerEventId,
        reference: providerReference,
        amount_minor: 5000,
        currency: 'USD',
        status: 'success',
        metadata: { business_id: businessId },
      },
    };
    const rawBody = JSON.stringify(webhookPayload);
    const signature = createHmac('sha256', testSecret).update(rawBody).digest('hex');

    // 3. Ingest webhook with asyncProcessing: true (BILL-007 step 2-3)
    const webhookRes = await processPaymentWebhook({
      rawBody,
      signature,
      signatureType: 'simulated',
      secret: testSecret,
      asyncProcessing: true,
    });

    // Immediate acknowledgment
    assert.strictEqual(webhookRes.status, 'queued');
    assert.strictEqual(webhookRes.providerEventId, providerEventId);

    // Verify ready queue has 1 job
    const metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 1);

    // 4. Background worker processes the payment.webhook job
    await worker.processNext();

    // 5. Verify payment intent marked succeeded and subscription upgraded in tenant DB
    await withTenantContext(businessId, async (client) => {
      const intentCheck = await client.query<{ status: string }>(
        'SELECT status FROM payment_intents WHERE business_id = $1 AND provider_reference = $2',
        [businessId, providerReference]
      );
      assert.strictEqual(intentCheck.rows[0].status, 'succeeded');

      const subCheck = await client.query<{ plan: string; seat_quantity: number; status: string }>(
        'SELECT plan, seat_quantity, status FROM subscriptions WHERE business_id = $1',
        [businessId]
      );
      assert.strictEqual(subCheck.rows[0].plan, 'team');
      assert.strictEqual(subCheck.rows[0].seat_quantity, 10);
      assert.strictEqual(subCheck.rows[0].status, 'active');
    });

    const evtCheck = await controlPool.query<{ status: string }>(
      'SELECT status FROM payment_events WHERE provider_event_id = $1',
      [providerEventId]
    );
    assert.strictEqual(evtCheck.rows[0].status, 'processed');

    // 6. Duplicate delivery returns ignored_duplicate
    const duplicateRes = await processPaymentWebhook({
      rawBody,
      signature,
      signatureType: 'simulated',
      secret: testSecret,
      asyncProcessing: true,
    });
    assert.strictEqual(duplicateRes.status, 'ignored_duplicate');
  });

  it('10. Recovers abandoned job after simulated worker crash without data loss', async () => {
    // 1. Enqueue job
    const job = await enqueueJob('test.control_crash_recover', { taskId: 'critical_task_1' }, { maxAttempts: 3 });
    assert.ok(job.id);

    // Initial metrics: ready = 1, processing = 0
    let metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 1);
    assert.strictEqual(metrics.processing, 0);

    // 2. Worker 1 claims job, entering processing state
    const claimedJob = await claimNextJob('worker_pid_1001');
    assert.ok(claimedJob);
    assert.strictEqual(claimedJob.id, job.id);
    assert.strictEqual(claimedJob.claimedBy, 'worker_pid_1001');
    assert.ok(claimedJob.claimedAt && claimedJob.claimedAt > 0);

    // Metrics after claim: ready = 0, processing = 1 (job safely in processing queue)
    metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 0);
    assert.strictEqual(metrics.processing, 1);

    // 3. Worker 1 abruptly dies (process killed, never calls completeJob)
    // Simulate time passage past visibility timeout (e.g. 30,000ms ago)
    const redis = getRedisClient();
    await redis.hset(
      `${QUEUE_KEYS.JOB_PREFIX}${job.id}`,
      'claimedAt',
      String(Date.now() - 35000)
    );

    // 4. Stale recovery runs (e.g. by surviving worker or monitor)
    const recoveredCount = await recoverStaleJobs(30000);
    assert.strictEqual(recoveredCount, 1, 'Recovered exactly 1 abandoned job');

    // Metrics after recovery: ready = 1, processing = 0, attempts incremented
    metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 1);
    assert.strictEqual(metrics.processing, 0);

    const recoveredJobData = await getJob(job.id);
    assert.ok(recoveredJobData);
    assert.strictEqual(recoveredJobData.status, 'pending');
    assert.strictEqual(recoveredJobData.attempts, 1);
    assert.ok(recoveredJobData.error?.message.includes('Visibility timeout expired'));

    // 5. Worker 2 boots up and cleanly completes the recovered job
    const worker2 = new JobWorker({ workerId: 'worker_pid_2002' });
    let worker2Executed = false;
    worker2.registerHandler('test.control_crash_recover', async (j) => {
      worker2Executed = true;
      assert.strictEqual(j.data.taskId, 'critical_task_1');
    });

    await worker2.processNext();
    assert.strictEqual(worker2Executed, true);

    const finalJob = await getJob(job.id);
    assert.ok(finalJob);
    assert.strictEqual(finalJob.status, 'completed');

    metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 0);
    assert.strictEqual(metrics.processing, 0);
  });

  it('11. Prevents concurrent execution of actively claimed jobs while visibility timeout is active', async () => {
    const job = await enqueueJob('test.control_concurrency_lock', { payload: 'exclusive_work' });

    // Worker 1 claims job
    const claimedByWorker1 = await claimNextJob('worker_alpha');
    assert.ok(claimedByWorker1);
    assert.strictEqual(claimedByWorker1.id, job.id);

    // Worker 2 attempts claim concurrently while Worker 1 is working -> must receive null
    const claimedByWorker2 = await claimNextJob('worker_beta');
    assert.strictEqual(claimedByWorker2, null, 'Worker 2 cannot claim already-claimed job');

    // Stale recovery runs while claim is fresh -> must not prematurely reclaim
    const earlyRecovered = await recoverStaleJobs(30000);
    assert.strictEqual(earlyRecovered, 0, 'Did not recover job before visibility timeout');

    // Worker 1 executes and finishes cleanly
    const worker1 = new JobWorker({ workerId: 'worker_alpha' });
    worker1.registerHandler('test.control_concurrency_lock', async () => ({ done: true }));
    await worker1.executeJob(claimedByWorker1);

    const finalMetrics = await getQueueMetrics();
    assert.strictEqual(finalMetrics.ready, 0);
    assert.strictEqual(finalMetrics.processing, 0);
  });

  it('12. Prevents overlapping sweeper runs across workers using distributed mutex', async () => {
    const worker1 = new JobWorker({ workerId: 'worker_sweeper_1', sweeperIntervalMs: 60000 });
    const worker2 = new JobWorker({ workerId: 'worker_sweeper_2', sweeperIntervalMs: 60000 });

    // Both workers attempt to trigger the sweeper simultaneously
    const res1 = await worker1.triggerPaymentInboxSweep();
    const res2 = await worker2.triggerPaymentInboxSweep();

    // Exactly one worker must acquire lock, the other must be prevented
    assert.strictEqual(res1, true, 'Worker 1 acquired sweep lock');
    assert.strictEqual(res2, false, 'Worker 2 prevented from overlapping sweep');

    // Verify ready queue has only 1 sweeper job enqueued
    const metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 1);
  });

  it('13. Verifies Redis persistence configuration in docker-compose.yml', async () => {
    const composeContent = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');

    // Verify AOF persistence flags
    assert.ok(
      composeContent.includes('--appendonly') && composeContent.includes('yes'),
      'docker-compose.yml specifies --appendonly yes for Redis'
    );
    assert.ok(
      composeContent.includes('--appendfsync') && composeContent.includes('everysec'),
      'docker-compose.yml specifies --appendfsync everysec for Redis'
    );

    // Verify named persistent volume
    assert.ok(
      composeContent.includes('rota_redisdata:/data'),
      'docker-compose.yml mounts rota_redisdata:/data'
    );
    assert.ok(
      composeContent.includes('rota_redisdata:'),
      'docker-compose.yml declares rota_redisdata in top-level volumes'
    );
  });

  it('14. Heartbeat renews claimedAt so a long-running job is not reclaimed prematurely', async () => {
    // Worker with 500ms visibility timeout and 150ms heartbeat
    const worker = new JobWorker({
      visibilityTimeoutMs: 500,
      heartbeatIntervalMs: 150,
      workerId: 'worker_heartbeat_long',
    });

    let jobCompleted = false;
    worker.registerHandler('test.control_long_running', async () => {
      // Job takes 700ms (longer than the 500ms visibility timeout)
      await new Promise((r) => setTimeout(r, 700));
      jobCompleted = true;
    });

    const job = await enqueueJob('test.control_long_running', { heavy: true });
    assert.ok(job.id);

    // Start execution in background
    const executePromise = worker.processNext();

    // Wait 400ms (heartbeat should have fired at ~150ms and ~300ms)
    await new Promise((r) => setTimeout(r, 400));

    // Stale recovery runs at t=400ms. Since heartbeat renewed claimedAt, it must NOT reclaim
    const recovered = await recoverStaleJobs(500);
    assert.strictEqual(recovered, 0, 'Active long-running job was not reclaimed prematurely');

    // Wait for job to complete
    await executePromise;
    assert.strictEqual(jobCompleted, true);

    const metrics = await getQueueMetrics();
    assert.strictEqual(metrics.ready, 0);
    assert.strictEqual(metrics.processing, 0);

    const finishedJob = await getJob(job.id);
    assert.ok(finishedJob);
    assert.strictEqual(finishedJob.status, 'completed');
  });

  it('15. Stale worker cannot complete a job after losing its claim to another worker', async () => {
    const job = await enqueueJob('test.control_stale_rejection', { payload: 'valuable' });

    // 1. Worker 1 claims job
    const claimedJob1 = await claimNextJob('worker_stale_1');
    assert.ok(claimedJob1);
    assert.strictEqual(claimedJob1.claimedBy, 'worker_stale_1');

    // 2. Simulate Worker 1 hanging/freezing past visibility timeout
    const redis = getRedisClient();
    await redis.hset(
      `${QUEUE_KEYS.JOB_PREFIX}${job.id}`,
      'claimedAt',
      String(Date.now() - 35000)
    );

    // 3. Stale recovery re-queues the job
    const recovered = await recoverStaleJobs(30000);
    assert.strictEqual(recovered, 1);

    // 4. Worker 2 claims the job
    const claimedJob2 = await claimNextJob('worker_active_2');
    assert.ok(claimedJob2);
    assert.strictEqual(claimedJob2.claimedBy, 'worker_active_2');

    // 5. Worker 1 wakes up and attempts to complete the job with its old claim
    const completionByWorker1 = await completeJob(job.id, 'worker_stale_1');
    assert.strictEqual(completionByWorker1, false, 'Stale worker completion was rejected');

    // Job in Redis must still be in 'processing' owned by Worker 2
    const currentJob = await getJob(job.id);
    assert.ok(currentJob);
    assert.strictEqual(currentJob.status, 'processing');
    assert.strictEqual(currentJob.claimedBy, 'worker_active_2');

    // 6. Worker 2 completes cleanly
    const completionByWorker2 = await completeJob(job.id, 'worker_active_2');
    assert.strictEqual(completionByWorker2, true, 'Active worker completion succeeded');

    const finalJob = await getJob(job.id);
    assert.ok(finalJob);
    assert.strictEqual(finalJob.status, 'completed');
  });

  it('16. Email delivery failure releases idempotency lock and succeeds on subsequent retry', async () => {
    const worker = createDefaultWorker();
    const uniqueRawToken = `reset_fail_retry_${Date.now()}_${randomUUID()}`;
    const idempotencyKey = `email:reset:${uniqueRawToken}`;

    const resetEmailJob = await enqueueJob(
      'email.password_reset',
      {
        userId: randomUUID(),
        email: 'staff_retry@example.com',
        rawToken: uniqueRawToken,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      { maxAttempts: 3, backoffMs: 100 }
    );

    // 1. First attempt fails due to simulated network/SMTP failure
    setSimulatedEmailFailure((_to) => {
      const err = new Error('SMTP connection timed out: 504 Gateway Timeout');
      (err as any).code = 'ETIMEDOUT';
      throw err;
    });

    await worker.processNext();

    // Verify attempt 1 failed and no email was added to inbox
    assert.strictEqual(getEmailInbox().length, 0);

    const jobAfterFail = await getJob(resetEmailJob.id);
    assert.ok(jobAfterFail);
    assert.strictEqual(jobAfterFail.attempts, 1);
    assert.strictEqual(jobAfterFail.status, 'pending');

    // CRITICAL: The idempotency lock in Redis must have been released so the retry is not blocked!
    const redis = getRedisClient();
    const lockVal = await redis.get(`email:idem:${idempotencyKey}`);
    assert.strictEqual(lockVal, null, 'Sending lock was released on failure');

    // 2. Clear failure simulation to allow attempt 2 to succeed
    setSimulatedEmailFailure(null);

    // Fast-forward delayed queue for retry
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, resetEmailJob.id);
    await promoteDelayedJobs();

    // Process retry
    await worker.processNext();

    // Verify email was successfully delivered on retry!
    const inbox = getEmailInbox();
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].to, 'staff_retry@example.com');
    assert.ok(inbox[0].text?.includes(uniqueRawToken));

    // Idempotency state in Redis is now 'sent'
    const finalLockVal = await redis.get(`email:idem:${idempotencyKey}`);
    assert.strictEqual(finalLockVal, 'sent');

    // 3. Replay of already-sent email is safely suppressed
    await worker.executeJob(resetEmailJob);
    assert.strictEqual(getEmailInbox().length, 1, 'Duplicate replay was suppressed');
  });

  it('17. Concurrent email send attempts enforce duplicate protection', async () => {
    const idempotencyKey = `concurrent_test_${Date.now()}_${randomUUID()}`;

    // Two concurrent delivery calls with identical idempotencyKey
    const [res1, res2] = await Promise.all([
      sendEmail({
        to: 'concurrent@example.com',
        subject: 'Concurrent Welcome',
        text: 'Welcome',
        idempotencyKey,
      }),
      sendEmail({
        to: 'concurrent@example.com',
        subject: 'Concurrent Welcome',
        text: 'Welcome',
        idempotencyKey,
      }),
    ]);

    // Exactly one must succeed with sent: true, and the other must have duplicate: true
    const sentCount = [res1, res2].filter((r) => r.sent).length;
    const dupCount = [res1, res2].filter((r) => r.duplicate).length;

    assert.strictEqual(sentCount, 1, 'Exactly one delivery succeeded');
    assert.strictEqual(dupCount, 1, 'Exactly one delivery was detected as duplicate');

    // Verify inbox has only 1 recorded message
    const matchingEmails = getEmailInbox().filter((e) => e.idempotencyKey === idempotencyKey);
    assert.strictEqual(matchingEmails.length, 1);
  });

  it('18. Push notification failure triggers exponential-backoff retry and succeeds on subsequent attempt', async () => {
    const worker = createDefaultWorker({ workerId: 'worker_push_retry' });
    const testEmail = `push_retry_${Date.now()}@example.com`;
    const userRes = await controlPool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, status)
       VALUES ($1, 'hash', 'Push Retry Test', 'active')
       RETURNING id`,
      [testEmail]
    );
    const userId = userRes.rows[0].id;

    const onboard = await onboardBusiness(userId, testEmail, randomUUID(), {
      name: 'Push Retry Org',
      timezone: 'UTC',
      branchName: 'HQ',
      departments: ['Support'],
    });
    const businessId = onboard.business.id;

    const testPushToken = `ExponentPushToken[push_retry_${Date.now()}]`;
    await registerPushToken({
      userId,
      deviceId: 'retry_dev_1',
      token: testPushToken,
    });

    const dedupeKey = `retry_push_test_${Date.now()}`;
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, device_id, channel, dedupe_key, status)
         VALUES ($1, 'evt_retry', $2, 'retry_dev_1', 'push', $3, 'pending')`,
        [businessId, userId, dedupeKey]
      );
    });

    const job = await enqueueJob(
      'push.notification',
      {
        businessId,
        userId,
        deviceId: 'retry_dev_1',
        title: 'Retry Title',
        body: 'Retry Body',
        urgent: true,
        dedupeKey,
      },
      { businessId, maxAttempts: 3, backoffMs: 100 }
    );

    // 1. Simulate transient failure on attempt 1
    setSimulatedPushFailure((_token) => {
      const err = new Error('Expo push gateway timeout: 504 Gateway Timeout');
      (err as any).code = 'ETIMEDOUT';
      throw err;
    });

    await worker.processNext();

    // Verify attempt 1 failed
    assert.strictEqual(getPushDispatchHistory().length, 0);

    const jobAfterAttempt1 = await getJob(job.id);
    assert.ok(jobAfterAttempt1);
    assert.strictEqual(jobAfterAttempt1.attempts, 1);
    assert.strictEqual(jobAfterAttempt1.status, 'pending');
    assert.ok(jobAfterAttempt1.error?.message.includes('504 Gateway Timeout'));

    // Check exponential backoff delay in Redis:
    // backoffMs * 2^(attempts - 1) = 100 * 2^0 = 100ms
    const redis = getRedisClient();
    const score1 = await redis.zscore(QUEUE_KEYS.DELAYED, job.id);
    assert.ok(score1 !== null);
    assert.ok(Number(score1) > Date.now() - 50, 'Job scheduled in delayed queue with backoff');

    // Tenant delivery record is NOT marked delivered_expo
    await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      assert.notStrictEqual(r.rows[0].status, 'delivered_expo');
    });

    // 2. Clear simulated failure to test eventual success
    setSimulatedPushFailure(null);

    // Fast-forward delayed queue for retry
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, job.id);
    const promoted = await promoteDelayedJobs();
    assert.ok(promoted >= 1);

    // Process retry
    await worker.processNext();

    // Verify push was successfully dispatched
    assert.strictEqual(getPushDispatchHistory().length, 1);
    assert.strictEqual(getPushDispatchHistory()[0].pushToken, testPushToken);

    // Verify delivery record updated in tenant database
    await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string; ticket_id: string; attempts: number }>(
        'SELECT status, ticket_id, attempts FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      assert.strictEqual(r.rows[0].status, 'delivered_expo');
      assert.ok(r.rows[0].ticket_id);
    });

    // Job in Redis is completed
    const finalJob = await getJob(job.id);
    assert.ok(finalJob);
    assert.strictEqual(finalJob.status, 'completed');

    // Replay / idempotency test: duplicate replay does not re-dispatch push
    await worker.executeJob(job);
    assert.strictEqual(getPushDispatchHistory().length, 1, 'Replay of completed job skipped duplicate push');
  });

  it('19. Push notification exhausts max attempts and routes to Dead Letter Queue (DLQ)', async () => {
    const worker = createDefaultWorker({ workerId: 'worker_push_dlq' });
    const testEmail = `push_dlq_${Date.now()}@example.com`;
    const userRes = await controlPool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, status)
       VALUES ($1, 'hash', 'Push DLQ Test', 'active')
       RETURNING id`,
      [testEmail]
    );
    const userId = userRes.rows[0].id;
    const onboard = await onboardBusiness(userId, testEmail, randomUUID(), {
      name: 'Push DLQ Org',
      timezone: 'UTC',
      branchName: 'HQ',
      departments: ['Support'],
    });
    const businessId = onboard.business.id;

    const testPushToken = `ExponentPushToken[push_dlq_${Date.now()}]`;
    await registerPushToken({
      userId,
      deviceId: 'dlq_dev_1',
      token: testPushToken,
    });

    const dedupeKey = `dlq_push_test_${Date.now()}`;
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, device_id, channel, dedupe_key, status)
         VALUES ($1, 'evt_dlq', $2, 'dlq_dev_1', 'push', $3, 'pending')`,
        [businessId, userId, dedupeKey]
      );
    });

    const job = await enqueueJob(
      'push.notification',
      {
        businessId,
        userId,
        deviceId: 'dlq_dev_1',
        title: 'Permanent Error Test',
        body: 'Will exhaust retries',
        urgent: true,
        dedupeKey,
      },
      { businessId, maxAttempts: 3, backoffMs: 50 }
    );

    // Always throw failure
    setSimulatedPushFailure((_token) => {
      const err = new Error('Expo Gateway 502 Bad Gateway');
      (err as any).code = 'BAD_GATEWAY';
      throw err;
    });

    const redis = getRedisClient();

    // Attempt 1
    await worker.processNext();
    const j1 = await getJob(job.id);
    assert.strictEqual(j1?.attempts, 1);
    assert.strictEqual(j1?.status, 'pending');

    // Attempt 2
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, job.id);
    await promoteDelayedJobs();
    await worker.processNext();
    const j2 = await getJob(job.id);
    assert.strictEqual(j2?.attempts, 2);
    assert.strictEqual(j2?.status, 'pending');

    // Attempt 3 (Max Attempts = 3) -> should move to DLQ
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, job.id);
    await promoteDelayedJobs();
    await worker.processNext();

    // Verify DLQ
    const dlqJobs = await getDeadLetterJobs(10);
    const dlqJob = dlqJobs.find((j) => j.id === job.id);
    assert.ok(dlqJob, 'Job is present in dead-letter queue');
    assert.strictEqual(dlqJob.status, 'dead_letter');
    assert.strictEqual(dlqJob.attempts, 3);
    assert.ok(dlqJob.error?.message.includes('502 Bad Gateway'));

    // Verify no push was ever dispatched
    assert.strictEqual(getPushDispatchHistory().length, 0);

    // Verify tenant delivery was NOT marked delivered_expo
    await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      assert.notStrictEqual(r.rows[0].status, 'delivered_expo');
    });

    // Cleanup hook
    setSimulatedPushFailure(null);
  });

  it('20. Stale worker cannot overwrite push notification status or complete job after losing claim', async () => {
    const testEmail = `push_stale_${Date.now()}@example.com`;
    const userRes = await controlPool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, status)
       VALUES ($1, 'hash', 'Push Stale Test', 'active')
       RETURNING id`,
      [testEmail]
    );
    const userId = userRes.rows[0].id;
    const onboard = await onboardBusiness(userId, testEmail, randomUUID(), {
      name: 'Push Stale Org',
      timezone: 'UTC',
      branchName: 'HQ',
      departments: ['Support'],
    });
    const businessId = onboard.business.id;

    const testPushToken = `ExponentPushToken[push_stale_${Date.now()}]`;
    await registerPushToken({
      userId,
      deviceId: 'stale_dev_1',
      token: testPushToken,
    });

    const dedupeKey = `stale_push_test_${Date.now()}`;
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, device_id, channel, dedupe_key, status)
         VALUES ($1, 'evt_stale', $2, 'stale_dev_1', 'push', $3, 'pending')`,
        [businessId, userId, dedupeKey]
      );
    });

    const job = await enqueueJob(
      'push.notification',
      {
        businessId,
        userId,
        deviceId: 'stale_dev_1',
        title: 'Stale Worker Test',
        body: 'Stale Body',
        urgent: true,
        dedupeKey,
      },
      { businessId, maxAttempts: 3 }
    );

    // 1. Worker 1 claims job
    const worker1Id = 'worker_push_stale_1';
    const claimedJob1 = await claimNextJob(worker1Id);
    assert.ok(claimedJob1);
    assert.strictEqual(claimedJob1.id, job.id);
    assert.strictEqual(claimedJob1.claimedBy, worker1Id);

    // 2. Simulate Worker 1 hanging past visibility timeout
    const redis = getRedisClient();
    await redis.hset(
      `${QUEUE_KEYS.JOB_PREFIX}${job.id}`,
      'claimedAt',
      String(Date.now() - 35000)
    );

    // 3. Stale job recovery reclaims the job to ready queue
    const recovered = await recoverStaleJobs(30000);
    assert.strictEqual(recovered, 1);

    // 4. Worker 2 claims the recovered job
    const worker2Id = 'worker_push_active_2';
    const claimedJob2 = await claimNextJob(worker2Id);
    assert.ok(claimedJob2);
    assert.strictEqual(claimedJob2.claimedBy, worker2Id);

    // 5. Worker 1 attempts to complete the job with its stale claim
    const completionByWorker1 = await completeJob(job.id, worker1Id);
    assert.strictEqual(completionByWorker1, false, 'Stale worker cannot complete the job');

    // 6. Worker 1 attempts to fail and retry the job with its stale claim
    const retryByWorker1 = await failAndRetryJob(job, 1000, worker1Id);
    assert.strictEqual(retryByWorker1, false, 'Stale worker cannot retry the job');

    // 7. Worker 1 attempts to move job to DLQ with its stale claim
    const dlqByWorker1 = await moveToDeadLetter(job, new Error('stale failure'), worker1Id);
    assert.strictEqual(dlqByWorker1, false, 'Stale worker cannot move job to DLQ');

    // The job in Redis is STILL claimed and owned by Worker 2 in processing queue
    const midJob = await getJob(job.id);
    assert.ok(midJob);
    assert.strictEqual(midJob.claimedBy, worker2Id);
    assert.strictEqual(midJob.status, 'processing');

    // 8. Worker 2 successfully completes the job
    const worker2 = createDefaultWorker({ workerId: worker2Id });
    await worker2.executeJob(claimedJob2);

    // Push was dispatched by Worker 2
    assert.strictEqual(getPushDispatchHistory().length, 1);

    // Final job status in Redis is completed
    const finalJob = await getJob(job.id);
    assert.ok(finalJob);
    assert.strictEqual(finalJob.status, 'completed');

    // Delivery record in DB is delivered_expo
    await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      assert.strictEqual(r.rows[0].status, 'delivered_expo');
    });

    // If Worker 1 wakes up later and attempts to execute the push handler,
    // the DB idempotency check prevents duplicate push or status overwrite
    const staleResult = await handlePushNotification(claimedJob1);
    assert.strictEqual(staleResult.skipped, true);
    assert.strictEqual(staleResult.reason, 'already_delivered');
    assert.strictEqual(getPushDispatchHistory().length, 1, 'No duplicate push from stale worker');
  });
});
