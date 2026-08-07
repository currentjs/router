import { describe, it, expect } from '../lib.js';
import { buildRouteTable, compareRouteSpecificity } from '../../src/server/createWebServer.js';
import { Controller, Get } from '../../src/decorators/RouteDecorators.js';

// ---------------------------------------------------------------------------
// Helpers: build minimal controller classes without TypeScript decorators
// so each test is self-contained.
// ---------------------------------------------------------------------------

function makeController(basePath: string, routes: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; path: string; handler: string }>) {
  class C {}
  (C as any).basePath = basePath;
  (C as any).routes = routes;
  const instance = new C();
  return instance;
}

// ---------------------------------------------------------------------------
// compareRouteSpecificity
// ---------------------------------------------------------------------------

function makeEntry(path: string, registrationIndex: number) {
  return {
    route: { method: 'GET' as const, path, handler: 'h' },
    controllerInstance: {},
    matcher: { regex: /x/, keys: [] },
    registrationIndex,
  };
}

describe('compareRouteSpecificity', () => {
  it('sorts routes with fewer params before routes with more params', () => {
    const a = makeEntry('/items/:id/edit', 0); // 1 param
    const b = makeEntry('/:section/:id', 1);   // 2 params
    const sorted = [b, a].sort(compareRouteSpecificity);
    expect(sorted[0].route.path).toBe('/items/:id/edit');
  });

  it('when param count is equal, static segment beats param at the same position', () => {
    // Both have 1 param, but /items/:id has a static segment at position 0
    const a = makeEntry('/items/:id', 0);
    const b = makeEntry('/:section/foo', 1);
    const sorted = [b, a].sort(compareRouteSpecificity);
    expect(sorted[0].route.path).toBe('/items/:id');
  });

  it('falls back to registration index for genuinely equivalent routes', () => {
    const a = makeEntry('/a/:id', 0);
    const b = makeEntry('/b/:id', 1);
    const sorted = [b, a].sort(compareRouteSpecificity);
    expect(sorted[0].route.path).toBe('/a/:id');
  });
});

// ---------------------------------------------------------------------------
// buildRouteTable — classification
// ---------------------------------------------------------------------------

describe('buildRouteTable — classification', () => {
  it('puts a fully-static route into staticRoutes', () => {
    const ctrl = makeController('/foo', [{ method: 'GET', path: '/bar', handler: 'h' }]);
    const { staticRoutes, dynamicRoutes } = buildRouteTable([ctrl]);
    expect(staticRoutes.size).toBe(1);
    expect(dynamicRoutes.length).toBe(0);
    expect(staticRoutes.has('GET /foo/bar')).toBeTruthy();
  });

  it('puts a parametric route into dynamicRoutes', () => {
    const ctrl = makeController('/foo', [{ method: 'GET', path: '/:id', handler: 'h' }]);
    const { staticRoutes, dynamicRoutes } = buildRouteTable([ctrl]);
    expect(staticRoutes.size).toBe(0);
    expect(dynamicRoutes.length).toBe(1);
  });

  it('classifies root path "/" as static', () => {
    const ctrl = makeController('', [{ method: 'GET', path: '/', handler: 'h' }]);
    const { staticRoutes } = buildRouteTable([ctrl]);
    expect(staticRoutes.has('GET /')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// buildRouteTable — duplicate first-wins
// ---------------------------------------------------------------------------

describe('buildRouteTable — duplicate first-wins', () => {
  it('first registered static route wins when two controllers register the same path', () => {
    const ctrl1 = makeController('/foo', [{ method: 'GET', path: '/bar', handler: 'first' }]);
    const ctrl2 = makeController('/foo', [{ method: 'GET', path: '/bar', handler: 'second' }]);
    const { staticRoutes } = buildRouteTable([ctrl1, ctrl2]);
    expect(staticRoutes.get('GET /foo/bar')!.route.handler).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// buildRouteTable — dynamic routes are pre-sorted
// ---------------------------------------------------------------------------

describe('buildRouteTable — dynamic routes pre-sorted', () => {
  it('a route with fewer params comes first regardless of registration order', () => {
    const ctrl = makeController('', [
      { method: 'GET', path: '/:section/:id', handler: 'twoParams' },
      { method: 'GET', path: '/items/:id',    handler: 'oneParam'  },
    ]);
    const { dynamicRoutes } = buildRouteTable([ctrl]);
    expect(dynamicRoutes[0].route.handler).toBe('oneParam');
    expect(dynamicRoutes[1].route.handler).toBe('twoParams');
  });

  it('static segment wins over param at same position (same total params)', () => {
    const ctrl = makeController('', [
      { method: 'GET', path: '/:section/detail', handler: 'paramFirst' },
      { method: 'GET', path: '/items/:id',       handler: 'staticFirst' },
    ]);
    const { dynamicRoutes } = buildRouteTable([ctrl]);
    expect(dynamicRoutes[0].route.handler).toBe('staticFirst');
  });
});
