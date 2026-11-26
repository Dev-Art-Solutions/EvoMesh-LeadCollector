#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

let configError;
try {
  const agentFile = fileURLToPath(new URL('./.env.agent', import.meta.url));
  const file = process.env.LEADCOLLECTOR_ENV_FILE ||
    (existsSync(agentFile) ? agentFile : fileURLToPath(new URL('./.env', import.meta.url)));
  process.loadEnvFile(file);
} catch (error) {
  if (error.code !== 'ENOENT' || process.env.LEADCOLLECTOR_ENV_FILE) configError = 'Cannot read LeadCollector credential file';
}

const token = process.env.LEADCOLLECTOR_AGENT_TOKEN;
let backend;
try {
  const url = new URL(process.env.BACKEND_URL || 'http://127.0.0.1:5050');
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
  backend = url.origin;
} catch {
  configError = 'BACKEND_URL must be a loopback HTTP(S) origin';
}

class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

async function api(path, { body, method = body === undefined ? 'GET' : 'POST', signal, timeout = 7000 } = {}) {
  if (configError) throw new ToolError('configuration_error', configError);
  if (!token || token.length < 32) throw new ToolError('credential_missing', 'Configure LEADCOLLECTOR_AGENT_TOKEN');
  let response;
  try {
    const timer = AbortSignal.timeout(timeout);
    response = await fetch(`${backend}/v1/${path}`, {
      method, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([timer, signal]) : timer,
    });
    if (response.ok) return await response.json();
  } catch {
    throw new ToolError(signal?.aborted ? 'cancelled' : 'backend_unavailable',
      signal?.aborted ? 'MCP request cancelled' : 'LeadCollector API could not be reached or did not respond');
  }
  const codes = {
    400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
    409: 'conflict', 413: 'body_limit', 429: 'limit_reached',
  };
  const message = response.status < 500 ? (await response.json().catch(() => null))?.message : undefined;
  throw new ToolError(codes[response.status] || 'backend_error', message || `LeadCollector API returned HTTP ${response.status}`);
}

function result(data, isError = false) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > 64 * 1024) {
    throw new ToolError('response_limit', 'Use smaller result pages or export artifacts');
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: Array.isArray(data) ? { data } : data,
    ...(isError ? { isError } : {}),
  };
}

const server = new McpServer({ name: 'evomesh-leadcollector', version: '1.0.0' });
function register(name, description, inputSchema, call) {
  server.registerTool(name, { description, inputSchema }, async (args, { signal }) => {
    try {
      return result(await call(args, signal));
    } catch (error) {
      if (!(error instanceof ToolError)) return result({ code: 'internal_error', message: 'LeadCollector tool failed' }, true);
      return result({ code: error.code, message: error.message, ...error.extra }, true);
    }
  });
}

const requestKey = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const collection = {
  platform: z.enum(['google_maps', 'yandex_maps', 'gis']),
  query: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(500).optional(),
  extract_contacts: z.boolean().optional(),
  enrichment_limit: z.number().int().min(1).max(500).optional(),
  request_id: requestKey.optional().describe('Reuse this key when retrying the same request'),
};
const jobId = { job_id: z.string().uuid() };
const pager = {
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  query: z.string().max(150).optional(),
};
const params = args => new URLSearchParams(Object.entries(args)
  .filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();

function create(args, requestId, signal) {
  return api('jobs', { signal, body: {
    platform: args.platform, query: args.query, limit: args.limit, extractContacts: args.extract_contacts,
    enrichmentLimit: args.enrichment_limit, owner: args.owner, timeoutSeconds: args.deadline_seconds, requestId,
  } });
}

register('start_collection', 'Queue a bounded map collection and return immediately. Reuse request_id across retries.',
  { ...collection, deadline_seconds: z.number().int().min(30).max(7200).optional(), owner: z.string().max(120).optional() },
  async (args, signal) => {
    const requestId = args.request_id || randomUUID();
    try {
      const job = await create(args, requestId, signal);
      return { job_id: job.id, request_id: requestId, status: job.status, phase: job.phase, deadline_at: job.deadlineAt };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      throw new ToolError(error.code, error.message, { request_id: requestId });
    }
  });

register('get_collection_status', 'Read progress, deadlines, result counts, and enrichment outcomes for a job.', jobId,
  ({ job_id }, signal) => api(`jobs/${job_id}`, { signal }));

register('get_collection_results', 'Read a page of normalized results and their source evidence. Use next_cursor for the next page.',
  { ...jobId, ...pager }, ({ job_id, ...page }, signal) => api(`jobs/${job_id}/results?${params(page)}`, { signal }));

register('cancel_collection', 'Cancel queued or running work and preserve any committed results.', jobId,
  ({ job_id }, signal) => api(`jobs/${job_id}/cancel`, { method: 'POST', signal }));

register('search_leads', 'Search persisted leads by business name, domain, address, city, or category.', pager,
  (page, signal) => api(`leads?${params(page)}`, { signal }));

register('export_leads', 'Write CSV or JSON for a finished job inside the configured export directory.',
  { ...jobId, format: z.enum(['csv', 'json']) },
  ({ job_id, format }, signal) => api(`jobs/${job_id}/export`, { body: { format }, signal }));

register('get_collector_health', 'Check MCP, local API, database, and the last authenticated extension worker heartbeat.', {},
  async (_, signal) => {
    try {
      return { mcp: 'ready', api: 'ready', ...await api('health', { signal }) };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      throw new ToolError(error.code, error.message, {
        mcp: 'ready', api: error.code === 'unauthorized' ? 'unauthorized' : 'unavailable',
        database: 'unknown', worker: { status: 'unknown' },
      });
    }
  });

register('extract_website_contacts', 'Extract observed public business contacts from up to 10 public websites.',
  { urls: z.array(z.string().min(1).max(2048)).min(1).max(10) },
  ({ urls }, signal) => api('extract-website', { body: { urls }, signal, timeout: 90000 }));

register('list_jobs', 'List up to 50 recent jobs and their status.', {},
  async (_, signal) => (await api('jobs', { signal })).map(job => ({
    id: job.id, platform: job.platform, query: job.query, owner: job.owner, status: job.status, phase: job.phase,
    results: job.results, errorCode: job.errorCode,
  })));

// -- campaigns: many searches as one task, run beside the others -------------

const campaignId = { campaign_id: z.string().uuid() };

register('create_campaign',
  'Start a collection task of many searches, "<category> in <location>" for every category and location, '
  + 'running beside the tasks already going (it does not stop them). Use it for a whole town, region or country: '
  + 'e.g. all local businesses in Veliko Tarnovo = locations ["Veliko Tarnovo, Bulgaria"], preset "all_local", '
  + 'country "BG". preset "smb" = 25 service niches, "all_local" = ~100 kinds of local business; or pass categories '
  + 'yourself (plural nouns, e.g. ["restaurants","cafes"]). country (ISO2) sets the Google Maps region and the '
  + 'language results come back in. priority: higher goes first; the nationwide USA campaigns run at 1-3, '
  + 'so a requested town at the default 10 finishes first. Website contacts are enriched for every lead.',
  {
    name: z.string().min(1).max(120),
    locations: z.array(z.string().min(1).max(160)).min(1).max(10000),
    preset: z.enum(['smb', 'all_local']).optional(),
    categories: z.array(z.string().min(1).max(80)).max(300).optional(),
    country: z.string().regex(/^[a-zA-Z]{2}$/).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
  },
  (args, signal) => api('campaigns', { signal, timeout: 30000, body: {
    name: args.name, locations: args.locations, preset: args.preset, categories: args.categories,
    country: args.country, priority: args.priority ?? 10, owner: 'lead-researcher',
  } }));

register('list_campaigns',
  'All collection tasks with status (running/paused/stopped/done), priority, searches done/total, progress % '
  + 'and leads, plus the collector-wide hold (set when Google asked for a human).', {},
  (_, signal) => api('campaigns', { signal }));

register('get_campaign',
  'One task in detail: counts, the searches in flight now (phase, results), recent failures and what comes next.',
  campaignId, ({ campaign_id }, signal) => api(`campaigns/${campaign_id}`, { signal }));

register('pause_campaign', 'Pause a task: searches already running finish, no new ones start.', campaignId,
  ({ campaign_id }, signal) => api(`campaigns/${campaign_id}/pause`, { method: 'POST', signal }));

register('resume_campaign', 'Resume a paused or stopped task; searches a stop cancelled run again.', campaignId,
  ({ campaign_id }, signal) => api(`campaigns/${campaign_id}/resume`, { method: 'POST', signal }));

register('stop_campaign', 'Stop a task: cancels its running searches; collected leads stay. It can be resumed later.',
  campaignId, ({ campaign_id }, signal) => api(`campaigns/${campaign_id}/stop`, { method: 'POST', signal }));

register('set_campaign_priority', 'Change a task\'s priority (higher runs first, equals take turns).',
  { ...campaignId, priority: z.number().int().min(-100).max(100) },
  ({ campaign_id, priority }, signal) => api(`campaigns/${campaign_id}/priority`, { body: { priority }, signal }));

register('resume_collector',
  'Clear the collector-wide hold after the human has handled Google\'s consent page or CAPTCHA in the EvoMesh '
  + 'Chrome. Never call this unless the human said they did it.', {},
  (_, signal) => api('collector/resume', { method: 'POST', signal }));

register('retry_job', 'Run a finished, failed or cancelled single search again as a new job.', jobId,
  ({ job_id }, signal) => api(`jobs/${job_id}/retry`, { method: 'POST', signal }));

register('collect_maps', 'Legacy synchronous collection. Prefer start_collection, status, paginated results, and exports.',
  { ...collection, timeout_seconds: z.number().int().min(10).max(900).optional() },
  async (args, signal) => {
    const key = args.request_id ?? 'legacy:' + createHash('sha256')
      .update(JSON.stringify([args.platform, args.query, args.limit ?? 200, !!args.extract_contacts, args.enrichment_limit ?? 20]))
      .digest('hex');
    const job = await create(args, key, signal);
    const deadline = Date.now() + 1000 * (args.timeout_seconds ?? 300);
    try {
      while (Date.now() < deadline && !signal.aborted) {
        const current = await api(`jobs/${job.id}`, { signal }).catch(error => {
          if (error.code !== 'backend_unavailable') throw error;
          return null;
        });
        if (current?.status === 'done') {
          const page = await api(`jobs/${job.id}/results?limit=20`, { signal });
          const data = page.data.map(lead => ({
            ...lead, title: lead.name, website: lead.website_url, maps_url: lead.listing_url,
            email: lead.contacts.find(contact => contact.type === 'email')?.normalized,
            phone: lead.contacts.find(contact => contact.type === 'phone')?.normalized,
            phones: lead.contacts.filter(contact => contact.type === 'phone').map(contact => contact.normalized).join(', '),
            socials: lead.contacts.filter(contact => contact.type === 'social').map(contact => contact.normalized).join(', '),
          }));
          while (data.length > 1 && Buffer.byteLength(JSON.stringify(data)) > 48 * 1024) data.pop();
          // A reduced inline page can be retrieved afresh through get_collection_results.
          return {
            jobId: job.id, job_id: job.id, platform: job.platform, query: job.query, results: current.results,
            data, next_cursor: data.length === page.data.length ? page.next_cursor : data.length,
          };
        }
        if (current && ['error', 'cancelled'].includes(current.status)) {
          throw new ToolError(current.errorCode || current.status, current.error || current.status, { job_id: job.id });
        }
        await sleep(1500, undefined, { signal });
      }
      throw new ToolError('wait_timeout', 'Collection wait timed out. Check status using job_id.', { job_id: job.id });
    } catch (error) {
      if (!signal.aborted) throw error;
      await api(`jobs/${job.id}/cancel`, { method: 'POST', timeout: 2000 }).catch(() => undefined);
      throw new ToolError('cancelled', 'MCP request cancelled', { job_id: job.id });
    }
  });

await server.connect(new StdioServerTransport());
