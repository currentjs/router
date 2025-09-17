export interface AuthenticatedUser {
  id: string | number;
  role: string;
  email?: string;
  [key: string]: any;
}

export interface IRequestContext {
  url: string;
  parameters: Record<string, string | number>;
  body: Record<string, any> | undefined;
  user?: AuthenticatedUser;
  headers: Record<string, string | string[]>;
  method: string;
  path: string;
}

export interface IContext {
  request: IRequestContext;
  response: Record<string, any>;
}

export interface IProvider {
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}

