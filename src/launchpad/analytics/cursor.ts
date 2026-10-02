import { keccak256, stringToHex } from "viem";
import { ServiceError } from "../../core.js";
import type { Hex } from "./types.js";

export interface CursorPosition {
  block_number: number;
  block_hash: Hex;
  offset: number;
}

interface CursorBody extends CursorPosition {
  v: 1;
  list: string;
  query: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint of the query a cursor belongs to, so it cannot be replayed against another. */
export function queryFingerprint(query: unknown): string {
  return keccak256(stringToHex(stableJson(query))).slice(0, 18);
}

function toBase64Url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function encodeCursor(
  list: string,
  query: unknown,
  position: CursorPosition,
): string {
  const body: CursorBody = {
    v: 1,
    list,
    query: queryFingerprint(query),
    ...position,
  };
  return toBase64Url(JSON.stringify(body));
}

function invalid(): ServiceError {
  return new ServiceError(
    "invalid_cursor",
    "The cursor is malformed or belongs to a different query. Repeat the request without a cursor.",
  );
}

function parseBody(cursor: string): CursorBody {
  try {
    return JSON.parse(fromBase64Url(cursor)) as CursorBody;
  } catch {
    throw invalid();
  }
}

export function decodeCursor(
  cursor: string,
  list: string,
  query: unknown,
): CursorPosition {
  const body = parseBody(cursor);
  const valid =
    body.v === 1 &&
    body.list === list &&
    body.query === queryFingerprint(query) &&
    Number.isSafeInteger(body.block_number) &&
    Number.isSafeInteger(body.offset) &&
    body.offset >= 0 &&
    /^0x[0-9a-f]{64}$/.test(body.block_hash);
  if (!valid) throw invalid();
  return {
    block_number: body.block_number,
    block_hash: body.block_hash,
    offset: body.offset,
  };
}

export function staleCursor(
  position: CursorPosition,
  canonicalHash: Hex | null,
): ServiceError {
  return new ServiceError(
    "stale_cursor",
    `The cursor is bound to block ${position.block_number} (${position.block_hash}), which is no longer canonical. Restart the listing without a cursor.`,
    {
      block_number: position.block_number,
      cursor_block_hash: position.block_hash,
      canonical_block_hash: canonicalHash,
    },
  );
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
  total: number;
}

export function paginate<T>(
  items: readonly T[],
  pageSize: number,
  offset: number,
  next: (offset: number) => string,
): Page<T> {
  const end = offset + pageSize;
  return {
    items: items.slice(offset, end),
    cursor: end < items.length ? next(end) : null,
    total: items.length,
  };
}
