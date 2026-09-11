export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} from ${new URL(url).host}`);
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

// fetch with a browser user agent, a timeout, and backoff on 429/5xx/network errors.
export async function request(url, { method = "GET", headers = {}, body, retries = 2, timeoutMs = 25000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-AU,en;q=0.9", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new HttpError(res.status, url);
      return res;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && !err.retryable) throw err;
      if (attempt < retries) await sleep(3000 * (attempt + 1) ** 2);
    }
  }
  throw lastError;
}

export const getJson = async (url, opts) => (await request(url, opts)).json();
export const getText = async (url, opts) => (await request(url, opts)).text();
