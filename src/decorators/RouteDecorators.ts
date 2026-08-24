export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: string;
}

export interface ControllerOptions {
  // Reserved for future options
}

function hasOwnMeta(ctor: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(ctor, key);
}

export function getOwnRoutes(ctor: any): RouteDefinition[] {
  return hasOwnMeta(ctor, 'routes') ? (ctor.routes as RouteDefinition[]) : [];
}

export function getOwnBasePath(ctor: any): string {
  return hasOwnMeta(ctor, 'basePath') ? (ctor.basePath as string) : '';
}

export function getOwnRenders(ctor: any): Record<string, RenderDefinition> {
  return hasOwnMeta(ctor, 'renders') ? (ctor.renders as Record<string, RenderDefinition>) : {};
}

export function Controller(basePath: string = '', _options: ControllerOptions = {}) {
  return function (target: any) {
    target.basePath = basePath || '';
  };
}

function defineRoute(method: HttpMethod) {
  return function (path: string) {
    return function (target: any, propertyKey: string, _descriptor: PropertyDescriptor) {
      const ctor = target.constructor;
      if (!hasOwnMeta(ctor, 'routes')) {
        ctor.routes = [] as RouteDefinition[];
      }
      (ctor.routes as RouteDefinition[]).push({
        method,
        path,
        handler: propertyKey
      });
    };
  };
}

export const Get = defineRoute('GET');
export const Post = defineRoute('POST');
export const Put = defineRoute('PUT');
export const Patch = defineRoute('PATCH');
export const Delete = defineRoute('DELETE');

export interface RenderDefinition {
  template: string;
  layout?: string;
}

export function Render(template: string, layout?: string) {
  return function (target: any, propertyKey: string, _descriptor: PropertyDescriptor) {
    const ctor = target.constructor;
    if (!hasOwnMeta(ctor, 'renders')) {
      ctor.renders = {} as Record<string, RenderDefinition>;
    }
    (ctor.renders as Record<string, RenderDefinition>)[propertyKey] = {
      template,
      layout
    };
  };
}
