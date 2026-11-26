import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { AuditsController } from './audits.controller';
import { AuditsService } from './audits.service';

@Module({
  imports: [JobsModule],
  controllers: [AuditsController],
  providers: [AuditsService],
})
export class AuditsModule {}
