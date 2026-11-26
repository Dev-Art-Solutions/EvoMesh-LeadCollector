import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateAuditDto {
  @IsOptional()
  @IsUUID()
  leadId?: string;

  /** Instead of leadId: audit a business known only by its website. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  websiteUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @Matches(/^[a-zA-Z]{2}$/)
  country?: string;

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
