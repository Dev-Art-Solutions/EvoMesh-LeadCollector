import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  @Length(1, 120)
  name: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @IsString({ each: true })
  @MaxLength(160, { each: true })
  locations: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  categories?: string[];

  @IsOptional()
  @IsIn(['smb', 'all_local'])
  preset?: string;

  @IsOptional()
  @Matches(/^[a-zA-Z]{2}$/)
  country?: string;

  @IsOptional()
  @Matches(/^[a-zA-Z]{2,3}(-[a-zA-Z]{2})?$/)
  language?: string;

  @IsOptional()
  @IsInt()
  @Min(-100)
  @Max(100)
  priority?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsBoolean()
  extractContacts?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  enrichmentLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(7200)
  timeoutSeconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  owner?: string;

  @IsOptional()
  @IsIn(['running', 'paused'])
  status?: 'running' | 'paused';
}

export class PriorityDto {
  @IsInt()
  @Min(-100)
  @Max(100)
  priority: number;
}

class ActiveItemDto {
  @IsInt()
  @Min(0)
  position: number;

  @IsString()
  @Length(36, 36)
  jobId: string;
}

export class AdoptDto {
  @IsInt()
  @Min(0)
  done: number;

  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ActiveItemDto)
  active: ActiveItemDto[];
}
