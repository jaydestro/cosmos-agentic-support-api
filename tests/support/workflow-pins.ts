import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

const FULL_REFERENCE = /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}$/;

export function validateWorkflowPins(document: unknown): string[] {
  const references: string[] = [];
  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      items.forEach((item, index) => visit(item, `${path}[${String(index)}]`));
    } else if (typeof value === 'object' && value !== null) {
      const entries: [string, unknown][] = Object.entries(value);
      for (const [key, child] of entries) {
        const location = `${path}.${key}`;
        if (key === 'uses') {
          if (typeof child !== 'string' || !FULL_REFERENCE.test(child)) {
            throw new Error(`${location} must reference an action or reusable workflow with a full 40-character commit SHA.`);
          }
          references.push(child);
        }
        visit(child, location);
      }
    }
  }
  visit(document, '$');
  return references;
}

export async function checkWorkflowPins(directory: string): Promise<{ files: number; references: string[] }> {
  const names = (await readdir(directory)).filter((name) => /\.(?:ya?ml|md)$/.test(name)).sort();
  const references: string[] = [];
  for (const name of names) {
    const content = await readFile(join(directory, name), 'utf8');
    const yaml = name.endsWith('.md') ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] : content;
    if (yaml === undefined) throw new Error(`${name} is missing agentic-workflow frontmatter.`);
    const document: unknown = parse(yaml);
    try {
      references.push(...validateWorkflowPins(document));
    } catch (cause) {
      throw new Error(`Workflow pin validation failed in ${name}.`, { cause });
    }
  }
  if (names.length === 0 || references.length === 0) throw new Error('No executable workflow references were checked.');
  return { files: names.length, references };
}
