import https from 'node:https';

export interface HttpResponse {
  status: number;
  body: string;
}

export class HttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Minimal HTTPS request helper (node:https, so it does not depend on the runtime's fetch). */
export function httpsRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      timeout: options.timeoutMs ?? 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new HttpError(`Timeout requesting ${url}`)));
    req.on('error', (err) => reject(err instanceof HttpError ? err : new HttpError(`${err.message} (${url})`)));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
