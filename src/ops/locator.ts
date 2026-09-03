/**
 * Locators expressed the way a durable test can express them.
 *
 * Everywhere else in browserd an element is addressed by CSS, XPath, visible
 * text or a snapshot ref. That is right for driving a page and wrong for
 * writing a test: a CSS selector encodes today's DOM shape, so the test breaks
 * on a refactor that changed nothing a user can see. Test harnesses built on
 * Playwright - Auto-QA among them - therefore accept only user-facing locators:
 * role plus accessible name, label, text, or test id.
 *
 * An agent exploring with browserd and then authoring such a test has to guess
 * the semantic locator for an element it found by selector, and only learns
 * whether the guess was right after compiling and running. These two ops close
 * that loop in the browser, where the answer is knowable:
 *
 *   locator.candidates  an element  -> the semantic locators that address it
 *   locator.check       a locator   -> what it actually resolves to, right now
 *
 * Both report how many elements each locator matches, because that number is
 * what decides whether a test is durable. Playwright's strict mode fails on
 * more than one match, and the usual escapes - .first(), .nth(0) - weaken the
 * assertion to "one of these exists somewhere". The honest fix is to scope the
 * locator to the landmark it lives in, so `within` is computed here rather than
 * left to the caller to guess.
 *
 * FIDELITY. Roles and accessible names come from Chrome's own accessibility
 * tree, which is what Playwright's role engine models but not the same
 * implementation, so a count is a strong signal and not a proof. Text, label
 * and test-id counts are computed in the page against Playwright's documented
 * matching rules. Compiling and running the test remains the only proof.
 */
import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import type { AXNode } from '../cdp/types.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { evaluate, resolveElement } from './element.js';
import type { ElementLocator } from './element.js';

/**
 * Roles a scenario target may name.
 *
 * Deliberately a closed list rather than every ARIA role: it mirrors the roles
 * a Playwright-based harness schema accepts, so a candidate offered here is
 * always one the harness can actually express. A role outside the list is
 * reported as unusable rather than silently offered.
 */
const TARGET_ROLES = new Set([
  'alert',
  'button',
  'checkbox',
  'combobox',
  'dialog',
  'heading',
  'img',
  'link',
  'list',
  'listitem',
  'option',
  'radio',
  'searchbox',
  'status',
  'switch',
  'tab',
  'textbox',
]);

/** Landmarks additionally allowed as a scope, on top of every TARGET_ROLES entry. */
const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'contentinfo', 'region', 'form']);

const canScope = (role: string): boolean => TARGET_ROLES.has(role) || LANDMARK_ROLES.has(role);

export interface SemanticTarget {
  by: 'role' | 'label' | 'text' | 'testId';
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testId?: string;
  exact?: boolean;
  within?: { role: string; name?: string };
}

async function pageOf(
  ctx: OpsContext,
  args: { browser_id?: string; target_id?: string },
): Promise<{ instance: BrowserInstance; target: ManagedTarget }> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = await instance.resolvePageOrOpen(args.target_id);
  return { instance, target };
}

/* ------------------------------ name matching ----------------------------- */

/**
 * Playwright normalises whitespace on both sides of every text comparison,
 * including under `exact`, so the same normalisation is applied here before
 * anything is compared.
 */
const normalise = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * `exact: false` (the default) is a case-insensitive substring test;
 * `exact: true` is case-sensitive and whole-string. This is Playwright's
 * documented rule for getByRole's name, getByText and getByLabel alike, and
 * getting it wrong here would produce match counts that disagree with the
 * generated test - the one failure this whole module exists to prevent.
 */
function nameMatches(actual: string, wanted: string, exact: boolean): boolean {
  const a = normalise(actual);
  const w = normalise(wanted);
  return exact ? a === w : a.toLowerCase().includes(w.toLowerCase());
}

/* --------------------------- accessibility tree --------------------------- */

interface AxIndex {
  nodes: AXNode[];
  byId: Map<string, AXNode>;
  byBackendId: Map<number, AXNode>;
  parentOf: Map<string, string>;
}

async function axIndex(target: ManagedTarget): Promise<AxIndex> {
  await target.session.trySend('Accessibility.enable');
  const { nodes } = await target.session.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');

  const byId = new Map<string, AXNode>();
  const byBackendId = new Map<number, AXNode>();
  const parentOf = new Map<string, string>();

  for (const node of nodes) {
    byId.set(node.nodeId, node);
    // The first node wins: a backend node can appear more than once, and the
    // earlier entry is the one nearer the document root.
    if (node.backendDOMNodeId !== undefined && !byBackendId.has(node.backendDOMNodeId)) {
      byBackendId.set(node.backendDOMNodeId, node);
    }
  }
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) parentOf.set(childId, node.nodeId);
  }

  return { nodes, byId, byBackendId, parentOf };
}

const axRole = (node: AXNode): string => String(node.role?.value ?? '');
const axName = (node: AXNode): string => normalise(node.name?.value);

/** Every node in the subtree rooted at `nodeId`, the root itself excluded. */
function subtreeOf(index: AxIndex, nodeId: string): AXNode[] {
  const out: AXNode[] = [];
  const stack = [...(index.byId.get(nodeId)?.childIds ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = index.byId.get(id);
    if (!node) continue;
    out.push(node);
    for (const childId of node.childIds ?? []) stack.push(childId);
  }
  return out;
}

/** Ancestors of a node, nearest first. */
function ancestorsOf(index: AxIndex, nodeId: string): AXNode[] {
  const out: AXNode[] = [];
  let current = index.parentOf.get(nodeId);
  while (current !== undefined) {
    const node = index.byId.get(current);
    if (node) out.push(node);
    current = index.parentOf.get(current);
  }
  return out;
}

function countRole(
  index: AxIndex,
  scopeNodeId: string | undefined,
  role: string,
  name: string,
  exact: boolean,
): AXNode[] {
  const pool = scopeNodeId === undefined ? index.nodes : subtreeOf(index, scopeNodeId);
  return pool.filter(
    (node) => !node.ignored && axRole(node) === role && nameMatches(axName(node), name, exact),
  );
}

/* ------------------------------ page-side work ---------------------------- */

/**
 * What the element offers as a non-role locator.
 *
 * Read in the page rather than from the accessibility tree because these are
 * DOM facts: a test id is an attribute, and Playwright derives getByLabel from
 * the label association, not from the computed accessible name.
 */
const ELEMENT_FACTS_FN = `function (attribute) {
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const el = this;

  const labelText = () => {
    const by = el.getAttribute && el.getAttribute('aria-labelledby');
    if (by) {
      const joined = by.split(/\\s+/)
        .map((id) => { const n = el.ownerDocument.getElementById(id); return n ? n.textContent : ''; })
        .join(' ');
      if (norm(joined)) return norm(joined);
    }
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (norm(aria)) return norm(aria);
    if (el.labels && el.labels.length > 0) {
      return norm(Array.from(el.labels).map((l) => l.textContent).join(' '));
    }
    return '';
  };

  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const isValueButton = tag === 'input' && (el.type === 'button' || el.type === 'submit');

  return {
    tag,
    type: el.getAttribute ? el.getAttribute('type') : null,
    test_id: el.getAttribute ? el.getAttribute(attribute) : null,
    label: labelText(),
    text: norm(isValueButton ? el.value : el.textContent),
    visible: !!(el.getClientRects && el.getClientRects().length > 0),
  };
}`;

/**
 * Count the elements a text, label or test-id locator matches inside `this`.
 *
 * `this` is the document for an unscoped locator, or the scope element when the
 * locator carries a `within`. Only descendants are considered, which is how a
 * chained Playwright locator behaves.
 */
const COUNT_FN = `function (specJson) {
  const spec = JSON.parse(specJson);
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const hit = (actual) => {
    const a = norm(actual);
    const w = norm(spec.value);
    return spec.exact ? a === w : a.toLowerCase().indexOf(w.toLowerCase()) !== -1;
  };

  const all = [];
  const walk = (root) => {
    const found = root.querySelectorAll('*');
    for (const el of found) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
  };
  walk(this);

  const elementText = (el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    // Playwright matches button and submit inputs by their value, not their
    // (empty) text content.
    if (tag === 'input' && (el.type === 'button' || el.type === 'submit')) return el.value || '';
    if (tag === 'script' || tag === 'style') return '';
    return el.textContent || '';
  };

  const labelText = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const joined = by.split(/\\s+/)
        .map((id) => { const n = el.ownerDocument.getElementById(id); return n ? n.textContent : ''; })
        .join(' ');
      if (norm(joined)) return norm(joined);
    }
    const aria = el.getAttribute('aria-label');
    if (norm(aria)) return norm(aria);
    if (el.labels && el.labels.length > 0) {
      return norm(Array.from(el.labels).map((l) => l.textContent).join(' '));
    }
    return '';
  };

  let matched = [];
  if (spec.kind === 'testId') {
    // getByTestId compares the attribute value exactly.
    matched = all.filter((el) => el.getAttribute(spec.attribute) === spec.value);
  } else if (spec.kind === 'label') {
    matched = all.filter((el) => {
      const labelable = el.labels !== undefined || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
      return labelable && hit(labelText(el));
    });
  } else {
    const candidates = all.filter((el) => hit(elementText(el)));
    // The text engine resolves to the smallest element containing the text, so
    // an ancestor that only matches through this same descendant is not a match.
    matched = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  }

  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean)[0];
    return '<' + el.tagName.toLowerCase() + id + (cls && !id ? '.' + cls : '') + '>';
  };

  return { count: matched.length, samples: matched.slice(0, 5).map(describe) };
}`;

interface CountResult {
  count: number;
  samples: string[];
}

/** Run COUNT_FN against a scope object (the document, or a scope element). */
async function countInPage(
  target: ManagedTarget,
  scopeObjectId: string,
  spec: { kind: 'testId' | 'label' | 'text'; value: string; exact: boolean; attribute: string },
): Promise<CountResult> {
  const response = await target.session.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
    objectId: scopeObjectId,
    returnByValue: true,
    functionDeclaration: COUNT_FN,
    arguments: [{ value: JSON.stringify(spec) }],
  });
  const value = (response.result.value ?? {}) as Partial<CountResult>;
  return { count: Number(value.count ?? 0), samples: value.samples ?? [] };
}

/** An objectId for `document`, used as the scope of an unscoped locator. */
async function documentObjectId(instance: BrowserInstance, target: ManagedTarget): Promise<string> {
  const { result } = await evaluate(instance, target, {
    expression: 'document',
    returnByValue: false,
    awaitPromise: false,
  });
  if (!result.objectId) {
    throw new AgentBrowserError('no_document', 'The page has no document to query. Navigate first.');
  }
  return result.objectId;
}

/* -------------------------- rendering for humans -------------------------- */

const quote = (value: string): string => JSON.stringify(value);

/** The Playwright expression this target compiles to, so it can be read by eye. */
export function playwrightExpression(target: SemanticTarget): string {
  const root = target.within
    ? `page.getByRole(${quote(target.within.role)}${
        target.within.name ? `, { name: ${quote(target.within.name)} }` : ''
      })`
    : 'page';

  switch (target.by) {
    case 'role': {
      const options = [`name: ${quote(target.name ?? '')}`, target.exact ? 'exact: true' : undefined]
        .filter(Boolean)
        .join(', ');
      return `${root}.getByRole(${quote(target.role ?? '')}, { ${options} })`;
    }
    case 'label':
      return `${root}.getByLabel(${quote(target.label ?? '')}${target.exact ? ', { exact: true }' : ''})`;
    case 'text':
      return `${root}.getByText(${quote(target.text ?? '')}${target.exact ? ', { exact: true }' : ''})`;
    case 'testId':
      return `${root}.getByTestId(${quote(target.testId ?? '')})`;
  }
}

/* --------------------------------- scoping -------------------------------- */

interface ScopeChoice {
  within: { role: string; name?: string };
  ax_node_id: string;
  backend_node_id?: number;
}

/**
 * Landmark ancestors that could legally scope a locator, nearest first.
 *
 * Only scopes that are themselves unique are returned, and skipping that check
 * is the classic mistake: a scope matching two navigations fails Playwright's
 * strict mode before the inner locator is ever evaluated, so a caller that only
 * verified the inner count would ship a test that cannot run.
 */
function viableScopes(index: AxIndex, elementNode: AXNode): ScopeChoice[] {
  const out: ScopeChoice[] = [];
  for (const ancestor of ancestorsOf(index, elementNode.nodeId)) {
    const role = axRole(ancestor);
    if (!canScope(role) || ancestor.ignored) continue;

    const name = axName(ancestor);
    // Prefer the named form: it survives a second landmark of the same role
    // appearing later. Fall back to the bare role when the landmark is unnamed.
    const forms: Array<{ role: string; name?: string }> = name
      ? [{ role, name }, { role }]
      : [{ role }];

    for (const form of forms) {
      if (countRole(index, undefined, form.role, form.name ?? '', false).length !== 1) continue;
      out.push({
        within: form,
        ax_node_id: ancestor.nodeId,
        ...(ancestor.backendDOMNodeId === undefined ? {} : { backend_node_id: ancestor.backendDOMNodeId }),
      });
      break;
    }
  }
  return out;
}

/* ---------------------------------- ops ----------------------------------- */

interface CandidatesArgs extends ElementLocator {
  browser_id?: string;
  target_id?: string;
  test_id_attribute?: string;
}

interface Candidate {
  target: SemanticTarget;
  matches: number;
  unique: boolean;
  compiles_to: string;
  note?: string;
  samples?: string[];
}

/** Builds the target for one form of a locator. */
type Former = (exact: boolean, within?: { role: string; name?: string }) => SemanticTarget;
/** Counts what that form matches. A negative count means "this form is not available". */
type Counter = (exact: boolean, scope?: ScopeChoice) => Promise<CountResult>;

/**
 * Try progressively more specific forms of one locator, keeping the first that
 * is unique.
 *
 * The order encodes a preference about what a test should depend on. `exact`
 * only tightens how the name is compared, so it is tried first. A `within`
 * couples the test to the page's landmark structure, which is real coupling and
 * therefore the later resort - though still far better than `.first()`, which
 * does not disambiguate at all, it just stops complaining.
 *
 * When nothing is unique the plain form comes back anyway, carrying its count,
 * because "four things match" is the answer the caller needs to act on.
 */
async function settle(
  form: Former,
  count: Counter,
  scopes: ScopeChoice[],
  exactForms: boolean[] = [false, true],
): Promise<Candidate | undefined> {
  const attempts: Array<{ exact: boolean; scope?: ScopeChoice }> = [
    ...exactForms.map((exact) => ({ exact })),
    ...scopes.flatMap((scope) => exactForms.map((exact) => ({ exact, scope }))),
  ];

  let plain: Candidate | undefined;
  for (const attempt of attempts) {
    const counted = await count(attempt.exact, attempt.scope);
    if (counted.count < 0) continue;

    const target = form(attempt.exact, attempt.scope?.within);
    const candidate: Candidate = {
      target,
      matches: counted.count,
      unique: counted.count === 1,
      compiles_to: playwrightExpression(target),
      ...(counted.samples.length > 0 ? { samples: counted.samples } : {}),
    };
    if (!plain) plain = candidate;

    if (counted.count === 1) {
      if (attempt.scope) {
        candidate.note =
          `The unscoped form matched ${plain.matches}; scoping to the ${attempt.scope.within.role} landmark ` +
          'isolates it. This is what replaces .first(), which would weaken the assertion to "one of these exists".';
      } else if (attempt.exact && plain.matches > 1) {
        candidate.note = `Substring matching hit ${plain.matches} elements; exact:true isolates it.`;
      }
      return candidate;
    }
  }
  return plain;
}

/**
 * Every locator a durable test could use for one element, with the live match
 * count for each.
 */
export async function candidates(
  ctx: OpsContext,
  args: CandidatesArgs,
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const attribute = args.test_id_attribute ?? 'data-testid';

  const element = await resolveElement(instance, target, args);
  const factsResponse = await target.session.send<{ result: { value?: unknown } }>(
    'Runtime.callFunctionOn',
    {
      objectId: element.objectId,
      returnByValue: true,
      functionDeclaration: ELEMENT_FACTS_FN,
      arguments: [{ value: attribute }],
    },
  );
  const facts = (factsResponse.result.value ?? {}) as {
    tag?: string;
    type?: string | null;
    test_id?: string | null;
    label?: string;
    text?: string;
    visible?: boolean;
  };

  const index = await axIndex(target);
  const axNode = index.byBackendId.get(element.backendNodeId);
  const documentId = await documentObjectId(instance, target);

  const out: Candidate[] = [];
  const scopes = axNode && !axNode.ignored ? viableScopes(index, axNode) : [];

  /* A scope is an accessibility node; counting in the page needs a DOM handle. */
  const scopeObjectIds = new Map<string, string | null>();
  const scopeObjectId = async (scope?: ScopeChoice): Promise<string | null> => {
    if (!scope) return documentId;
    if (scope.backend_node_id === undefined) return null;
    const cached = scopeObjectIds.get(scope.ax_node_id);
    if (cached !== undefined) return cached;
    let resolved: string | null = null;
    try {
      const response = await target.session.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: scope.backend_node_id,
      });
      resolved = response.object.objectId ?? null;
    } catch {
      // A scope we cannot address is skipped, never silently widened to the
      // document - that would report a scoped count the locator does not have.
      resolved = null;
    }
    scopeObjectIds.set(scope.ax_node_id, resolved);
    return resolved;
  };

  const countDom =
    (kind: 'testId' | 'label' | 'text', value: string): Counter =>
    async (exact, scope) => {
      const root = await scopeObjectId(scope);
      if (root === null) return { count: -1, samples: [] };
      return countInPage(target, root, { kind, value, exact, attribute });
    };

  /* --- role + accessible name, the locator a harness prefers ------------- */

  let roleNote: string | undefined;
  if (!axNode) {
    roleNote =
      'This element has no node in the accessibility tree, so no role locator can address it. ' +
      'That is usually aria-hidden, display:none, or a purely presentational wrapper.';
  } else if (axNode.ignored) {
    roleNote =
      "The accessibility tree marks this element ignored, so Playwright's role engine will not match it. " +
      'A user relying on assistive technology cannot reach it either, which is worth reporting as a finding.';
  } else {
    const role = axRole(axNode);
    const name = axName(axNode);

    if (!TARGET_ROLES.has(role)) {
      roleNote =
        `Its computed role is ${JSON.stringify(role || 'generic')}, which a scenario target cannot name. ` +
        'Use the test id, label or text candidate, or give the element a real role.';
    } else if (!name) {
      roleNote =
        `Role ${JSON.stringify(role)} resolved, but the element has no accessible name, and a role target requires one. ` +
        'Add a label, aria-label or visible text.';
    } else {
      const candidate = await settle(
        (exact, within) => ({ by: 'role', role, name, ...(exact ? { exact: true } : {}), ...(within ? { within } : {}) }),
        async (exact, scope) => {
          const found = countRole(index, scope?.ax_node_id, role, name, exact);
          return {
            count: found.length,
            samples: found.slice(0, 5).map((node) => `${axRole(node)} ${JSON.stringify(axName(node))}`),
          };
        },
        scopes,
      );
      if (candidate) out.push(candidate);
    }
  }

  /* --- test id, label, text: DOM facts, counted in the page -------------- */

  if (facts.test_id) {
    const value = facts.test_id;
    // getByTestId compares the attribute exactly, so there is no loose form.
    const candidate = await settle(
      (_exact, within) => ({ by: 'testId', testId: value, ...(within ? { within } : {}) }),
      countDom('testId', value),
      scopes,
      [true],
    );
    if (candidate) {
      candidate.note =
        candidate.note ??
        'A test id is a contract with the test suite: it survives copy changes and redesigns.';
      out.push(candidate);
    }
  }

  if (facts.label) {
    const value = facts.label;
    const candidate = await settle(
      (exact, within) => ({ by: 'label', label: value, ...(exact ? { exact: true } : {}), ...(within ? { within } : {}) }),
      countDom('label', value),
      scopes,
    );
    if (candidate && candidate.matches > 0) out.push(candidate);
  }

  // A whole paragraph is not a locator; it breaks on the first copy edit.
  if (facts.text && facts.text.length <= 120) {
    const value = facts.text;
    const candidate = await settle(
      (exact, within) => ({ by: 'text', text: value, ...(exact ? { exact: true } : {}), ...(within ? { within } : {}) }),
      countDom('text', value),
      scopes,
    );
    if (candidate && candidate.matches > 0) out.push(candidate);
  }

  /*
   * Rank by what makes a test last: unique first, then test id (a contract),
   * role (semantic and stable), label, and text last because copy changes.
   */
  const rank: Record<SemanticTarget['by'], number> = { testId: 0, role: 1, label: 2, text: 3 };
  out.sort((a, b) => {
    if (a.unique !== b.unique) return a.unique ? -1 : 1;
    if (rank[a.target.by] !== rank[b.target.by]) return rank[a.target.by] - rank[b.target.by];
    return a.matches - b.matches;
  });

  const best = out.find((candidate) => candidate.unique);

  return {
    target_id: target.handle,
    element: {
      description: element.description,
      tag: facts.tag,
      visible: facts.visible !== false,
      ...(element.matchedCount !== undefined && element.matchedCount > 1
        ? { locator_matched: element.matchedCount, chose: 'first' }
        : {}),
      ...(axNode ? { role: axRole(axNode), accessible_name: axName(axNode), ignored: axNode.ignored } : {}),
    },
    test_id_attribute: attribute,
    candidates: out,
    ...(best ? { recommended: best.target } : {}),
    ...(roleNote ? { role_note: roleNote } : {}),
    ...(best
      ? {}
      : {
          warning:
            out.length === 0
              ? 'No durable locator addresses this element: no usable role, no accessible name, no test id, no label and no text. ' +
                'A test could only reach it positionally, which is exactly the kind of test that rots. Fix the markup instead.'
              : 'Every candidate matches more than one element. Playwright strict mode fails on that, and .first() would ' +
                'reduce the assertion to "one of these exists". Add a test id, or scope the locator.',
        }),
    fidelity:
      "Roles and names come from Chrome's accessibility tree, which Playwright models but does not share. " +
      'The two agreed on all 22 targets in tests/playwright-interop.mjs, which checks these counts against ' +
      'the real locator engine, so a count here is good evidence - but that fixture is not every page, and ' +
      'compiling and running the test is still the proof.',
  };
}

interface CheckArgs {
  browser_id?: string;
  target_id?: string;
  target: SemanticTarget;
  test_id_attribute?: string;
}

/**
 * Resolve a semantic target against the live page and report what it hits.
 *
 * This is the pre-flight for a scenario written by hand or drafted from a
 * recording: a locator that matches nothing, or matches four things, is far
 * cheaper to find here than after compile, audit and three repeated runs.
 */
export async function check(ctx: OpsContext, args: CheckArgs): Promise<Record<string, unknown>> {
  const wanted = args.target;
  if (!wanted || typeof wanted !== 'object' || !wanted.by) {
    throw new AgentBrowserError('bad_target', 'Pass target as {by:"role"|"label"|"text"|"testId", ...}.');
  }

  const { instance, target } = await pageOf(ctx, args);
  const attribute = args.test_id_attribute ?? 'data-testid';
  const index = await axIndex(target);

  /* Resolve the scope first: an ambiguous scope fails before the inner locator. */
  let scopeNodeId: string | undefined;
  let scopeObjectId: string | undefined;
  const scopeReport: Record<string, unknown> = {};

  if (wanted.within) {
    const scopeRole = wanted.within.role;
    if (!canScope(scopeRole)) {
      throw new AgentBrowserError(
        'bad_within_role',
        `within.role ${JSON.stringify(scopeRole)} is not a role a scenario may scope to. ` +
          `Allowed: ${[...LANDMARK_ROLES, ...TARGET_ROLES].sort().join(', ')}.`,
      );
    }
    const scopes = countRole(index, undefined, scopeRole, wanted.within.name ?? '', false);
    scopeReport.scope_matches = scopes.length;
    if (scopes.length !== 1) {
      return {
        target_id: target.handle,
        target: wanted,
        compiles_to: playwrightExpression(wanted),
        ok: false,
        matches: 0,
        ...scopeReport,
        error:
          scopes.length === 0
            ? `No ${scopeRole} landmark matches within.name ${JSON.stringify(wanted.within.name ?? '')}.`
            : `${scopes.length} ${scopeRole} landmarks match, so the scope itself fails Playwright strict mode. ` +
              'Name the landmark, or scope to something unique.',
      };
    }
    const scopeNode = scopes[0]!;
    scopeNodeId = scopeNode.nodeId;
    if (scopeNode.backendDOMNodeId !== undefined) {
      const resolved = await target.session.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: scopeNode.backendDOMNodeId,
      });
      scopeObjectId = resolved.object.objectId;
    }
  }

  let matches = 0;
  let samples: string[] = [];

  if (wanted.by === 'role') {
    if (!wanted.role || !wanted.name) {
      throw new AgentBrowserError('bad_target', 'A role target needs both role and name.');
    }
    if (!TARGET_ROLES.has(wanted.role)) {
      throw new AgentBrowserError(
        'bad_role',
        `Role ${JSON.stringify(wanted.role)} is not one a scenario target may name. ` +
          `Allowed: ${[...TARGET_ROLES].sort().join(', ')}.`,
      );
    }
    const found = countRole(index, scopeNodeId, wanted.role, wanted.name, wanted.exact === true);
    matches = found.length;
    samples = found.slice(0, 5).map((node) => `${axRole(node)} ${JSON.stringify(axName(node))}`);
  } else {
    const value = wanted.by === 'label' ? wanted.label : wanted.by === 'text' ? wanted.text : wanted.testId;
    if (!value) {
      throw new AgentBrowserError('bad_target', `A ${wanted.by} target needs a ${wanted.by} value.`);
    }
    const root = scopeObjectId ?? (await documentObjectId(instance, target));
    const counted = await countInPage(target, root, {
      kind: wanted.by,
      value,
      // getByTestId compares the attribute exactly, whatever `exact` says.
      exact: wanted.by === 'testId' ? true : wanted.exact === true,
      attribute,
    });
    matches = counted.count;
    samples = counted.samples;
  }

  const ok = matches === 1;
  return {
    target_id: target.handle,
    target: wanted,
    compiles_to: playwrightExpression(wanted),
    ok,
    matches,
    ...scopeReport,
    ...(samples.length > 0 ? { samples } : {}),
    ...(matches === 0
      ? {
          error:
            'Nothing matches. The name may differ from the visible text (the accessible name wins), or the element ' +
            'may not be rendered yet - drive the page to the right state first.',
        }
      : {}),
    ...(matches > 1
      ? {
          error:
            `${matches} elements match, so Playwright strict mode will fail. Scope with within, set exact:true, ` +
            'or use a test id. Do not reach for .first().',
        }
      : {}),
  };
}
