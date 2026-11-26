import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { CampaignsController, CollectorHoldController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [JobsModule],
  controllers: [CampaignsController, CollectorHoldController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
