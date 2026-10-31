import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CASE_ID_PATTERN, caseHash, parseRoute, routeHash, routeTitle, type Route } from '../../web/src/routes.ts';
import { schema } from '../support/contract-doc.ts';
import { CASE_ID } from '../support/web-fixtures.ts';

const ROUTES: readonly Route[] = [
  { name: 'cases' },
  { name: 'new-case' },
  { name: 'case', caseId: CASE_ID },
  { name: 'operator' },
  { name: 'not-found', hash: '#/nowhere' },
];

describe('parseRoute', () => {
  it('reads each known route', () => {
    assert.deepEqual(parseRoute('#/cases'), { name: 'cases' });
    assert.deepEqual(parseRoute('#/cases/new'), { name: 'new-case' });
    assert.deepEqual(parseRoute('#/operator'), { name: 'operator' });
    assert.deepEqual(parseRoute(`#/cases/${CASE_ID}`), { name: 'case', caseId: CASE_ID });
  });

  it('treats an empty hash as the case list', () => {
    for (const hash of ['', '#', '#/', '#//']) assert.deepEqual(parseRoute(hash), { name: 'cases' }, JSON.stringify(hash));
  });

  it('accepts the hash without its slash or with trailing slashes', () => {
    assert.deepEqual(parseRoute('#cases'), { name: 'cases' });
    assert.deepEqual(parseRoute('#cases/new'), { name: 'new-case' });
    assert.deepEqual(parseRoute('#/cases/'), { name: 'cases' });
    assert.deepEqual(parseRoute('#/cases/new///'), { name: 'new-case' });
    assert.deepEqual(parseRoute(`#/cases/${CASE_ID}/`), { name: 'case', caseId: CASE_ID });
    assert.deepEqual(parseRoute('#/operator/'), { name: 'operator' });
  });

  it('keeps the original hash for a page that does not exist', () => {
    for (const hash of ['#/nowhere', '#/cases/new/extra', '#/operator/work', '#/Cases', '#/cases/NEW', '#/cases/case_short', '#//cases', '#/cases//new']) {
      assert.deepEqual(parseRoute(hash), { name: 'not-found', hash }, hash);
    }
  });

  it('refuses a case id that is not in the contract form, so nothing odd is requested from the service', () => {
    for (const id of [
      'case_00000000000000000000000000000001'.toUpperCase(),
      'case_0000000000000000000000000000000',
      'case_000000000000000000000000000000001',
      'case_0000000000000000000000000000000g',
      'case-00000000000000000000000000000001',
      '00000000000000000000000000000001',
      '..',
      '../operator',
      '%2e%2e',
      'new%20',
    ]) {
      assert.deepEqual(parseRoute(`#/cases/${id}`), { name: 'not-found', hash: `#/cases/${id}` }, id);
    }
  });

  it('uses the contract case id form', () => {
    assert.equal(CASE_ID_PATTERN.source, schema('CaseId').pattern);
    assert.match(CASE_ID, CASE_ID_PATTERN);
  });
});

describe('routeHash and caseHash', () => {
  it('writes the canonical hash for each route', () => {
    assert.deepEqual(ROUTES.map(routeHash), ['#/cases', '#/cases/new', `#/cases/${CASE_ID}`, '#/operator', '#/nowhere']);
    assert.equal(caseHash(CASE_ID), `#/cases/${CASE_ID}`);
  });

  it('reads back what it wrote', () => {
    for (const route of ROUTES) assert.deepEqual(parseRoute(routeHash(route)), route, route.name);
  });
});

describe('routeTitle', () => {
  it('names every page, and each differently', () => {
    const titles = ROUTES.map(routeTitle);
    assert.deepEqual(titles, ['Cases', 'New dispute', 'Case', 'Operator recovery', 'Page not found']);
    assert.equal(new Set(titles).size, titles.length);
  });
});
