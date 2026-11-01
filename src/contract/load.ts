import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';
import type { FieldError } from '../http/problem.ts';

export type RoleName = 'Representative' | 'Approver' | 'Operator';
export type HttpMethod = 'GET' | 'POST';
type Json = Record<string, unknown>;

export interface ParamSpec {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: Json;
}

export interface OperationSpec {
  operationId: string;
  method: HttpMethod;
  /** Contract path, for example `/cases/{caseId}`. */
  path: string;
  /** Functions route including the `api/` prefix. */
  route: string;
  /** `null` means anonymous (`security: []`). */
  roles: readonly RoleName[] | null;
  params: readonly ParamSpec[];
  bodySchema: Json | null;
  responses: ReadonlyMap<number, Json | null>;
}

export interface ParamInput {
  path: Record<string, string | undefined>;
  query: URLSearchParams;
  header: (name: string) => string | null;
}

export interface ParamValues {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  header: Record<string, unknown>;
}

export interface Contract {
  info: { title: string; version: string };
  operations: readonly OperationSpec[];
  byId: ReadonlyMap<string, OperationSpec>;
  document: unknown;
  validateBody(op: OperationSpec, value: unknown): FieldError[];
  validateParams(op: OperationSpec, input: ParamInput): { values: ParamValues; errors: FieldError[] };
  validateResponse(op: OperationSpec, status: number, value: unknown): FieldError[];
  /** Validates a value against a named `components.schemas` entry. */
  validateComponent(name: string, value: unknown): FieldError[];
}

const SCHEMAS_ID = 'urn:resolve:schemas';
const METHODS = ['get', 'post'] as const;
const ROLE_NAMES: readonly RoleName[] = ['Representative', 'Approver', 'Operator'];
const addFormats = addFormatsModule.default;

export function findAppRoot(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'host.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Application root (host.json) not found');
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (!isRecord(node)) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      out[key] = `${SCHEMAS_ID}#/$defs/${value.slice('#/components/schemas/'.length)}`;
    } else {
      out[key] = rewriteRefs(value);
    }
  }
  return out;
}

function resolveRef(document: Json, ref: string): Json {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
  let node: unknown = document;
  for (const part of ref.slice(2).split('/')) {
    if (!isRecord(node)) throw new Error(`Unresolvable $ref ${ref}`);
    node = node[part];
  }
  if (!isRecord(node)) throw new Error(`Unresolvable $ref ${ref}`);
  return node;
}

function deref(document: Json, node: Json): Json {
  return typeof node['$ref'] === 'string' ? resolveRef(document, node['$ref']) : node;
}

function contentSchema(document: Json, content: unknown, mediaType: string): Json | null {
  if (!isRecord(content)) return null;
  const media = content[mediaType];
  if (!isRecord(media) || !isRecord(media['schema'])) return null;
  return rewriteRefs(media['schema']) as Json;
}

function toFieldErrors(errors: readonly ErrorObject[] | null | undefined): FieldError[] {
  const seen = new Set<string>();
  const out: FieldError[] = [];
  for (const error of errors ?? []) {
    const missing = error.keyword === 'required' ? (error.params as { missingProperty?: string }).missingProperty : undefined;
    const extra =
      error.keyword === 'additionalProperties' ? (error.params as { additionalProperty?: string }).additionalProperty : undefined;
    const child = missing ?? extra;
    const pointer = `${error.instancePath}${child === undefined ? '' : `/${child}`}`.slice(0, 200) || '/';
    const code = error.keyword.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).slice(0, 60);
    const message = (extra === undefined ? (error.message ?? 'is invalid') : 'is not allowed').slice(0, 300);
    const signature = `${pointer}|${code}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({ pointer, code, message });
    if (out.length === 50) break;
  }
  return out;
}

function buildAjv(options: { coerce: boolean }): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
    coerceTypes: options.coerce,
    useDefaults: options.coerce,
  });
  addFormats(ajv);
  return ajv;
}

export function loadContract(root: string = findAppRoot()): Contract {
  const text = readFileSync(join(root, 'contracts', 'openapi.yaml'), 'utf8');
  const document = parse(text) as unknown;
  if (!isRecord(document) || !isRecord(document['paths']) || !isRecord(document['components'])) {
    throw new Error('Invalid OpenAPI document');
  }
  const info = document['info'] as { title: string; version: string };
  const components = document['components'];
  const schemas = isRecord(components['schemas']) ? components['schemas'] : {};
  const defs = rewriteRefs(schemas) as Json;

  const strictAjv = buildAjv({ coerce: false });
  strictAjv.addSchema({ $id: SCHEMAS_ID, $defs: defs });
  const paramAjv = buildAjv({ coerce: true });
  paramAjv.addSchema({ $id: SCHEMAS_ID, $defs: defs });

  const operations: OperationSpec[] = [];
  const globalSecurity = Array.isArray(document['security']) ? document['security'] : [];

  for (const [path, pathItemRaw] of Object.entries(document['paths'])) {
    if (!isRecord(pathItemRaw)) continue;
    const shared = Array.isArray(pathItemRaw['parameters']) ? (pathItemRaw['parameters'] as Json[]) : [];
    for (const method of METHODS) {
      const operation = pathItemRaw[method];
      if (!isRecord(operation)) continue;
      const operationId = operation['operationId'];
      if (typeof operationId !== 'string') throw new Error(`${method.toUpperCase()} ${path} has no operationId`);

      const own = Array.isArray(operation['parameters']) ? (operation['parameters'] as Json[]) : [];
      const params: ParamSpec[] = [...shared, ...own].map((raw) => {
        const param = deref(document, raw);
        return {
          name: param['name'] as string,
          in: param['in'] as ParamSpec['in'],
          required: param['required'] === true,
          schema: rewriteRefs(param['schema']) as Json,
        };
      });

      const security = 'security' in operation ? operation['security'] : globalSecurity;
      const anonymous = Array.isArray(security) && security.length === 0;
      let roles: RoleName[] | null = null;
      if (!anonymous) {
        const declared = operation['x-resolve-roles'];
        if (!Array.isArray(declared) || declared.length === 0 || declared.some((role) => !ROLE_NAMES.includes(role as RoleName))) {
          throw new Error(`${operationId} must declare x-resolve-roles`);
        }
        roles = declared as RoleName[];
      }

      const requestBody = isRecord(operation['requestBody']) ? operation['requestBody'] : undefined;
      const bodySchema = requestBody ? contentSchema(document, requestBody['content'], 'application/json') : null;

      const responses = new Map<number, Json | null>();
      for (const [status, raw] of Object.entries(isRecord(operation['responses']) ? operation['responses'] : {})) {
        if (!isRecord(raw)) continue;
        const response = deref(document, raw);
        const content = isRecord(response['content']) ? response['content'] : undefined;
        const mediaType = content && 'application/json' in content ? 'application/json' : 'application/problem+json';
        responses.set(Number(status), contentSchema(document, content, mediaType));
      }

      operations.push({
        operationId,
        method: method.toUpperCase() as HttpMethod,
        path,
        route: `api${path}`,
        roles,
        params,
        bodySchema,
        responses,
      });
    }
  }

  const byId = new Map(operations.map((op) => [op.operationId, op]));
  if (byId.size !== operations.length) throw new Error('Duplicate operationId in contract');

  const compiled = new Map<string, ValidateFunction>();
  const compile = (ajv: Ajv2020, key: string, schema: Json): ValidateFunction => {
    let validate = compiled.get(key);
    if (!validate) {
      validate = ajv.compile(schema);
      compiled.set(key, validate);
    }
    return validate;
  };

  return {
    info,
    operations,
    byId,
    document,

    validateBody(op, value) {
      if (!op.bodySchema) return [];
      const validate = compile(strictAjv, `${op.operationId}:body`, op.bodySchema);
      return validate(value) ? [] : toFieldErrors(validate.errors);
    },

    validateParams(op, input) {
      const values: ParamValues = { path: {}, query: {}, header: {} };
      const errors: FieldError[] = [];

      const pathParams = op.params.filter((p) => p.in === 'path');
      for (const param of pathParams) {
        const raw = input.path[param.name];
        if (raw !== undefined) values.path[param.name] = raw;
      }
      if (pathParams.length > 0) {
        const validate = compile(paramAjv, `${op.operationId}:path`, objectSchema(pathParams, false));
        if (!validate(values.path)) errors.push(...toFieldErrors(validate.errors).map((e) => ({ ...e, pointer: `/path${e.pointer}` })));
      }

      const queryParams = op.params.filter((p) => p.in === 'query');
      const seenKeys = new Set<string>();
      for (const key of input.query.keys()) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const all = input.query.getAll(key);
        if (all.length > 1) {
          errors.push({ pointer: `/query/${key}`.slice(0, 200), code: 'duplicate_parameter', message: 'must be given once' });
        } else {
          values.query[key] = all[0];
        }
      }
      const queryValidate = compile(paramAjv, `${op.operationId}:query`, objectSchema(queryParams, true));
      if (!queryValidate(values.query)) {
        errors.push(...toFieldErrors(queryValidate.errors).map((e) => ({ ...e, pointer: `/query${e.pointer === '/' ? '' : e.pointer}` })));
      }

      const headerParams = op.params.filter((p) => p.in === 'header');
      for (const param of headerParams) {
        const raw = input.header(param.name);
        if (raw !== null) values.header[param.name] = raw;
      }
      if (headerParams.length > 0) {
        const validate = compile(paramAjv, `${op.operationId}:header`, objectSchema(headerParams, false));
        if (!validate(values.header)) {
          errors.push(...toFieldErrors(validate.errors).map((e) => ({ ...e, pointer: `/header${e.pointer === '/' ? '' : e.pointer}` })));
        }
      }
      return { values, errors: errors.slice(0, 50) };
    },

    validateResponse(op, status, value) {
      if (!op.responses.has(status)) {
        return [{ pointer: '/', code: 'undeclared_status', message: `status ${status} is not declared for ${op.operationId}` }];
      }
      const schema = op.responses.get(status);
      if (!schema) return [];
      const validate = compile(strictAjv, `${op.operationId}:${status}`, schema);
      return validate(value) ? [] : toFieldErrors(validate.errors);
    },

    validateComponent(name, value) {
      if (!(name in schemas)) throw new Error(`Unknown component schema ${name}`);
      const validate = compile(strictAjv, `component:${name}`, { $ref: `${SCHEMAS_ID}#/$defs/${name}` });
      return validate(value) ? [] : toFieldErrors(validate.errors);
    },
  };
}

function objectSchema(params: readonly ParamSpec[], closed: boolean): Json {
  return {
    type: 'object',
    properties: Object.fromEntries(params.map((p) => [p.name, p.schema])),
    required: params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: !closed,
  };
}
