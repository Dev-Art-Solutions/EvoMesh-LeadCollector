import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';

import type { FastifyReply } from 'fastify';
import { AppService } from './app.service';
import { ExtractWebsiteDto } from './app.dto';
import { requireRole } from '../jobs/collector.config';

@Controller()
export class AppController {
  constructor(private appService: AppService) {}

  /** Health check — used by the extension to detect an available backend. */
  @HttpCode(HttpStatus.OK)
  @Get()
  async health() {
    return { status: 'ok', service: 'evomesh-leadcollector' };
  }

  /** Extract contacts (emails, phones, socials) from a list of websites. */
  @HttpCode(HttpStatus.OK)
  @Post('extract-website')
  async extractWebsite(
    @Headers('authorization') auth: string,
    @Body() body: ExtractWebsiteDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    requireRole(auth, 'agent', 'worker');
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    reply.raw.once('close', disconnect);
    try {
      return await this.appService.extractWebsites(body, controller.signal);
    } finally {
      reply.raw.removeListener('close', disconnect);
    }
  }
}
