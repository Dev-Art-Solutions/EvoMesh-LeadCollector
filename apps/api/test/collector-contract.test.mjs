import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entrypoint = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));
const serverEntry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const agent = 'fixture-agent-token-'.repeat(3);
const worker = 'fixture-worker-token-'.repeat(3);

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('stdio MCP interoperates with Nest, durable SQLite and fixture extension', { timeout: 40000 }, async t => {
  const state = await mkdtemp(join(tmpdir(), 'collector-contract-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(port), BACKEND_URL: base,
    LEADCOLLECTOR_AGENT_TOKEN: agent, LEADCOLLECTOR_WORKER_TOKEN: worker,
    LEADCOLLECTOR_STATE_DIR: state, LEADCOLLECTOR_EXPORT_DIR: join(state, 'agent', 'exports'),
  };
  delete env.HOST;
  delete env.LEADCOLLECTOR_ENV_FILE;
  const apiProcess = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  apiProcess.stderr.on('data', data => { logs += data; });
  apiProcess.stdout.on('data', data => { logs += data; });
  t.after(async () => {
    if (apiProcess.exitCode === null && apiProcess.signalCode === null) {
      const exited = once(apiProcess, 'exit');
      apiProcess.kill();
      await exited;
    }
    try {
      assert.ok(!logs.includes(agent) && !logs.includes(worker), 'test credentials must stay out of the API logs');
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 100 && apiProcess.exitCode === null; attempt++) {
    ready = await fetch(base, { signal: AbortSignal.timeout(500) }).then(r => r.ok).catch(() => false);
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, logs);
  const nonLoopback = Object.values(networkInterfaces()).flat()
    .find(address => address?.family === 'IPv4' && !address.internal);
  if (nonLoopback) {
    const externallyReachable = await fetch(`http://${nonLoopback.address}:${port}/`, {
      signal: AbortSignal.timeout(500),
    }).then(() => true, () => false);
    assert.equal(externallyReachable, false, 'default server must bind only to loopback');
  }

  function http(path, { role, method = 'GET', body, headers } = {}) {
    return fetch(`${base}/v1/${path}`, {
      method, headers: {
        ...(role ? { authorization: `Bearer ${role}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
  assert.equal((await http('jobs')).status, 401);
  assert.equal((await http('jobs', { role: worker })).status, 401);
  assert.equal((await http('jobs/next', { method: 'POST', role: agent, body: { workerId: 'fixture', version: '1' } })).status, 401);
  assert.equal((await http('health', { role: agent, headers: { origin: 'https://untrusted.example' } })).headers.get('access-control-allow-origin'), null);
  const origin = 'chrome-extension://egdgjicbgiamheekmimkgmeligcipkco';
  assert.equal((await http('health', { role: agent, headers: { origin } })).headers.get('access-control-allow-origin'), origin);
  assert.equal((await http('jobs', { method: 'POST', role: agent,
    body: { platform: 'google_maps', query: '  ', limit: 501 } })).status, 400);
  const oversized = await new Promise((resolve, reject) => {
    const incoming = request(`${base}/v1/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json', 'content-length': 2100000 },
    }, response => { response.resume(); resolve(response.statusCode); });
    incoming.once('error', reject);
    incoming.end();
  });
  assert.equal(oversized, 413);
  assert.equal((await http('jobs/next')).status, 400);

  const client = new Client({ name: 'collector-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], env, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('collect_maps') && names.includes('start_collection') && names.includes('get_collector_health'));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const raw = result.content[0].text;
    const text = result.isError && !raw.startsWith('{') ? { message: raw } : JSON.parse(raw);
    if (result.isError) return { ...text, isError: true };
    assert.deepEqual(result.structuredContent, Array.isArray(text) ? { data: text } : text);
    return text;
  };
  assert.equal((await call('get_collector_health')).worker.status, 'not_seen_recently');
  const { job_id } = await call('start_collection', { platform: 'google_maps', query: 'fixture', limit: 2, request_id: 'smoke' });
  assert.equal((await call('start_collection', { platform: 'google_maps', query: 'fixture', limit: 2, request_id: 'smoke' })).job_id, job_id);
  const claim = await http('jobs/next', { method: 'POST', role: worker, body: { workerId: 'fixture', version: '1' } });
  assert.equal((await claim.json()).id, job_id);
  assert.equal((await call('get_collector_health')).worker.status, 'ready');
  const listing = i => ({
    title: `Müller business ${i}`, place_id: `fixture-${i}`, maps_url: `https://www.google.com/maps?cid=${i}`,
  });
  const shipment = { workerId: 'fixture', attempt: 1, data: [listing(1), listing(2)] };
  assert.equal((await http(`jobs/${job_id}/results`, { method: 'POST', role: worker, body: shipment })).status, 200);
  assert.equal((await call('get_collection_status', { job_id })).results, 2);
  const page1 = await call('get_collection_results', { job_id, limit: 1 });
  const page2 = await call('get_collection_results', { job_id, limit: 1, cursor: page1.next_cursor });
  assert.equal(page1.data[0].name, 'Müller business 1');
  assert.equal(page2.data[0].name, 'Müller business 2');
  assert.equal(page2.next_cursor, null);
  assert.equal((await call('search_leads', { query: 'MÜLLER' })).data.length, 2);
  const artifact = await call('export_leads', { job_id, format: 'json' });
  assert.equal(JSON.parse(await readFile(artifact.path, 'utf8')).record_count, 2);
  const invalidExport = await call('export_leads', { job_id, format: '../csv' });
  assert.equal(invalidExport.isError, true);
  const { job_id: pending } = await call('start_collection', { platform: 'google_maps', query: 'cancel fixture', limit: 1 });
  assert.equal((await call('cancel_collection', { job_id: pending })).status, 'cancelled');
  const error = await call('get_collection_status', { job_id: '59fa4b66-f6ae-4b9d-b378-afeb8e2d5053' });
  assert.equal(error.code, 'not_found');
  const contactCheck = await call('extract_website_contacts', { urls: ['http://127.0.0.1/'] });
  assert.equal(contactCheck.data[0].status, 'blocked');
});
