import type { Env, ExecutionContext } from "./cloudflare-types.ts";

export interface WorkerRouteMatch {
  pathname: string;
  params: Record<string, string>;
}

export type WorkerRouteHandler = (
  match: WorkerRouteMatch,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response> | Response;

export type WorkerRouteMatcher = (pathname: string) => WorkerRouteMatch | null;

export interface WorkerRoute {
  match: WorkerRouteMatcher;
  methods?: readonly string[];
  handler: WorkerRouteHandler;
}

export async function dispatchWorkerRoute(
  routes: readonly WorkerRoute[],
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  for (const route of routes) {
    const routeMatch = route.match(pathname);
    if (!routeMatch) {
      continue;
    }
    if (route.methods && !route.methods.includes(request.method)) {
      continue;
    }
    return route.handler(routeMatch, request, env, ctx);
  }
  return null;
}

export function exactPath(...paths: readonly string[]): WorkerRouteMatcher {
  const accepted = new Set(paths);
  return (pathname) => (accepted.has(pathname) ? { pathname, params: {} } : null);
}

export function routePath(
  template: string,
  options: { trailingSlash?: "optional" } = {},
): WorkerRouteMatcher {
  const templateSegments = splitPath(template);
  return (pathname) => {
    let candidate = pathname;
    if (options.trailingSlash === "optional" && candidate.length > 1 && candidate.endsWith("/")) {
      candidate = candidate.slice(0, -1);
    }
    const pathSegments = splitPath(candidate);
    if (pathSegments.length !== templateSegments.length) {
      return null;
    }

    const params: Record<string, string> = {};
    for (let index = 0; index < templateSegments.length; index += 1) {
      const templateSegment = templateSegments[index];
      const pathSegment = pathSegments[index];
      if (templateSegment.startsWith(":")) {
        params[templateSegment.slice(1)] = decodeURIComponent(pathSegment);
        continue;
      }
      if (templateSegment !== pathSegment) {
        return null;
      }
    }

    return { pathname, params };
  };
}

function splitPath(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new Error(`route paths must start with "/": ${path}`);
  }
  if (path === "/") {
    return [];
  }
  return path.slice(1).split("/");
}
