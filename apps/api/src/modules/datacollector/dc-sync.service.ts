import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { stateDirectory } from '../jobs/collector.config';
import { JobsService } from '../jobs/jobs.service';
import { dcSettings, enqueueFinishedJobs, syncOnce } from './dc-sync';

/** Runs the Data Collector sync every LEADCOLLECTOR_DC_INTERVAL_SECONDS
 * (default 30) when it is configured. JobsService is injected only so its
 * constructor has migrated the database before this opens it. */
@Injectable()
export class DcSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DataCollectorSync');
  private db: DatabaseSync | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(readonly jobs: JobsService) {}

  onModuleInit() {
    const settings = dcSettings();
    if (!settings) return;
    this.db = new DatabaseSync(join(stateDirectory(), 'collector.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000;');
    const seconds = Number(process.env.LEADCOLLECTOR_DC_INTERVAL_SECONDS || 30);
    this.timer = setInterval(
      () => void this.tick(),
      Math.max(5, seconds) * 1000,
    );
    this.timer.unref();
    this.logger.log(
      `syncing to ${settings.url} every ${Math.max(5, seconds)}s`,
    );
  }

  async tick() {
    const settings = dcSettings();
    if (!settings || !this.db || this.running) return;
    this.running = true;
    try {
      enqueueFinishedJobs(this.db);
      const report = await syncOnce(this.db, settings);
      if (report.error || report.dead) this.logger.warn(JSON.stringify(report));
    } catch (error) {
      this.logger.error(`sync round failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.db?.close();
  }
}
