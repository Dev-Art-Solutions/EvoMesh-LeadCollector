import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { requireRole } from '../jobs/collector.config';
import { CampaignError } from './campaigns';
import { AdoptDto, CreateCampaignDto, PriorityDto } from './campaigns.dto';
import { CampaignsService } from './campaigns.service';

function mapped<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof CampaignError)) throw error;
    if (error.code === 'not_found') throw new NotFoundException(error.message);
    if (error.code === 'conflict') throw new ConflictException(error.message);
    throw new BadRequestException(error.message);
  }
}

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post()
  create(@Headers('authorization') auth: string, @Body() body: CreateCampaignDto) {
    requireRole(auth, 'agent');
    return mapped(() => this.campaigns.create(body));
  }

  @Get()
  list(@Headers('authorization') auth: string) {
    requireRole(auth, 'agent');
    return this.campaigns.list();
  }

  @Get(':id')
  get(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    requireRole(auth, 'agent');
    return mapped(() => this.campaigns.detail(id));
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    requireRole(auth, 'agent');
    return mapped(() => this.campaigns.change(id, 'pause'));
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    requireRole(auth, 'agent');
    return mapped(() => this.campaigns.change(id, 'resume'));
  }

  @Post(':id/stop')
  @HttpCode(200)
  stop(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    requireRole(auth, 'agent');
    return mapped(() => this.campaigns.change(id, 'stop'));
  }

  @Post(':id/priority')
  @HttpCode(200)
  priority(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PriorityDto,
  ) {
    requireRole(auth, 'agent');
    return mapped(() => this.campaigns.priority(id, body.priority));
  }

  /** Carry over progress made before campaigns existed (an outside driver). */
  @Post(':id/adopt')
  @HttpCode(200)
  adopt(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdoptDto,
  ) {
    requireRole(auth, 'agent');
    return mapped(() => this.campaigns.adopt(id, body.done, body.active));
  }
}

@Controller('collector')
export class CollectorHoldController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('hold')
  hold(@Headers('authorization') auth: string) {
    requireRole(auth, 'agent');
    return { hold: this.campaigns.hold() };
  }

  /** After a person cleared the consent page or CAPTCHA in the browser. */
  @Post('resume')
  @HttpCode(200)
  resume(@Headers('authorization') auth: string) {
    requireRole(auth, 'agent');
    return this.campaigns.releaseHold();
  }
}
