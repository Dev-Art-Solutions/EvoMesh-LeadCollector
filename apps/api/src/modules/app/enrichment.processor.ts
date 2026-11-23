import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs';
import { Logger } from '../logger';
import { AppService } from './app.service';

@Injectable()
export class EnrichmentProcessor implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval>;
  private active?: { jobId: string; abort: AbortController };
  private stopping = false;

  constructor(
    private readonly jobs: JobsService,
    private readonly sites: AppService,
    private readonly logger: Logger,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.warn(
          'Enrichment processing failed. Check local database health.',
        ),
      );
    }, 1000);
  }

  onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    this.active?.abort.abort();
  }

  private async tick() {
    if (this.active) {
      if (this.jobs.status(this.active.jobId).phase !== 'enriching')
        this.active.abort.abort();
      return;
    }
    const task = this.jobs.nextEnrichment();
    if (!task) return;
    const abort = new AbortController();
    this.active = { jobId: task.jobId, abort };
    try {
      const result = await this.sites.extractWebsite(
        { url: task.url },
        abort.signal,
      );
      if (!this.stopping) this.jobs.finishEnrichment(task, result);
    } finally {
      this.active = undefined;
    }
  }
}
