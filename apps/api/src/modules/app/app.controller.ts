import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';

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
  async extractWebsite(@Headers('authorization') auth: string, @Body() body: ExtractWebsiteDto) {
    requireRole(auth, 'agent', 'worker');
    const { urls } = body;
    return this.appService.extractWebsites({ urls });
  }
}
