import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";


type JsonSchema = Record<string, unknown>;

const ANNOTATION_DEFAULTS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

type Annotations = Partial<Record<keyof typeof ANNOTATION_DEFAULTS, boolean>>;

const TYPED_KEYWORDS = new Set([
  "type",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "format",
  "items",
  "minItems",
  "maxItems",
  "properties",
  "required",
  "additionalProperties",
]);

function isTypedBranch(value: unknown): value is JsonSchema {
  return (
    isObject(value) &&
    "type" in value &&
    Object.keys(value).every((key) => TYPED_KEYWORDS.has(key))
  );
}

function typeList(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [value as string];
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenAnyOf(branches: unknown[]): unknown[] {
  return branches.flatMap((branch) =>
    isObject(branch) && Object.keys(branch).length === 1 && Array.isArray(branch.anyOf)
      ? (branch.anyOf as unknown[])
      : [branch],
  );
}

function absorbBranch(merged: JsonSchema, types: string[], branch: JsonSchema): boolean {
  for (const type of typeList(branch.type)) {
    if (!types.includes(type)) types.push(type);
  }
  for (const [key, value] of Object.entries(branch)) {
    if (key === "type") continue;
    if (key in merged && merged[key] !== value) return false;
    merged[key] = value;
  }
  return true;
}

function mergeAnyOf(branches: unknown[]): JsonSchema | null {
  const flat = flattenAnyOf(branches);
  if (!flat.every(isTypedBranch)) return null;
  const merged: JsonSchema = {};
  const types: string[] = [];
  if (!flat.every((branch) => absorbBranch(merged, types, branch))) return null;
  if (types.includes("integer") && types.includes("number")) return null;
  return { type: types.length === 1 ? types[0] : types, ...merged };
}

const ARTIFACT_REFERENCE_OUTPUT = {
  type: "object",
  description: "artifact_reference; pass unchanged",
} as const;

const SUMMARY_KEY = "x-catalog-summary";

export function catalogSummary<T extends z.ZodType>(schema: T, summary: string): T {
  return schema.meta({ [SUMMARY_KEY]: summary });
}

function summarize(value: JsonSchema): JsonSchema | null {
  const summary = value[SUMMARY_KEY];
  if (typeof summary !== "string") return null;
  return { type: value.type ?? "object", description: joinDescriptions(value.description, summary) };
}

function joinDescriptions(first: unknown, second: string): string {
  return typeof first === "string" ? `${first.replace(/\.$/, "")}. ${second}` : second;
}

function isArtifactReference(value: object): boolean {
  const properties = (value as JsonSchema).properties as
    | Record<string, { const?: unknown }>
    | undefined;
  return properties?.kind?.const === "artifact_reference";
}

const PATTERN_LABELS: Readonly<Record<string, string>> = {
  "^0x[0-9a-fA-F]{40}$": "address",
  "^0x[0-9a-fA-F]{1,40}$": "address",
  "^(?:0|[1-9][0-9]*)$": "decimal integer",
  "^(0|[1-9][0-9]*)$": "decimal integer",
  "^[0-9]*[1-9][0-9]*$": "positive decimal integer",
  "^[1-9][0-9]*$": "positive decimal integer",
  "^-?(?:0|[1-9][0-9]*)$": "signed decimal integer",
  "^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$": "decimal or 0x-hex integer",
  "^(?:[1-9][0-9]*|0x[0-9a-fA-F]+)$": "",
  "^0x[0-9a-fA-F]{64}$": "bytes32 hex",
  "^0x[0-9a-fA-F]+$": "hex",
  "^0x(?:[0-9a-fA-F]{2})*$": "hex bytes",
};

export function labelPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(labelPatterns);
  if (typeof value !== "object" || value === null) return value;
  const schema: JsonSchema = {};
  for (const [key, entry] of Object.entries(value)) schema[key] = labelPatterns(entry);
  const label =
    typeof schema.pattern === "string" ? PATTERN_LABELS[schema.pattern] : undefined;
  if (label === undefined) return schema;
  const { pattern: _pattern, ...rest } = schema;
  if (label === "") return rest;
  if (typeof rest.description === "string") {
    return rest.description.includes(label)
      ? rest
      : { ...rest, description: `${rest.description} (${label})` };
  }
  return { ...rest, description: label };
}

const isServerLimit = (entry: unknown) => typeof entry === "number" && Math.abs(entry) >= 100_000;
const isLengthLimit = (entry: unknown) => typeof entry === "number" && entry >= 64;

const NOISE: Readonly<Record<string, (entry: unknown, output: boolean) => boolean>> = {
  $schema: () => true,
  additionalProperties: (entry, output) =>
    output || entry === true || (isObject(entry) && Object.keys(entry).length === 0),
  required: (_entry, output) => output,
  propertyNames: (entry) =>
    isObject(entry) && Object.keys(entry).length === 1 && entry.type === "string",
  minimum: isServerLimit,
  maximum: isServerLimit,
  maxItems: () => true,
  maxLength: isLengthLimit,
  pattern: (_entry, output) => output,
};

function isNoise(key: string, entry: unknown, output: boolean): boolean {
  return Object.hasOwn(NOISE, key) && NOISE[key]!(entry, output);
}

export function compactSchema(value: unknown, output = false): unknown {
  if (Array.isArray(value)) return value.map((item) => compactSchema(item, output));
  if (!isObject(value)) return value;
  if (output && isArtifactReference(value)) return ARTIFACT_REFERENCE_OUTPUT;
  const summary = summarize(value);
  if (summary !== null) return summary;
  const out: JsonSchema = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isNoise(key, entry, output)) continue;
    out[key] = compactSchema(entry, output);
  }
  return Array.isArray(out.anyOf) ? compactAnyOf(out, out.anyOf) : out;
}

function compactAnyOf(schema: JsonSchema, branches: unknown[]): JsonSchema {
  const { anyOf: _anyOf, ...rest } = schema;
  const merged = mergeAnyOf(branches);
  if (merged !== null) return { ...merged, ...rest };
  const nullable = mergeNullableSummary(branches, schema.description);
  return nullable === null ? schema : { ...rest, ...nullable };
}

function mergeNullableSummary(branches: unknown[], description: unknown): JsonSchema | null {
  if (branches.length !== 2) return null;
  const summary = branches.find(
    (branch) => isObject(branch) && typeof branch.description === "string" && branch.type === "object",
  ) as JsonSchema | undefined;
  const nullable = branches.some(
    (branch) => isObject(branch) && Object.keys(branch).length === 1 && branch.type === "null",
  );
  if (summary === undefined || !nullable || Object.keys(summary).length !== 2) return null;
  return {
    type: ["object", "null"],
    description: joinDescriptions(description, summary.description as string),
  };
}

export function compactAnnotations(annotations: Annotations | undefined): Annotations | undefined {
  if (annotations === undefined) return undefined;
  const out: Annotations = {};
  for (const key of Object.keys(ANNOTATION_DEFAULTS) as (keyof typeof ANNOTATION_DEFAULTS)[]) {
    if (annotations.readOnlyHint === true && (key === "destructiveHint" || key === "idempotentHint")) {
      continue;
    }
    if (annotations[key] !== undefined && annotations[key] !== ANNOTATION_DEFAULTS[key]) {
      out[key] = annotations[key];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type RegisteredToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: Annotations;
};

type ObjectSchema = { type: "object"; [key: string]: unknown };

// Converting a zod schema and compacting it is most of the CPU of tools/list,
// and the result depends only on the schema object, which is never changed
// after it is built. Each schema is therefore converted once per isolate and
// keyed by identity, so a schema built per request simply misses. Entries are
// frozen: no caller can alter what a later request publishes.
const objectSchemaCache = {
  input: new WeakMap<z.ZodType, ObjectSchema>(),
  output: new WeakMap<z.ZodType, ObjectSchema>(),
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function objectSchema(schema: z.ZodType | undefined, io: "input" | "output"): ObjectSchema {
  if (schema === undefined) return { type: "object", properties: {} };
  const cached = objectSchemaCache[io].get(schema);
  if (cached !== undefined) return cached;
  const compact = compactSchema(z.toJSONSchema(schema, { io }), io === "output");
  const { type: _type, ...json } = (io === "input" ? labelPatterns(compact) : compact) as JsonSchema;
  const converted = deepFreeze<ObjectSchema>({ type: "object", ...json });
  objectSchemaCache[io].set(schema, converted);
  return converted;
}

export function compactTool(name: string, config: RegisteredToolConfig) {
  const annotations = compactAnnotations(config.annotations);
  return {
    name,
    ...(config.title === undefined ? {} : { title: config.title }),
    ...(config.description === undefined ? {} : { description: config.description }),
    inputSchema: objectSchema(config.inputSchema, "input"),
    ...(config.outputSchema === undefined
      ? {}
      : { outputSchema: objectSchema(config.outputSchema, "output") }),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

export function publishCompactCatalog(
  server: McpServer,
  tools: ReadonlyMap<string, RegisteredToolConfig>,
) {
  server.server.setRequestHandler("tools/list", () => ({
    tools: [...tools].map(([name, config]) => compactTool(name, config)),
  }));
}
