import { ApiErrorResponseSchema } from "@/schemas/api";
import { z, type ZodType } from "zod";

import { camelizeKeys, snakifyKeys, snakifyQueryKeys } from "@/lib/casing";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type RequestOptions = {
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  suppressUnauthorizedHandler?: boolean;
  /**
   * Skip the snake_case <-> camelCase key conversion for this call (request body,
   * query string and response). Use it when object keys are data rather than field
   * names, e.g. free-form header maps or model-name-keyed maps.
   */
  rawKeys?: boolean;
};

const JSON_CONTENT_TYPE = "application/json";
const EMPTY_RESPONSE_STATUS = new Set([204, 205]);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly payload: unknown;

  constructor(params: {
    message: string;
    status: number;
    code: string;
    details?: unknown;
    payload?: unknown;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
    this.payload = params.payload;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof ReadableStream
  );
}

function buildRequestBody(body: unknown): {
  body?: BodyInit;
  contentType?: string;
} {
  if (body === undefined || body === null) {
    return {};
  }
  if (isBodyInit(body)) {
    return { body };
  }
  return {
    body: JSON.stringify(body),
    contentType: JSON_CONTENT_TYPE,
  };
}

async function readJsonPayload(response: Response): Promise<unknown> {
  if (EMPTY_RESPONSE_STATUS.has(response.status)) {
    return undefined;
  }
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const FastApiErrorSchema = z.object({
  detail: z.union([
    z.string(),
    z.array(z.looseObject({ msg: z.string().optional(), loc: z.array(z.unknown()).optional() })),
    z.unknown(),
  ]),
});

function formatFastApiDetail(detail: unknown): string | null {
  if (typeof detail === "string") {
    return detail.length > 0 ? detail : null;
  }
  if (Array.isArray(detail)) {
    // FastAPI 422: [{loc: ["body", "password"], msg: "..."}]
    const messages = detail
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as { msg?: unknown; loc?: unknown };
        if (typeof record.msg !== "string") return null;
        const field = Array.isArray(record.loc) ? record.loc.filter((part) => part !== "body").join(".") : "";
        return field ? `${field}: ${record.msg}` : record.msg;
      })
      .filter((message): message is string => !!message);
    return messages.length > 0 ? messages.join("; ") : null;
  }
  return null;
}

function parseApiErrorPayload(
  payload: unknown,
  status: number,
): {
  code: string;
  message: string;
  details: unknown;
} {
  // claude-lb management routes use FastAPI's `{"detail": ...}` envelope.
  const fastApi = FastApiErrorSchema.safeParse(payload);
  if (fastApi.success) {
    const message = formatFastApiDetail(fastApi.data.detail);
    if (message) {
      return { code: `http_${status}`, message, details: fastApi.data.detail };
    }
  }

  const parsed = ApiErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      code: "request_failed",
      message: "Request failed",
      details: payload,
    };
  }

  const error = parsed.data.error;
  const code =
    typeof error.code === "string" && error.code.length > 0 ? error.code : "request_failed";
  const message =
    typeof error.message === "string" && error.message.length > 0
      ? error.message
      : "Request failed";

  return {
    code,
    message,
    details: error,
  };
}

async function request(
  method: HttpMethod,
  url: string,
  schema: null,
  options?: RequestOptions,
): Promise<void>;
async function request<T>(
  method: HttpMethod,
  url: string,
  schema: ZodType<T>,
  options?: RequestOptions,
): Promise<T>;
async function request<T>(
  method: HttpMethod,
  url: string,
  schema: ZodType<T> | null,
  options?: RequestOptions,
): Promise<T | void> {
  const convertKeys = !options?.rawKeys;
  const requestBody = buildRequestBody(
    convertKeys && options?.body !== undefined && !isBodyInit(options.body)
      ? snakifyKeys(options.body)
      : options?.body,
  );
  const requestUrl = convertKeys ? snakifyQueryKeys(url) : url;
  const headers = new Headers(options?.headers);
  if (requestBody.contentType && !headers.has("Content-Type")) {
    headers.set("Content-Type", requestBody.contentType);
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", JSON_CONTENT_TYPE);
  }

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method,
      body: requestBody.body,
      headers,
      signal: options?.signal,
      credentials: options?.credentials ?? "same-origin",
      cache: options?.cache,
    });
  } catch (error) {
    throw new ApiError({
      status: 0,
      code: "network_error",
      message: error instanceof Error ? error.message : "Network request failed",
      details: error,
    });
  }

  if (response.status === 401 && !options?.suppressUnauthorizedHandler) {
    unauthorizedHandler?.();
  }

  const rawPayload = await readJsonPayload(response);
  if (!response.ok) {
    const parsedError = parseApiErrorPayload(rawPayload, response.status);
    throw new ApiError({
      status: response.status,
      code: parsedError.code,
      message: parsedError.message,
      details: parsedError.details,
      payload: rawPayload,
    });
  }

  if (schema === null) {
    return undefined;
  }

  const payload = convertKeys ? camelizeKeys(rawPayload) : rawPayload;

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    if (import.meta.env.DEV) {
      console.error(`Zod schema mismatch for ${method} ${url}`, parsed.error.format(), payload);
    }
    throw new ApiError({
      status: response.status,
      code: "invalid_response_schema",
      message: "Response schema mismatch",
      details: parsed.error.format(),
      payload,
    });
  }

  return parsed.data;
}

export function get<T>(
  url: string,
  schema: ZodType<T>,
  options?: RequestOptions,
): Promise<T> {
  return request("GET", url, schema, options);
}

export function post(url: string, schema: null, options?: RequestOptions): Promise<void>;
export function post<T>(url: string, schema: ZodType<T>, options?: RequestOptions): Promise<T>;
export function post<T>(
  url: string,
  schema: ZodType<T> | null,
  options?: RequestOptions,
): Promise<T | void> {
  return schema === null ? request("POST", url, null, options) : request("POST", url, schema, options);
}

export function patch(url: string, schema: null, options?: RequestOptions): Promise<void>;
export function patch<T>(url: string, schema: ZodType<T>, options?: RequestOptions): Promise<T>;
export function patch<T>(
  url: string,
  schema: ZodType<T> | null,
  options?: RequestOptions,
): Promise<T | void> {
  return schema === null ? request("PATCH", url, null, options) : request("PATCH", url, schema, options);
}

export function put(url: string, schema: null, options?: RequestOptions): Promise<void>;
export function put<T>(url: string, schema: ZodType<T>, options?: RequestOptions): Promise<T>;
export function put<T>(
  url: string,
  schema: ZodType<T> | null,
  options?: RequestOptions,
): Promise<T | void> {
  return schema === null ? request("PUT", url, null, options) : request("PUT", url, schema, options);
}

export function del(
  url: string,
  options?: RequestOptions,
): Promise<void>;
export function del<T>(
  url: string,
  schema: ZodType<T>,
  options?: RequestOptions,
): Promise<T>;
export function del<T>(
  url: string,
  schemaOrOptions?: ZodType<T> | RequestOptions,
  maybeOptions?: RequestOptions,
): Promise<T | void> {
  if (schemaOrOptions instanceof z.ZodType) {
    return request("DELETE", url, schemaOrOptions, maybeOptions);
  }
  return request("DELETE", url, null, schemaOrOptions);
}
