import { config } from '@chrome-extension/shared';
import { BACKGROUND_EVENTS, DATA_PLATFORMS } from '@chrome-extension/shared/enums';
import {
  type DataPlatform, type IExtractMapsBaseItem, type IGoogleMapsExtractItem,
  type IYandexMapsExtractItem, type I2GisMapsExtractItem, extract2GisMapsResults, extractGoogleMapsResults, extractYandexMapsResults,
  getGoogleMapsConfig, MapCollectionError, sendBackgroundEvent, sleep,
} from '@chrome-extension/shared/lib';

type Job = { id: string; limit: number };


export async function collectionAssignment() {
  const response = await sendBackgroundEvent<{ job: Job | null }>({ type: BACKGROUND_EVENTS.CONTENT_READY });
  return response?.data?.job;
}

function checkProvider() {
  if (document.querySelector('#captcha, #challenge-form, form[action*="/sorry"], iframe[src*="recaptcha"], iframe[src*="smartcaptcha"]')) {
    throw new MapCollectionError('human_required');
  }
}

export async function runAutoCollection(job: Job, platform: DataPlatform) {
  const controller = new AbortController();
  let data: IExtractMapsBaseItem[] = [];
  let lastReport = 0;
  const options = <T extends IExtractMapsBaseItem>() => {
    const state = { data: [] as T[], results: 0, paused: false, completed: false };
    return {
      controller,
      limit: job.limit,
      strict: true,
      state: {
        value: state,
        update: (update: (current: typeof state) => typeof state) => {
          Object.assign(state, update(state));
          data = state.data;
        },
      },
      complete: () => controller.abort(),
      onRequestComplete: () => {
        checkProvider();
        if (Date.now() - lastReport < 3000) return;
        lastReport = Date.now();
        void sendBackgroundEvent({
          type: BACKGROUND_EVENTS.JOB_PROGRESS,
          payload: { jobId: job.id, count: state.results },
        }).catch(() => undefined);
      },
    };
  };
  let event: string = BACKGROUND_EVENTS.SUBMIT_JOB_RESULTS;
  let payload: { jobId: string; data?: IExtractMapsBaseItem[]; code?: string; error?: string };
  try {
    checkProvider();
    if (platform === DATA_PLATFORMS.GOOGLE_MAPS) {
      const deadline = Date.now() + 20000;
      let query = await getGoogleMapsConfig();
      while ((!query.search || !query.lat || !query.long) && Date.now() < deadline) {
        checkProvider();
        await sleep(1000);
        query = await getGoogleMapsConfig();
      }
      if (!query.search || !query.lat || !query.long) throw new MapCollectionError('map_unavailable');
      await extractGoogleMapsResults({ ...options<IGoogleMapsExtractItem>(), query, timeout: config.REQUEST_INTERVAL.GOOGLE_MAPS });
    } else if (platform === DATA_PLATFORMS.YANDEX_MAPS) {
      const deadline = Date.now() + 15000;
      while (!document.querySelector('.scroll__container') && Date.now() < deadline) {
        checkProvider();
        await sleep(750);
      }
      if (!document.querySelector('.scroll__container')) throw new MapCollectionError('map_unavailable');
      await extractYandexMapsResults({ ...options<IYandexMapsExtractItem>(), document, timeout: config.REQUEST_INTERVAL.YANDEX_MAPS });
    } else if (platform === DATA_PLATFORMS.GIS) {
      await extract2GisMapsResults({ ...options<I2GisMapsExtractItem>(), url: location.href, timeout: config.REQUEST_INTERVAL.GIS_MAPS });
    } else {
      throw new MapCollectionError('map_unavailable');
    }
    payload = { jobId: job.id, data: data.slice(0, job.limit) };
  } catch (error) {
    event = BACKGROUND_EVENTS.JOB_FAILED;
    const code = error instanceof MapCollectionError ? error.code : 'map_unavailable';
    payload = {
      jobId: job.id, code,
      error: code === 'human_required' ? 'Map provider requires human interaction' : 'Collection could not read the map results',
      data: data.slice(0, job.limit),
    };
  }
  // The worker acknowledges only after writing its durable outbox. Retry storage
  // or messaging failures while this document still belongs to the job.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await sendBackgroundEvent<{ accepted: boolean }>({ type: event, payload });
      if (reply && !reply.error) return;
    } catch {
      // The service worker can restart during the message.
    }
    await sleep(1000);
  }
}
