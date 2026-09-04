import https from 'node:https';

/**
 * Minimal HTTPS GET on `node:https` rather than global fetch().
 *
 * Reason (measured 2026-09-04): BSE's edge intermittently emits a non-RFC-compliant
 * response header — "Unexpected whitespace after header value". Node's undici parser,
 * which backs global fetch(), rejects it outright; roughly 1 request in 3 failed with
 * HTTPParserError. `node:https` accepts `insecureHTTPParser: true`, which tolerates it.
 * With the lenient parser: 18/18 requests succeeded.
 *
 * The looseness is scoped to the one adapter that needs it — the ProviderAdapter
 * interface keeps this quirk from leaking anywhere else in the system. That is
 * precisely what the adapter layer is for.
 */
export interface HttpResponse { status: number; body: string }

export function httpGet(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; insecureParser?: boolean } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity', ...opts.headers },
        insecureHTTPParser: opts.insecureParser ?? false,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}
