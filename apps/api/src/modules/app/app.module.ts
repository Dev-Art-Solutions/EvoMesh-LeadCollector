import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EnrichmentProcessor } from './enrichment.processor';

import { LoggerModule } from '@/modules/logger';
import { JobsModule } from '@/modules/jobs';

@Module({
  imports: [LoggerModule, JobsModule],
  controllers: [AppController],
  providers: [AppService, EnrichmentProcessor],
})
export class AppModule {}
