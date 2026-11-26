import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { setting, stateDirectory } from '../jobs/collector.config';
import { JobsService } from '../jobs/jobs.service';
import {
  adoptProgress,
  browserBusy,
  campaignDetail,
  CampaignInput,
  changeCampaign,
  createCampaign,
  hold,
  inFlight,
  listCampaigns,
  mapsSearchUrl,
  markSubmitted,
  nextItem,
  setHold,
  setPriority,
  settleActive,
} from './campaigns';

/** Feeds campaign searches to the worker. One search in the browser at a
 * time (any job counts), up to LEADCOLLECTOR_CAMPAIGN_INFLIGHT enriching
 * behind it. JobsService is injected so its constructor has migrated the
 * database before this opens it. */
@Injectable()
export class CampaignsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Campaigns');
  private readonly maxInFlight = setting('LEADCOLLECTOR_CAMPAIGN_INFLIGHT', 8, 1, 32);
  private readonly maxTries = setting('LEADCOLLECTOR_CAMPAIGN_TRIES', 2, 1, 5);
  private db!: DatabaseSync;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly jobs: JobsService) {}

  onModuleInit() {
    this.db = new DatabaseSync(join(stateDirectory(), 'collector.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.db?.close();
  }

  tick() {
    if (this.running) return;
    this.running = true;
    try {
      const reason = settleActive(this.db, this.maxTries);
      if (reason && !hold(this.db)) {
        setHold(this.db, reason);
        this.logger.warn(`holding every campaign: ${reason}`);
      }
      if (hold(this.db) || browserBusy(this.db) || inFlight(this.db) >= this.maxInFlight) return;
      if (this.jobs.health().worker.status !== 'ready') return;
      const next = nextItem(this.db);
      if (!next) return;
      const job = this.jobs.create({
        platform: next.params.platform,
        query: next.query,
        url: mapsSearchUrl(next.query, next.params),
        limit: next.params.limit,
        extractContacts: next.params.extractContacts,
        enrichmentLimit: next.params.enrichmentLimit,
        timeoutSeconds: next.params.timeoutSeconds,
        owner: `campaign:${next.campaignId}`,
        requestId: `c-${next.campaignId.slice(0, 8)}-${next.position}-${next.attempts}-${Date.now().toString(36)}`,
      });
      markSubmitted(this.db, next.campaignId, next.position, job.id);
    } catch (error) {
      this.logger.error(`campaign round failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  create(input: CampaignInput) {
    const created = createCampaign(this.db, input);
    this.logger.log(`campaign "${created.name}": ${created.searches.total} searches`);
    return created;
  }

  list() {
    return { hold: hold(this.db), campaigns: listCampaigns(this.db) };
  }

  detail(id: string) {
    return campaignDetail(this.db, id);
  }

  change(id: string, action: 'pause' | 'resume' | 'stop') {
    const { cancel } = changeCampaign(this.db, id, action);
    for (const jobId of cancel) {
      try {
        this.jobs.cancel(jobId);
      } catch {
        // Already finished: nothing to cancel.
      }
    }
    return campaignDetail(this.db, id);
  }

  priority(id: string, priority: number) {
    return setPriority(this.db, id, priority);
  }

  hold() {
    return hold(this.db);
  }

  releaseHold() {
    setHold(this.db, null);
    return { hold: null };
  }

  adopt(id: string, done: number, active: { position: number; jobId: string }[]) {
    adoptProgress(this.db, id, done, active);
    return campaignDetail(this.db, id);
  }
}
