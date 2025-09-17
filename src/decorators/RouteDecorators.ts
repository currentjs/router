export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: string;
}

export interface ControllerOptions {
  // Reserved for future options
}

export function Controller(basePath: string = '', _options: ControllerOptions = {}) {
  return function (target: any) {
    // Attach basePath metadata directly on the constructor
    target.basePath = basePath || '';
  };
}

function defineRoute(method: HttpMethod) {
  return function (path: string) {
    return function (target: any, propertyKey: string, _descriptor: PropertyDescriptor) {
      if (!target.constructor.routes) {
        target.constructor.routes = [] as RouteDefinition[];
      }
      (target.constructor.routes as RouteDefinition[]).push({
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
    if (!target.constructor.renders) {
      target.constructor.renders = {} as Record<string, RenderDefinition>;
    }
    (target.constructor.renders as Record<string, RenderDefinition>)[propertyKey] = {
      template,
      layout
    };
  };
}

