import { ApiService } from '@chrome-extension/shared/api';
import { config } from '@chrome-extension/shared';

/** Resolve the configured backend origin from storage (empty = disabled). */
export const getBackendUrl = async (): Promise<string> => {
  return new Promise(resolve => {
    chrome.storage.local.get('store', ({ store }) => {
      const url = store?.backend_url;
      resolve(typeof url === 'string' ? url : config.DEFAULT_BACKEND_URL);
    });
  });
};

const baseUrl = (import.meta.env.VITE_BACKEND_URL as string) || config.DEFAULT_BACKEND_URL;

export const api = new ApiService({ baseUrl });

/** Worker credentials can only be sent to an explicit loopback origin. */
export const localBackend = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
        !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch {
    // A missing or invalid local endpoint disables the worker.
  }
  return undefined;
};
