import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { requireRole } from './collector.config';
import {
  AssignmentDto,
  CreateJobDto,
  ExportDto,
  HeartbeatDto,
  JobErrorDto,
  PageDto,
  SubmitJobResultsDto,
  WorkerDto,
} from './jobs.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  create(@Headers('authorization') auth: string, @Body() body: CreateJobDto) {
    requireRole(auth, 'agent');
    return this.jobs.create(body);
  }

  @Post('next')
  @HttpCode(200)
  next(@Headers('authorization') auth: string, @Body() body: WorkerDto) {
    requireRole(auth, 'worker');
    return this.jobs.claim(body.workerId, body.version) ?? {};
  }

  @Get()
  list(@Headers('authorization') auth: string) {
    requireRole(auth, 'agent');
    return this.jobs.list();
  }

  @Get(':id')
  get(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    requireRole(auth, 'agent');
    return this.jobs.status(id);
  }

  @Get(':id/results')
  results(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: PageDto,
  ) {
    requireRole(auth, 'agent');
    return this.jobs.results(id, page);
  }

  @Post(':id/heartbeat')
  @HttpCode(200)
  heartbeat(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HeartbeatDto,
  ) {
    requireRole(auth, 'worker');
    return this.jobs.heartbeat(id, body, body.phase, body.count);
  }

  @Post(':id/release')
  @HttpCode(204)
  release(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignmentDto,
  ) {
    requireRole(auth, 'worker');
    this.jobs.release(id, body);
  }

  @Post(':id/results')
  @HttpCode(200)
  submit(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitJobResultsDto,
  ) {
    requireRole(auth, 'worker');
    return this.jobs.submit(id, body, body.data);
  }

  @Post(':id/error')
  @HttpCode(200)
  fail(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: JobErrorDto,
  ) {
    requireRole(auth, 'worker');
    return this.jobs.fail(id, body, body.code, body.error, body.data);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    requireRole(auth, 'agent');
    return this.jobs.cancel(id);
  }

  @Post(':id/export')
  export(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ExportDto,
  ) {
    requireRole(auth, 'agent');
    return this.jobs.export(id, body.format);
  }
}

@Controller()
export class CollectorController {
  constructor(private readonly jobs: JobsService) {}

  @Get('leads')
  search(@Headers('authorization') auth: string, @Query() page: PageDto) {
    requireRole(auth, 'agent');
    return this.jobs.search(page);
  }

  @Get('health')
  health(@Headers('authorization') auth: string) {
    requireRole(auth, 'agent');
    return this.jobs.health();
  }
}
