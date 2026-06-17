import { describe, it, expect } from '../lib.js';
import { Controller, Get, Post, Render } from '../../src/decorators/RouteDecorators.js';

@Controller('/api')
class Demo {
  @Get('/ping')
  ping() {}

  @Post('/echo')
  echo() {}

  @Get('/view')
  @Render('view.html', 'main')
  view() {}
}

describe('RouteDecorators', () => {
  it('attaches basePath to constructor', () => {
    const ctor: any = Demo.prototype.constructor;
    expect(ctor.basePath).toBe('/api');
  });

  it('collects routes metadata', () => {
    const ctor: any = Demo.prototype.constructor;
    expect(Array.isArray(ctor.routes)).toBeTruthy();
    expect(ctor.routes.length).toBe(3);
    expect(ctor.routes[0]).toEqual({ method: 'GET', path: '/ping', handler: 'ping' });
    expect(ctor.routes[1]).toEqual({ method: 'POST', path: '/echo', handler: 'echo' });
  });

  it('collects render metadata per handler', () => {
    const ctor: any = Demo.prototype.constructor;
    expect(ctor.renders.view).toEqual({ template: 'view.html', layout: 'main' });
  });
});
