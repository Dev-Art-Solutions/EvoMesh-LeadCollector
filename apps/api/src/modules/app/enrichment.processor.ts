import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs';
import { setting } from '../jobs/collector.config';
import { Logger } from '../logger';
import { AppService } from './app.service';

/** Visits lead websites for jobs in the enriching phase. Each job holds one
 * lease, so it is enriched one site at a time; up to
 * LEADCOLLECTOR_ENRICH_PARALLEL jobs are enriched side by side. */
@Injectable()
export class EnrichmentProcessor implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, AbortController>();
  private readonly parallel = setting('LEADCOLLECTOR_ENRICH_PARALLEL', 1, 1, 16);
  private stopping = false;

  constructor(
    private readonly jobs: JobsService,
    private readonly sites: AppService,
    private readonly logger: Logger,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const abort of this.active.values()) abort.abort();
  }

  private tick() {
    try {
      for (const [jobId, abort] of this.active) {
        if (this.jobs.status(jobId).phase !== 'enriching') abort.abort();
      }
      while (!this.stopping && this.active.size < this.parallel) {
        const task = this.jobs.nextEnrichment();
        if (!task) return;
        const abort = new AbortController();
        this.active.set(task.jobId, abort);
        void this.sites
          .extractWebsite({ url: task.url }, abort.signal)
          .then((result) => {
            // Busy is the extractor's own concurrency cap (a manual
            // extract-website call took the slots), not the site's answer:
            // leave the lead queued for when the lease lapses.
            if (result.error === 'enrichment_busy') return;
            if (!this.stopping) this.jobs.finishEnrichment(task, result);
          })
          .catch(() => undefined)
          .finally(() => {
            this.active.delete(task.jobId);
            // Start the job's next site now rather than on the next tick.
            if (!this.stopping) this.tick();
          });
      }
    } catch {
      this.logger.warn('Enrichment processing failed. Check local database health.');
    }
  }
}
