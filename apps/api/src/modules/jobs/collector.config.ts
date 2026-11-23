import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { UnauthorizedException } from '@nestjs/common';

export function setting(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function stateDirectory(): string {
  return resolve(
    process.env.LEADCOLLECTOR_STATE_DIR ||
      resolve(__dirname, '../../../.leadcollector'),
  );
}

export function requireRole(
  authorization: string | undefined,
  ...roles: ('agent' | 'worker')[]
) {
  const provided = Buffer.from(
    authorization?.startsWith('Bearer ') ? authorization.slice(7) : '',
  );
  for (const role of roles) {
    const token = process.env[`LEADCOLLECTOR_${role.toUpperCase()}_TOKEN`];
    if (!token || token.length < 32) continue;
    const expected = Buffer.from(token);
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    )
      return;
  }
  throw new UnauthorizedException('Collector credential missing or invalid');
}
