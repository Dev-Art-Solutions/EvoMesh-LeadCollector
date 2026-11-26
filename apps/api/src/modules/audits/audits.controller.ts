import { BadRequestException, Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { requireRole } from '../jobs/collector.config';
import { AuditError } from './audits';
import { AuditFilterDto, CreateAuditDto } from './audits.dto';
import { AuditsService } from './audits.service';

function mapped<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof AuditError)) throw error;
    if (error.code === 'not_found') throw new NotFoundException(error.message);
    throw new BadRequestException(error.message);
  }
}

@Controller('audits')
export class AuditsController {
  constructor(private readonly audits: AuditsService) {}

  @Post()
  create(@Headers('authorization') auth: string, @Body() body: CreateAuditDto) {
    requireRole(auth, 'agent');
    return mapped(() => this.audits.create(body.leadId, body.requestedBy));
  }

  /** Queue an audit for every lead matching the filter (most reviewed first). */
  @Post('batch')
  batch(@Headers('authorization') auth: string, @Body() body: AuditFilterDto) {
    requireRole(auth, 'agent');
    const { requestedBy, ...filter } = body;
    return mapped(() => this.audits.batch(filter, requestedBy));
  }

  /** The leads a batch with this filter would audit, without queueing. */
  @Post('preview')
  @HttpCode(200)
  preview(@Headers('authorization') auth: string, @Body() body: AuditFilterDto) {
    requireRole(auth, 'agent');
    const { requestedBy: _r, ...filter } = body;
    return { leads: this.audits.find(filter) };
  }

  @Get()
  list(@Headers('authorization') auth: string) {
    requireRole(auth, 'agent');
    return this.audits.list();
  }

  @Get(':id')
  get(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    requireRole(auth, 'agent');
    return mapped(() => this.audits.get(id));
  }
}
