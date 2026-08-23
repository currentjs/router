import { describe, it, expect } from '../lib.js';
import { Controller, Get, Post, Render, getOwnRoutes, getOwnBasePath, getOwnRenders } from '../../src/decorators/RouteDecorators.js';
import { buildRouteTable } from '../../src/server/createWebServer.js';

// ---------------------------------------------------------------------------
// Fixture: base class with its own routes and basePath
// ---------------------------------------------------------------------------

@Controller('/base')
class BaseController {
  @Get('/x')
  x() {}
}

// ---------------------------------------------------------------------------
// Sibling isolation
// ---------------------------------------------------------------------------

@Controller('/posts')
class PostController extends BaseController {
  @Get('/')
  list() {}
}

@Controller('/users')
class UserController extends BaseController {
  @Get('/')
  index() {}
}

describe('Decorator metadata isolation — sibling isolation', () => {
  it('base class routes array holds only its own route', () => {
    const routes = getOwnRoutes(BaseController);
    expect(routes.length).toBe(1);
    expect(routes[0].handler).toBe('x');
  });

  it('PostController routes array holds only its own route', () => {
    const routes = getOwnRoutes(PostController);
    expect(routes.length).toBe(1);
    expect(routes[0].handler).toBe('list');
  });

  it('UserController routes array holds only its own route', () => {
    const routes = getOwnRoutes(UserController);
    expect(routes.length).toBe(1);
    expect(routes[0].handler).toBe('index');
  });

  it('siblings do not share arrays with each other or the base', () => {
    const baseRoutes = getOwnRoutes(BaseController);
    const postRoutes = getOwnRoutes(PostController);
    const userRoutes = getOwnRoutes(UserController);
    // Different array references
    expect(baseRoutes === postRoutes).toBeFalsy();
    expect(baseRoutes === userRoutes).toBeFalsy();
    expect(postRoutes === userRoutes).toBeFalsy();
  });

  it('buildRouteTable registers exactly two routes for two siblings (not four or more)', () => {
    const { staticRoutes, dynamicRoutes } = buildRouteTable([new PostController(), new UserController()]);
    const total = staticRoutes.size + dynamicRoutes.length;
    expect(total).toBe(2);
  });

  it('buildRouteTable resolves each sibling under its own prefix', () => {
    const { staticRoutes } = buildRouteTable([new PostController(), new UserController()]);
    expect(staticRoutes.has('GET /posts')).toBeTruthy();
    expect(staticRoutes.has('GET /users')).toBeTruthy();
    expect(staticRoutes.has('GET /base/x')).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// basePath non-inheritance
// ---------------------------------------------------------------------------

@Controller('/parent')
class ParentController {
  @Get('/a')
  a() {}
}

class ChildWithRoutesNoDecorator extends ParentController {
  @Get('/b')
  b() {}
}

describe('Decorator metadata isolation — basePath is not inherited', () => {
  it('getOwnBasePath returns empty string for a subclass without @Controller', () => {
    expect(getOwnBasePath(ChildWithRoutesNoDecorator)).toBe('');
  });

  it('parent basePath is not adopted by undecorated subclass in buildRouteTable', () => {
    const { staticRoutes } = buildRouteTable([new ChildWithRoutesNoDecorator()]);
    // Without own @Controller the route registers at /b, not /parent/b
    expect(staticRoutes.has('GET /b')).toBeTruthy();
    expect(staticRoutes.has('GET /parent/b')).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Subclass with no decorators contributes zero routes
// ---------------------------------------------------------------------------

class EmptySubclass extends PostController {}

describe('Decorator metadata isolation — no own decorators means no routes', () => {
  it('getOwnRoutes returns empty array for an undecorated subclass', () => {
    expect(getOwnRoutes(EmptySubclass).length).toBe(0);
  });

  it('buildRouteTable registers zero routes for an undecorated subclass', () => {
    const { staticRoutes, dynamicRoutes } = buildRouteTable([new EmptySubclass()]);
    expect(staticRoutes.size + dynamicRoutes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// @Render isolation
// ---------------------------------------------------------------------------

@Controller('/pages')
class PageBase {
  @Get('/home')
  @Render('home.html', 'layout.html')
  home() {}
}

@Controller('/sub')
class SubPage extends PageBase {
  @Get('/about')
  @Render('about.html', 'layout.html')
  about() {}
}

describe('Decorator metadata isolation — @Render does not leak', () => {
  it('base class renders holds only its own handler', () => {
    const renders = getOwnRenders(PageBase);
    expect(Object.keys(renders).length).toBe(1);
    expect(renders['home']).toBeDefined();
    expect(renders['about']).toBeFalsy();
  });

  it('subclass renders holds only its own handler', () => {
    const renders = getOwnRenders(SubPage);
    expect(Object.keys(renders).length).toBe(1);
    expect(renders['about']).toBeDefined();
    expect(renders['home']).toBeFalsy();
  });

  it('renders objects are not shared between base and subclass', () => {
    expect(getOwnRenders(PageBase) === getOwnRenders(SubPage)).toBeFalsy();
  });
});
