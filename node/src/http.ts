import { performance } from "node:perf_hooks";
import {
  PROGRAM_NAME,
  VERSION,
  ApiError,
  CliError,
  asObject,
  firstLine,
  oneLine,
  truncate,
  type Io,
} from "./base.js";
import { getFlag, getString, type OptionValues } from "./args.js";
import { normalizeBaseUrl } from "./inputs.js";

export interface HttpSettings {
  readonly timeoutMs: number;
  /** Minimum gap between two request starts: 500 ms keeps the client at or below 2 requests/s. */
  readonly minIntervalMs: number;
  /** Waits before the 2nd and 3rd attempt. */
  readonly retryDelaysMs: readonly number[];
  /** A longer Retry-After is a spent quota, not a hiccup: fail instead of waiting. */
  readonly maxRetryAfterMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly fetchImpl: typeof fetch;
}

export const DEFAULT_HTTP_SETTINGS: HttpSettings = {
  timeoutMs: 30_000,
  minIntervalMs: 500,
  retryDelaysMs: [1_000, 2_000],
  maxRetryAfterMs: 30_000,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: () => performance.now(),
  fetchImpl: fetch,
};

export interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly retryAfter: string | null;
}

const isRetryable = (status: number): boolean => status === 429 || status >= 500;

/** Retry-After header as a delay in ms; seconds or an HTTP-date. */
export function parseRetryAfter(header: string | null): number | undefined {
  const text = header?.trim() ?? "";
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = text ? Date.parse(text) : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function describeNetworkError(err: unknown, host: string, timeoutMs: number): string {
  const error = err as { name?: string; cause?: { code?: string } };
  const code = error.cause?.code ?? "";
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return `Request to ${host} timed out after ${Math.round(timeoutMs / 1000)}s. Try again later.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Could not resolve ${host}. Check the URL and your connection.`;
  }
  if (code === "ECONNREFUSED") return `Connection refused by ${host}. Is the server running?`;
  return `Could not reach ${host}. Check your connection and try again.${code ? ` (${code})` : ""}`;
}

/** Sequential JSON POSTs with throttling and retries (429 and 5xx, at most 3 attempts). */
export class HttpClient {
  private nextSlotAt = 0;

  constructor(
    private readonly settings: HttpSettings,
    private readonly baseUrl: string,
    readonly host: string,
    private readonly onRetry: (notice: string) => void,
  ) {}

  async post(path: string, payload: unknown): Promise<HttpResult> {
    const { retryDelaysMs } = this.settings;
    const attempts = retryDelaysMs.length + 1;
    for (let attempt = 1; ; attempt++) {
      await this.waitForSlot();
      const result = await this.send(path, payload);
      if (attempt >= attempts || !isRetryable(result.status)) return result;
      const retryAfterMs = parseRetryAfter(result.retryAfter);
      if (retryAfterMs !== undefined && retryAfterMs > this.settings.maxRetryAfterMs) return result;
      const delayMs = Math.max(retryDelaysMs[attempt - 1] ?? 0, retryAfterMs ?? 0);
      this.onRetry(
        `Got HTTP ${result.status} from ${this.host}, retrying in ${Math.round(delayMs / 1000)}s ` +
          `(attempt ${attempt + 1} of ${attempts})...`,
      );
      await this.settings.sleep(delayMs);
    }
  }

  /** Never lets two requests start less than minIntervalMs apart. */
  private async waitForSlot(): Promise<void> {
    const { now, sleep, minIntervalMs } = this.settings;
    let remaining = this.nextSlotAt - now();
    while (remaining > 0) {
      await sleep(remaining);
      remaining = this.nextSlotAt - now();
    }
    this.nextSlotAt = Math.max(this.nextSlotAt, now()) + minIntervalMs;
  }

  private async send(path: string, payload: unknown): Promise<HttpResult> {
    try {
      const response = await this.settings.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": `${PROGRAM_NAME}/${VERSION} (node)`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      return {
        status: response.status,
        body: await response.text(),
        retryAfter: response.headers.get("retry-after"),
      };
    } catch (err) {
      throw new CliError(describeNetworkError(err, this.host, this.settings.timeoutMs));
    }
  }
}

export interface ApiContext {
  readonly client: HttpClient;
  readonly host: string;
  readonly json: boolean;
  readonly io: Io;
}

export function createApiContext(
  options: OptionValues,
  io: Io,
  settings: HttpSettings = DEFAULT_HTTP_SETTINGS,
): ApiContext {
  const baseUrl = normalizeBaseUrl(getString(options, "base-url"));
  const host = new URL(baseUrl).host;
  const client = new HttpClient(settings, baseUrl, host, (notice) => io.stderr(`${notice}\n`));
  return { client, host, json: getFlag(options, "json"), io };
}

/** The API's `{ error, message }` envelope, when the server sent one. */
interface Failure {
  readonly status: number;
  readonly message: string | undefined;
  readonly code: string | undefined;
}

function failureOf(result: HttpResult): Failure {
  let body: unknown;
  try {
    body = JSON.parse(result.body);
  } catch {
    body = undefined;
  }
  const envelope = asObject(body);
  return {
    status: result.status,
    message: typeof envelope?.message === "string" ? oneLine(envelope.message) || undefined : undefined,
    code: typeof envelope?.error === "string" ? envelope.error : undefined,
  };
}

/** One honest sentence per failure, in the wording of the site. */
export function describeFailure(result: HttpResult, host: string): string {
  const { status, message, code } = failureOf(result);
  const where = `HTTP ${status} from ${host}`;
  const server = message ? ` ${message}` : "";
  if (status === 429) return `Too many requests — wait a few seconds and retry. (${where})${server}`;
  if (status >= 500) {
    return `The tool service returned an error (${where}). Please try again in a moment.${server}`;
  }
  if (message) return `${message} (${where}${code ? `, ${code}` : ""})`;
  const snippet = truncate(oneLine(result.body), 120);
  return `Request failed (${where}).${snippet ? ` ${snippet}` : ""}`;
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;
/** Statuses that are about one item; every other failure aborts the batch. */
const isItemError = (status: number): boolean => status === 400 || status === 422;

function parseSuccess(result: HttpResult, host: string): { raw: string; data: unknown } {
  let data: unknown;
  try {
    data = JSON.parse(result.body);
  } catch {
    throw new ApiError(`Unexpected response from ${host}: not valid JSON. (${result.status})`, result.status);
  }
  return { raw: result.body.trim(), data };
}

export type BatchEvent =
  | { readonly type: "data"; readonly item: string; readonly raw: string; readonly data: unknown }
  | { readonly type: "item-error"; readonly item: string; readonly error: ApiError };

/** One request per item, in order. Throws ApiError when a failure aborts the whole batch. */
export async function* requestEach(
  ctx: ApiContext,
  endpoint: string,
  items: readonly string[],
  payloadFor: (item: string) => Record<string, unknown>,
  verb: string,
): AsyncGenerator<BatchEvent> {
  for (const [index, item] of items.entries()) {
    if (items.length > 1) ctx.io.stderr(`${verb} ${index + 1}/${items.length}: ${item}\n`);
    const result = await ctx.client.post(endpoint, payloadFor(item));
    if (isItemError(result.status)) {
      yield { type: "item-error", item, error: new ApiError(describeFailure(result, ctx.host), result.status) };
      continue;
    }
    if (!isSuccess(result.status)) throw new ApiError(describeFailure(result, ctx.host), result.status);
    const { raw, data } = parseSuccess(result, ctx.host);
    yield { type: "data", item, raw, data };
  }
}
