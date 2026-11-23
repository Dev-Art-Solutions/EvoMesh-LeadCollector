import 'webextension-polyfill';

import { BACKGROUND_EVENTS } from '@chrome-extension/shared/enums';
import { type BackgroundMessagePayload, type IBackgroundMessageResponse } from '@chrome-extension/shared';
import { api, getBackendUrl, localBackend } from './api';
import { CollectionWorker, type CollectionJob, type WorkerPort } from './collection-worker';
import { crawlWebsitesConcurrently } from './crawler';

chrome.runtime.onInstalled.addListener(async () => {
  const manifest = chrome.runtime.getManifest();
  await chrome.storage.local.set({
    extension: {
      APP_ID: chrome.runtime.id,
      APP_VERSION: manifest.version,
    },
  });
});

const logger = (text: string, data?: Record<string, number | string | object | boolean | undefined>): void => {
  if (text) {
    console.log(text, data ? data : '');
  }
};

const WORKER_ALARM = 'leadcollector-poll';
const activeKey = 'collectorActive';
const marker = chrome.runtime.getURL('collection-tab.html');
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

const post: WorkerPort['post'] = async (backend, token, path, body) => {
  try {
    const response = await fetch(`${backend}/v1/jobs/${path}`, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, job: response.ok && response.status !== 204 ? await response.json() : undefined };
  } catch {
    return { status: 0 };
  }
};

const worker = new CollectionWorker({
  loadActive: async () => (await chrome.storage.session.get(activeKey))[activeKey],
  saveActive: active => active ? chrome.storage.session.set({ [activeKey]: active }) : chrome.storage.session.remove(activeKey),
  loadOutbox: async () => (await chrome.storage.local.get('collectorOutbox')).collectorOutbox,
  saveOutbox: outbox => outbox ? chrome.storage.local.set({ collectorOutbox: outbox }) : chrome.storage.local.remove('collectorOutbox'),
  config: async () => {
    const backend = localBackend(await getBackendUrl());
    const { collectorWorkerToken, collectorWorkerId } = await chrome.storage.local.get(['collectorWorkerToken', 'collectorWorkerId']);
    if (!backend || typeof collectorWorkerToken !== 'string' || collectorWorkerToken.length < 32) return;
    const workerId = typeof collectorWorkerId === 'string' ? collectorWorkerId : crypto.randomUUID();
    if (!collectorWorkerId) await chrome.storage.local.set({ collectorWorkerId: workerId });
    return { backend, workerId, token: collectorWorkerToken, version: chrome.runtime.getManifest().version };
  },
  post,
  openPlaceholder: async (job: CollectionJob) => {
    const url = `${marker}#${job.id}-${job.attempt}`;
    const existing = (await chrome.tabs.query({})).find(tab => (tab.pendingUrl || tab.url) === url);
    const id = existing?.id ?? (await chrome.tabs.create({ url, active: false })).id;
    if (id === undefined) throw new Error('Collection tab did not open');
    return id;
  },
  navigate: async (id, url) => { await chrome.tabs.update(id, { url }); },
  tab: id => chrome.tabs.get(id).catch(() => undefined),
  close: async id => {
    try {
      await chrome.tabs.remove(id);
    } catch {
      if (await chrome.tabs.get(id).catch(() => undefined)) return false;
    }
    await chrome.storage.session.remove(`collectorMapConfig:${id}`);
    return true;
  },
  now: Date.now,
});

const tick = () => { void worker.tick().catch(() => logger('LeadCollector worker could not reconcile')); };
const initialize = async () => {
  if (!(await chrome.alarms.get(WORKER_ALARM))) await chrome.alarms.create(WORKER_ALARM, { periodInMinutes: 0.5 });
  await chrome.alarms.clear('gls-poll');
  tick();
};
chrome.runtime.onStartup.addListener(() => { void initialize(); });
chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === WORKER_ALARM) tick(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.collectorWorkerToken || changes.store?.oldValue?.backend_url !== changes.store?.newValue?.backend_url)) tick();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && /captcha|\/sorry|consent\.google|accounts\.google|passport\.yandex/i.test(change.url)) {
    void chrome.storage.session.get(activeKey).then(state => {
      if (state[activeKey]?.tabId === tabId) tick();
    });
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.get(activeKey).then(state => {
    if (state[activeKey]?.tabId === tabId) tick();
    void chrome.storage.session.remove(`collectorMapConfig:${tabId}`);
  });
});
void initialize().catch(() => logger('LeadCollector alarms could not initialize'));

// Reconcile enrich_missing when optional permissions are granted or revoked at runtime
try {
  chrome.permissions?.onAdded?.addListener(permissions => {
    if (permissions.origins?.includes('<all_urls>') || permissions.origins?.some(o => o.includes('*'))) {
      chrome.storage.local.get('store', ({ store }) => {
        chrome.storage.local.set({ store: { ...(store || {}), enrich_missing: true } });
      });
    }
  });

  chrome.permissions?.onRemoved?.addListener(permissions => {
    if (permissions.origins?.includes('<all_urls>') || permissions.origins?.some(o => o.includes('*'))) {
      chrome.storage.local.get('store', ({ store }) => {
        chrome.storage.local.set({ store: { ...(store || {}), enrich_missing: false } });
      });
    }
  });
} catch {
  // permissions listeners unavailable
}

/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; payload: BackgroundMessagePayload },
    sender: chrome.runtime.MessageSender,
    send: (response: IBackgroundMessageResponse) => void,
  ) => {
    try {
      const action = message.type;
      const payload = message.payload;

      // handle the base (promise-returning) actions
      handleBackgroundEvent({ action, payload, callback: send });

      if (action === BACKGROUND_EVENTS.GET_STORE) {
        chrome.storage.local.get('store', ({ store }) => {
          send({ data: store, error: false });
        });
      }

      const reply = (promise: Promise<unknown>) => {
        promise.then(data => send({ data, error: false })).catch(() => send({ error: true, message: 'Collector operation failed' }));
      };
      if (action === BACKGROUND_EVENTS.CONTENT_READY) {
        reply(worker.ready(sender).then(job => ({ job })));
      }
      if (action === BACKGROUND_EVENTS.JOB_PROGRESS) {
        reply(worker.progress(sender, String(payload?.jobId), Number(payload?.count)));
      }
      if (action === BACKGROUND_EVENTS.SUBMIT_JOB_RESULTS) {
        reply(worker.report(sender, String(payload?.jobId), {
          endpoint: 'results', body: { data: payload?.data },
        }).then(accepted => ({ accepted })));
      }
      if (action === BACKGROUND_EVENTS.JOB_FAILED) {
        reply(worker.report(sender, String(payload?.jobId), {
          endpoint: 'error', body: { code: payload?.code, error: payload?.error, data: payload?.data },
        }).then(accepted => ({ accepted })));
      }
      const mapKey = `collectorMapConfig:${sender.tab?.id}`;
      if (action === BACKGROUND_EVENTS.UPDATE_GOOGLE_MAPS_CONFIG && sender.tab?.id !== undefined && sender.frameId === 0) {
        reply(chrome.storage.session.set({ [mapKey]: payload }));
      }
      if (action === BACKGROUND_EVENTS.GET_GOOGLE_MAPS_CONFIG && sender.tab?.id !== undefined) {
        reply(chrome.storage.session.get(mapKey).then(state => state[mapKey]));
      }

      if (action === BACKGROUND_EVENTS.OPEN_NEW_TAB) {
        const { url } = (payload as { url: string }) || {};
        chrome.tabs.create({ url });
      }

      if (action === BACKGROUND_EVENTS.OPEN_EXTENSION_PAGE) {
        chrome.runtime.openOptionsPage();
      }

      return true;
    } catch (e: any) {
      logger('background error', { message: e?.message });
      return false;
    }
  },
);

const handleBackgroundEvent = ({
  action,
  payload = {},
  callback,
}: {
  action: string;
  payload: BackgroundMessagePayload;
  callback: (response: IBackgroundMessageResponse) => void;
}) => {
  payload = payload || {};

  const handle = (promise: Promise<void | any>) => {
    promise
      .then(data => callback({ error: false, data }))
      .catch(error => callback({ error: true, message: error?.message }));
  };

  if (action === BACKGROUND_EVENTS.LOGGER) {
    logger(payload?.text as string, payload?.data as BackgroundMessagePayload);
  }

  switch (action) {
    case BACKGROUND_EVENTS.FETCH_URL:
      handle(handlers.fetchUrl({ url: payload.url as string }));
      break;
    case BACKGROUND_EVENTS.EXTRACT_WEBSITES:
      handle(handlers.extractWebsites({ urls: payload.urls as string[] }));
      break;
    case BACKGROUND_EVENTS.CHECK_BACKEND:
      handle(handlers.checkBackend());
      break;
  }
};

let backendStatusCache: { available: boolean; timestamp: number } | null = null;

const handlers = {
  fetchUrl: async ({ url }: { url: string }) => {
    const response = await fetch(url);
    return response.text();
  },

  checkBackend: async (): Promise<{ available: boolean; url: string }> => {
    const url = await getBackendUrl();
    if (!url) return { available: false, url: '' };

    api.setBaseUrl(url);
    const { error } = await api.health();
    const available = !error;
    backendStatusCache = { available, timestamp: Date.now() };
    return { available, url };
  },

  extractWebsites: async ({ urls }: { urls: string[] }) => {
    // 1. If backend is configured and running, try the local backend first
    try {
      const now = Date.now();
      const isCachedHealthy = backendStatusCache && (now - backendStatusCache.timestamp < 30000) && backendStatusCache.available;
      const isCachedUnhealthy = backendStatusCache && (now - backendStatusCache.timestamp < 30000) && !backendStatusCache.available;

      if (!isCachedUnhealthy) {
        const url = await getBackendUrl();
        if (url) {
          api.setBaseUrl(url);
          let canUseBackend = isCachedHealthy;
          if (!canUseBackend) {
            const { error: healthError } = await api.health();
            canUseBackend = !healthError;
            backendStatusCache = { available: canUseBackend, timestamp: now };
          }
          if (canUseBackend) {
            const { collectorWorkerToken } = localBackend(url) ? await chrome.storage.local.get('collectorWorkerToken') : {};
            const { data, error } = await api.extractWebsites({ urls, token: collectorWorkerToken });
            if (!error) {
              logger('Extracted websites via local backend', { count: data?.data?.length || 0 });
              return data || { data: [], results: 0 };
            }
          }
        }
      }
    } catch (e) {
      backendStatusCache = { available: false, timestamp: Date.now() };
      logger('Backend extraction unavailable, using native in-browser crawler', { error: (e as Error)?.message });
    }

    // 2. Standalone in-browser native crawler (zero-setup, universal fallback)
    const hasPermission = await chrome.permissions?.contains?.({ origins: ['<all_urls>'] });
    if (!hasPermission) {
      logger('Native in-browser crawler skipped: <all_urls> permission missing');
      return {
        data: [],
        results: 0,
        permissionMissing: true,
      };
    }

    logger('Running in-browser native crawler for URLs', { count: urls.length });
    const result = await crawlWebsitesConcurrently(urls, 6);
    logger('Native in-browser crawler completed', { results: result.results });
    return result;
  },

};
