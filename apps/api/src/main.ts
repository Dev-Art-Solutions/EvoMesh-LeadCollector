import * as path from 'node:path';
import * as dotenv from 'dotenv';

const NODE_ENV = process.env.NODE_ENV ?? 'development';
dotenv.config({ path: path.resolve(__dirname, `../.env.${NODE_ENV}`) });
dotenv.config({ path: path.resolve(__dirname, `../.env`) });

import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import rateLimit from '@fastify/rate-limit';
import {
  ValidationPipe,
  RequestMethod,
  Logger as NestLogger,
} from '@nestjs/common';

import { AppModule } from '@/modules/app';
import { HttpExceptionFilter, ServiceExceptionInterceptor } from '@/common';
import { Logger } from '@/modules/logger';

const PREFIX = 'v1';
const IS_PRODUCTION = NODE_ENV === 'production';

const logger = new Logger();

function parseOrigins(): string[] {
  const extension = 'chrome-extension://egdgjicbgiamheekmimkgmeligcipkco';
  return [extension, ...(process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim())]
    .filter(origin => /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
}

async function bootstrap() {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT) || 5050;

  try {
    if (!['127.0.0.1', '::1'].includes(host)) throw new Error('HOST must be a loopback IP address');
    const agentToken = process.env.LEADCOLLECTOR_AGENT_TOKEN;
    const workerToken = process.env.LEADCOLLECTOR_WORKER_TOKEN;
    if (!agentToken || !workerToken || agentToken.length < 32 || workerToken.length < 32 || agentToken === workerToken) {
      throw new Error('Configure two different LeadCollector tokens of at least 32 characters');
    }
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ bodyLimit: 2 * 1024 * 1024 }),
      {
        bufferLogs: true,
        logger: ['error', 'warn', 'log', 'debug', 'verbose'],
      },
    );

    NestLogger.overrideLogger(logger);

    /** Bound local request frequency. */
    await app.register(rateLimit, {
      max: Number(process.env.RATE_LIMIT_MAX) || 240,
      timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
    });

    /** Allow extension origins and leave ordinary browser origins outside CORS. */
    app.enableCors({
      origin: parseOrigins(),
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    });

    app.setGlobalPrefix(PREFIX, {
      exclude: [{ path: '/', method: RequestMethod.GET }],
    });

    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new HttpExceptionFilter(httpAdapterHost));
    app.useGlobalInterceptors(new ServiceExceptionInterceptor());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        disableErrorMessages: IS_PRODUCTION,
      }),
    );

    app.enableShutdownHooks();
    await app.listen(port, host);
    logger.log(`🚀  Server listening on http://${host}:${port} (${NODE_ENV})`);
  } catch (err) {
    console.error('Startup error ➜', err);
    logger.error(
      '❌  App failed to start',
      err instanceof Error ? err.stack : err,
    );
    process.exit(1);
  }
}

bootstrap();

process.on('uncaughtException', (err) =>
  logger.error('uncaughtException', err),
);
process.on('unhandledRejection', (reason) =>
  logger.error('unhandledRejection', reason as any),
);
