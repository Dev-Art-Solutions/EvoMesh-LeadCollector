import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EnrichmentProcessor } from './enrichment.processor';

import { LoggerModule } from '@/modules/logger';
import { JobsModule } from '@/modules/jobs';
import { DcSyncService } from '@/modules/datacollector';
import { CampaignsModule } from '@/modules/campaigns';
import { AuditsModule } from '@/modules/audits';

@Module({
  imports: [LoggerModule, JobsModule, CampaignsModule, AuditsModule],
  controllers: [AppController],
  providers: [AppService, EnrichmentProcessor, DcSyncService],
})
export class AppModule {}
