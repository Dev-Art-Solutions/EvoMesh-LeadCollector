import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { JOB_PLATFORMS, JobPlatform } from './jobs.types';

export class CreateJobDto {
  @IsIn(JOB_PLATFORMS)
  platform: JobPlatform;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 300)
  query: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsBoolean()
  extractContacts?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @MaxLength(64, { each: true })
  fields?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  owner?: string;

  @IsOptional()
  @Matches(/^[a-zA-Z0-9_.:-]{1,128}$/)
  requestId?: string;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(7200)
  timeoutSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  enrichmentLimit?: number;
}

export class WorkerDto {
  @Matches(/^[a-zA-Z0-9_-]{1,80}$/)
  workerId: string;

  @IsString()
  @Length(1, 32)
  version: string;
}

export class AssignmentDto {
  @Matches(/^[a-zA-Z0-9_-]{1,80}$/)
  workerId: string;

  @IsInt()
  @Min(1)
  attempt: number;
}

export class HeartbeatDto extends AssignmentDto {
  @IsIn(['opening_map', 'scraping'])
  phase: 'opening_map' | 'scraping';

  @IsInt()
  @Min(0)
  @Max(500)
  count: number;
}

export class SubmitJobResultsDto extends AssignmentDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsObject({ each: true })
  data: Record<string, unknown>[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  results?: number;
}

export class JobErrorDto extends AssignmentDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsObject({ each: true })
  data?: Record<string, unknown>[];

  @IsString()
  @Length(1, 300)
  error: string;

  @IsIn(['human_required', 'tab_closed', 'map_unavailable', 'worker_error'])
  code: string;
}

export class PageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  query?: string;
}

export class ExportDto {
  @IsIn(['csv', 'json'])
  format: 'csv' | 'json';
}
