import { Module } from '@nestjs/common';

import { CollectorController, JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  controllers: [JobsController, CollectorController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
