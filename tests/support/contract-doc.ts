import { loadContract } from '../../src/contract/load.ts';

/** The parts of an OpenAPI schema node that the console's constants are checked against. */
export interface SchemaNode {
  readonly type?: string | readonly string[];
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly minProperties?: number;
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
}

interface ContractDocument {
  readonly components: {
    readonly schemas: Readonly<Record<string, SchemaNode>>;
    readonly parameters: Readonly<Record<string, { readonly schema: SchemaNode }>>;
  };
}

const document = loadContract().document as ContractDocument;

export function schema(name: string): SchemaNode {
  const node = document.components.schemas[name];
  if (node === undefined) throw new Error(`The contract has no schema ${name}.`);
  return node;
}

export function property(schemaName: string, key: string): SchemaNode {
  const node = schema(schemaName).properties?.[key];
  if (node === undefined) throw new Error(`The contract schema ${schemaName} has no property ${key}.`);
  return node;
}

export function schemaEnum(name: string): readonly string[] {
  const values = schema(name).enum;
  if (values === undefined) throw new Error(`The contract schema ${name} is not an enum.`);
  return values;
}

export function parameterSchema(name: string): SchemaNode {
  const node = document.components.parameters[name];
  if (node === undefined) throw new Error(`The contract has no parameter ${name}.`);
  return node.schema;
}

/**
 * The values the contract lists in the prose of an open-set property: the text after "Known values:" up to
 * "Clients must tolerate". The contract describes them in a description rather than an enum so that adding one
 * is not a breaking change.
 */
function documentedKnownValues(schemaName: string, key: string): string[] {
  const description = property(schemaName, key).description ?? '';
  const start = description.indexOf('Known values:');
  const end = description.indexOf('Clients must tolerate');
  if (start < 0 || end < 0 || end <= start) throw new Error(`The ${schemaName}.${key} description no longer lists its known values.`);
  return description
    .slice(start + 'Known values:'.length, end)
    .replace(/\s+/g, ' ')
    .replace(/\.\s*$/, '')
    .trim()
    .split(',')
    .map((value) => value.trim().replace(/\.$/, ''))
    .filter((value) => value !== '');
}

/** The kinds the contract lists for `TimelineItem.kind`. */
export function documentedTimelineKinds(): string[] {
  return documentedKnownValues('TimelineItem', 'kind');
}

/** The reasons the contract lists for `Run.stopReason`. */
export function documentedStopReasons(): string[] {
  return documentedKnownValues('Run', 'stopReason');
}
