import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { stateDirectory } from '../jobs/collector.config';
import { JobsService } from '../jobs/jobs.service';
import { auditView, BatchFilter, claimNext, findLeads, listAudits, queueAudit, requeueStale, runAudit } from './audits';

/** Runs queued audits one at a time. JobsService is injected so its
 * constructor has migrated the database before this opens it. */
@Injectable()
export class AuditsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Audits');
  private db!: DatabaseSync;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly abort = new AbortController();
  readonly directory = process.env.LEADCOLLECTOR_AUDIT_DIR || join(stateDirectory(), 'audits');

  constructor(private readonly jobs: JobsService) {}

  onModuleInit() {
    this.db = new DatabaseSync(join(stateDirectory(), 'collector.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    mkdirSync(this.directory, { recursive: true });
    requeueStale(this.db);
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    this.db?.close();
  }

  async tick() {
    if (this.running) return;
    const next = claimNext(this.db);
    if (!next) return;
    this.running = true;
    try {
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(10 * 60_000)]);
      await runAudit(this.db, next, this.directory, signal, {
        pagespeed: process.env.LEADCOLLECTOR_AUDIT_PAGESPEED !== '0',
        dcCollection: Boolean(process.env.LEADCOLLECTOR_DC_COLLECTION_AUDIT),
      });
      const view = auditView(this.db, next.id);
      this.logger.log(`audit ${next.id} ${view.status}: ${view.business} ${view.overall ?? ''}`);
    } finally {
      this.running = false;
    }
  }

  create(leadId: string, requestedBy?: string) {
    return queueAudit(this.db, leadId, requestedBy ?? null);
  }

  batch(filter: BatchFilter, requestedBy?: string) {
    const leads = findLeads(this.db, filter);
    return { queued: leads.map((l) => queueAudit(this.db, String(l.id), requestedBy ?? null)).map((a) => ({ id: a.id, business: a.business, city: a.city })) };
  }

  find(filter: BatchFilter) {
    return findLeads(this.db, filter);
  }

  get(id: string) {
    return auditView(this.db, id);
  }

  list() {
    return listAudits(this.db);
  }
}
