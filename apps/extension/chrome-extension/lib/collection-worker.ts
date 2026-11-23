export type CollectionJob = {
  id: string;
  platform: string;
  query: string;
  url?: string;
  limit: number;
  attempt: number;
  deadlineAt: number;
  leaseExpiresAt: number;
  status: string;
  phase: string;
  scrapedCount: number;
};

type Reply = { status: number; job?: CollectionJob };
type Delivery = { endpoint: 'results' | 'error'; body: Record<string, unknown> };
type Active = {
  job: CollectionJob;
  backend: string;
  workerId: string;
  tabId?: number;
  documentId?: string;
  count: number;
};
type Outbox = { active: Active; delivery: Delivery };

export type WorkerPort = {
  loadActive(): Promise<Active | undefined>;
  saveActive(active?: Active): Promise<void>;
  loadOutbox(): Promise<Outbox | undefined>;
  saveOutbox(outbox?: Outbox): Promise<void>;
  config(): Promise<{ backend: string; workerId: string; token: string; version: string } | undefined>;
  post(backend: string, token: string, path: string, body: Record<string, unknown>): Promise<Reply>;
  openPlaceholder(job: CollectionJob): Promise<number>;
  navigate(tabId: number, url: string): Promise<void>;
  tab(tabId: number): Promise<{ url?: string; pendingUrl?: string } | undefined>;
  close(tabId: number): Promise<boolean>;
  now(): number;
};

type Sender = { tab?: { id?: number }; frameId?: number; documentId?: string; url?: string };

const platforms: Record<string, { root: string; path: string; hosts: RegExp }> = {
  google_maps: { root: 'https://www.google.com', path: '/maps/search/', hosts: /^(?:www\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/ },
  yandex_maps: { root: 'https://yandex.com', path: '/maps/?mode=search&text=', hosts: /^(?:www\.)?yandex\.(?:com|ru|by|kz|ua|uz|eu)$/ },
  gis: { root: 'https://2gis.ru', path: '/search/', hosts: /^(?:www\.)?2gis\.(?:com|ru|kz|by|az|kg|uz)$/ },
};

function mapUrl(job: CollectionJob) {
  const platform = platforms[job.platform];
  return job.url || `${platform.root}${platform.path}${encodeURIComponent(job.query)}`;
}

function mapPage(job: CollectionJob, value?: string) {
  if (!value) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && platforms[job.platform].hosts.test(url.hostname) &&
    (job.platform === 'gis' ? url.pathname.includes('/search') :
      job.platform === 'google_maps' ? url.pathname.startsWith('/maps/search/') :
        url.pathname.startsWith('/maps') && (url.pathname.includes('/search') || url.searchParams.has('text')));
}

function humanRequired(value?: string) {
  if (!value) return false;
  const url = new URL(value);
  return /^(?:sorry|consent|accounts)\.google\./.test(url.hostname) ||
    /^(?:passport|smartcaptcha)\.yandex\./.test(url.hostname) ||
    /\/(?:sorry|showcaptcha|captcha)(?:\/|$)/i.test(url.pathname);
}

const final = (reply: Reply) => [400, 404, 409, 413, 422].includes(reply.status);
const success = (reply: Reply) => reply.status >= 200 && reply.status < 300;

export class CollectionWorker {
  private tasks = Promise.resolve();

  constructor(private readonly port: WorkerPort) {}

  private serialize<T>(task: () => Promise<T>) {
    const result = this.tasks.then(task);
    this.tasks = result.then(() => undefined, () => undefined);
    return result;
  }

  tick() {
    return this.serialize(async () => {
      const configuration = await this.port.config();
      const active = await this.port.loadActive();
      const outbox = await this.port.loadOutbox();
      if (outbox && configuration?.backend === outbox.active.backend && configuration.workerId === outbox.active.workerId) {
        if (!await this.deliver(outbox, configuration.token, active)) return;
        if (active) return;
      } else if (outbox && this.port.now() > outbox.active.job.deadlineAt) {
        await this.port.saveOutbox();
      }
      if (active) {
        if (!configuration || configuration.backend !== active.backend || configuration.workerId !== active.workerId) {
          await this.cleanup(active);
          return;
        }
        await this.reconcile(active, configuration.token);
        return;
      }
      if (!configuration || outbox) return;
      const reply = await this.port.post(configuration.backend, configuration.token, 'next', {
        workerId: configuration.workerId, version: configuration.version,
      });
      if (!reply.job?.id) return;
      const next: Active = { job: reply.job, backend: configuration.backend, workerId: configuration.workerId,
        count: reply.job.scrapedCount || 0 };
      // Persist before navigation so a document can never run without ownership.
      await this.port.saveActive(next);
      await this.open(next);
    });
  }

  private async open(active: Active) {
    active.tabId = await this.port.openPlaceholder(active.job);
    await this.port.saveActive(active);
    await this.port.navigate(active.tabId, mapUrl(active.job));
  }

  private async reconcile(active: Active, token: string) {
    const job = active.job;
    if (this.port.now() >= job.deadlineAt) {
      await this.cleanup(active);
      return;
    }
    const response = await this.port.post(active.backend, token, `${job.id}/heartbeat`, {
      ...this.assignment(active), phase: active.documentId ? 'scraping' : 'opening_map', count: active.count,
    });
    if (final(response) || (response.job && response.job.status !== 'running')) {
      if (await this.cleanup(active) && response.job) {
        await this.port.post(active.backend, token, `${job.id}/release`, this.assignment(active));
      }
      return;
    }
    if (!response.job || response.job.phase === 'enriching') {
      if (response.job || this.port.now() >= job.leaseExpiresAt) await this.cleanup(active);
      return;
    }
    active.job = response.job;
    await this.port.saveActive(active);
    if (active.tabId === undefined) {
      await this.open(active);
      return;
    }
    const tab = await this.port.tab(active.tabId);
    const url = tab?.pendingUrl || tab?.url;
    if (!tab) await this.fail(active, 'tab_closed', 'The collection tab closed', token);
    else if (humanRequired(url)) await this.fail(active, 'human_required', 'Map provider requires human interaction', token);
    else if (url?.startsWith('chrome-extension:') && !active.documentId) {
      await this.port.navigate(active.tabId, mapUrl(job));
    } else if (url && !mapPage(job, url)) {
      await this.fail(active, 'map_unavailable', 'The map search page could not be opened', token);
    }
  }

  ready(sender: Sender) {
    return this.serialize(async () => {
      const active = await this.port.loadActive();
      const pending = await this.port.loadOutbox();
      if (!active || pending || active.tabId !== sender.tab?.id || sender.frameId !== 0 ||
        !sender.documentId || !mapPage(active.job, sender.url) || this.port.now() >= active.job.leaseExpiresAt) return null;
      if (active.documentId !== sender.documentId) {
        active.documentId = sender.documentId;
        await this.port.saveActive(active);
      }
      return { id: active.job.id, limit: active.job.limit };
    });
  }

  progress(sender: Sender, jobId: string, count: number) {
    return this.serialize(async () => {
      const active = await this.port.loadActive();
      if (!this.matches(active, sender, jobId)) return false;
      active.count = Math.min(active.job.limit, Math.max(active.count, Math.floor(count || 0)));
      await this.port.saveActive(active);
      return true;
    });
  }

  report(sender: Sender, jobId: string, delivery: Delivery) {
    return this.serialize(async () => {
      const active = await this.port.loadActive();
      if (!this.matches(active, sender, jobId)) return false;
      const previous = await this.port.loadOutbox();
      if (previous) return previous.active.job.id === jobId;
      const outbox = { active, delivery };
      await this.port.saveOutbox(outbox);
      const configuration = await this.port.config();
      if (configuration?.backend === active.backend && configuration.workerId === active.workerId) {
        await this.deliver(outbox, configuration.token, active);
      }
      return true;
    });
  }

  private assignment(active: Active) {
    return { workerId: active.workerId, attempt: active.job.attempt };
  }

  private matches(active: Active | undefined, sender: Sender, jobId: string): active is Active {
    return !!active && active.job.id === jobId && active.tabId === sender.tab?.id && sender.frameId === 0 &&
      !!active.documentId && active.documentId === sender.documentId && mapPage(active.job, sender.url);
  }

  private async fail(active: Active, code: string, error: string, token: string) {
    const outbox: Outbox = { active, delivery: { endpoint: 'error', body: { code, error } } };
    await this.port.saveOutbox(outbox);
    await this.deliver(outbox, token, active);
  }

  private async deliver(outbox: Outbox, token: string, active?: Active) {
    const { job, backend } = outbox.active;
    let reply = await this.port.post(backend, token, `${job.id}/${outbox.delivery.endpoint}`, {
      ...outbox.delivery.body, ...this.assignment(outbox.active),
    });
    if ([400, 413, 422].includes(reply.status)) {
      reply = await this.port.post(backend, token, `${job.id}/error`, {
        ...this.assignment(outbox.active), code: 'worker_error', error: 'Collector API rejected the map payload',
      });
    }
    if (!success(reply) && !final(reply)) {
      if (active && this.port.now() < job.leaseExpiresAt) {
        const renewed = await this.port.post(backend, token, `${job.id}/heartbeat`, {
          ...this.assignment(active), phase: 'scraping', count: active.count,
        });
        if (renewed.job?.status === 'running' && renewed.job.phase === 'scraping') {
          active.job = renewed.job;
          outbox.active.job = renewed.job;
          await this.port.saveActive(active);
          await this.port.saveOutbox(outbox);
          return false;
        }
        if (!final(renewed) && !renewed.job) return false;
      }
      if (active) await this.cleanup(active);
      if (this.port.now() < job.deadlineAt) return false;
    }
    if (active) {
      if (!await this.cleanup(active)) return false;
      if (reply.status === 409 || reply.job?.status === 'cancelled' || reply.job?.status === 'error') {
        await this.port.post(backend, token, `${job.id}/release`, this.assignment(outbox.active));
      }
    }
    await this.port.saveOutbox();
    return true;
  }

  private async cleanup(active: Active) {
    if (active.tabId !== undefined && !await this.port.close(active.tabId)) return false;
    await this.port.saveActive();
    return true;
  }
}
