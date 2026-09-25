import crypto from 'node:crypto';

import { httpsRequest, type HttpResponse } from '../../http.js';

export const SOLIS_BASE_URL = 'https://www.soliscloud.com:13333';

/** Error codes where the request never reached the inverter; worth retrying. */
const TRANSIENT_CODES = new Set(['B0115', 'B0173', '1']);

export class SolisApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'SolisApiError';
  }

  get transient(): boolean {
    return this.code === undefined || TRANSIENT_CODES.has(this.code);
  }
}

export interface SolisCredentials {
  keyId: string;
  keySecret: string;
}

type Requester = (url: string, options: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpResponse>;

export function contentMd5(body: string): string {
  return crypto.createHash('md5').update(body, 'utf8').digest('base64');
}

export function signRequest(secret: string, body: string, date: string, path: string): string {
  const toSign = ['POST', contentMd5(body), 'application/json', date, path].join('\n');
  return crypto.createHmac('sha1', secret).update(toSign, 'utf8').digest('base64');
}

/**
 * SolisCloud platform API client (monitoring + control).
 * Requests are serialised with a minimum spacing because the API rate-limits per key.
 */
export class SolisCloudClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;

  constructor(
    private readonly credentials: SolisCredentials,
    private readonly options: {
      baseUrl?: string;
      minSpacingMs?: number;
      retries?: number;
      requester?: Requester;
      now?: () => Date;
    } = {},
  ) {}

  inverterList(): Promise<Array<Record<string, unknown>>> {
    return this.post<{ page: { records: Array<Record<string, unknown>> } }>('/v1/api/inverterList', { pageSize: '100' })
      .then((data) => data.page.records);
  }

  inverterDetail(sn: string): Promise<Record<string, unknown>> {
    return this.post('/v1/api/inverterDetail', { sn });
  }

  /** 5-minute history for one day ("YYYY-MM-DD"). */
  inverterDay(sn: string, date: string, timeZoneHours: number): Promise<Array<Record<string, unknown>>> {
    return this.post('/v1/api/inverterDay', { sn, money: 'SEK', time: date, timeZone: timeZoneHours });
  }

  async read(sn: string, cid: number): Promise<string> {
    const data = await this.post<{ msg: string }>('/v2/api/atRead', { inverterSn: sn, cid });
    return data.msg;
  }

  async readBatch(sn: string, cids: number[]): Promise<Map<number, string>> {
    const data = await this.post<Array<Array<{ cid: number | string; msg: string }>>>(
      '/v2/api/atReadBatch',
      { inverterSn: sn, cids: cids.join(',') },
    );
    const result = new Map<number, string>();
    for (const group of data) for (const item of group) result.set(Number(item.cid), item.msg);
    return result;
  }

  async control(sn: string, cid: number, value: string, previous?: string): Promise<void> {
    const payload: Record<string, unknown> = { inverterSn: sn, cid, value };
    if (previous !== undefined) payload.yuanzhi = previous;
    const data = await this.post<Array<{ code?: number | string; msg?: string }>>('/v2/api/control', payload);
    for (const item of data ?? []) {
      if (item.code !== undefined && String(item.code) !== '0') {
        throw new SolisApiError(`Control CID ${cid} failed: ${item.msg ?? 'unknown error'}`, String(item.code));
      }
    }
  }

  async post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const retries = this.options.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.enqueue(() => this.postOnce<T>(path, payload));
      } catch (err) {
        const transient = !(err instanceof SolisApiError) || err.transient;
        if (!transient || attempt >= retries) throw err;
        await sleep(2_000 * (attempt + 1));
      }
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastRequest + (this.options.minSpacingMs ?? 600) - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequest = Date.now();
      return fn();
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async postOnce<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload);
    const date = (this.options.now?.() ?? new Date()).toUTCString();
    const signature = signRequest(this.credentials.keySecret, body, date, path);
    const requester = this.options.requester ?? httpsRequest;
    const response = await requester(`${this.options.baseUrl ?? SOLIS_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-MD5': contentMd5(body),
        'Content-Type': 'application/json',
        Date: date,
        Authorization: `API ${this.credentials.keyId}:${signature}`,
      },
      body,
    });
    if (response.status !== 200) {
      throw new SolisApiError(`HTTP ${response.status}: ${response.body.slice(0, 200)}`);
    }
    const json = JSON.parse(response.body) as { code?: string | number; msg?: string; data?: T };
    if (String(json.code) !== '0') {
      throw new SolisApiError(`${path}: ${json.msg ?? 'unknown error'}`, String(json.code));
    }
    return json.data as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
