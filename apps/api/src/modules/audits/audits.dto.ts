import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class CreateAuditDto {
  @IsUUID()
  leadId: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  requestedBy?: string;
}

export class AuditFilterDto {
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsString() @MaxLength(150) query?: string;
  @IsOptional() @IsBoolean() withWebsite?: boolean;
  @IsOptional() @IsBoolean() withoutMetaPixel?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(120) requestedBy?: string;
}
