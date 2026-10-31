/** Everything shown by the console is built from text nodes and elements. HTML strings are never parsed. */
export type Child = Node | string | number | null | undefined | false | readonly Child[];
export type AttrValue = string | number | boolean | null | undefined | ((event: Event) => void);
export type Attrs = Readonly<Record<string, AttrValue>>;

/** The page CSP forbids inline styles, and these names would let markup be injected. */
const FORBIDDEN = new Set(['style', 'srcdoc', 'innerhtml', 'outerhtml']);

/** Set after the children exist, because a select's value needs its options first. */
const PROPERTIES = new Set(['value', 'checked', 'selected']);

function appendChildren(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) parent.appendChild(child);
    else if (typeof child === 'string' || typeof child === 'number') parent.appendChild(document.createTextNode(String(child)));
    else appendChildren(parent, child);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  const properties: [string, string | number | boolean][] = [];
  for (const [name, value] of Object.entries(attrs ?? {})) {
    const lower = name.toLowerCase();
    if (FORBIDDEN.has(lower)) throw new Error(`The ${name} attribute is not allowed.`);
    if (lower.startsWith('on')) {
      if (typeof value !== 'function') throw new Error(`${name} must be a function.`);
      element.addEventListener(lower.slice(2), value);
      continue;
    }
    if (typeof value === 'function') throw new Error(`${name} cannot be a function.`);
    if (value === null || value === undefined || value === false) continue;
    if (PROPERTIES.has(name)) properties.push([name, value]);
    else if (name === 'class') element.className = String(value);
    else element.setAttribute(name, value === true ? '' : String(value));
  }
  appendChildren(element, children);
  for (const [name, value] of properties) Reflect.set(element, name, name === 'value' ? String(value) : value);
  return element;
}

/** Replaces everything inside `parent`. */
export function replaceContent(parent: Element, ...children: Child[]): void {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  parent.replaceChildren(fragment);
}

/** Replaces the content only when `key` changed, so typing and focus survive a refresh that changed nothing. */
export function keyedRegion(parent: Element): (key: string, render: () => Child) => boolean {
  let last: string | null = null;
  return (key, render) => {
    if (key === last) return false;
    last = key;
    replaceContent(parent, render());
    return true;
  };
}

export function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  return h('button', { type: 'button', ...attrs, onclick: onClick }, label);
}

/** Resolves after `ms`, or rejects with an AbortError when `signal` aborts first. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
