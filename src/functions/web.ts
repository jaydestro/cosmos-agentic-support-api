import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { pickCorrelationId } from '../http/pipeline.ts';
import { consoleConfigResponse } from '../http/console-config.ts';
import { HttpError } from '../http/problem.ts';
import { compileRouteMatcher } from '../http/routes.ts';
import { invocationLogger, problemHttpResponse, runtimeFailureResponse } from './adapter.ts';
import { getContract, getRuntime } from './runtime.ts';

const methodsFor = compileRouteMatcher(getContract().operations);

/**
 * Serves the console and the API reference, and gives unknown API paths a structured answer
 * instead of a page. Literal `api/...` routes are registered separately and take precedence.
 */
app.http('web', {
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  route: '{*path}',
  authLevel: 'anonymous',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const correlationId = pickCorrelationId(request.headers.get('x-correlation-id'));
    let runtime;
    try {
      runtime = getRuntime();
    } catch {
      return runtimeFailureResponse(correlationId);
    }
    const hsts = runtime.services.config.env === 'azure';
    const path = request.params['path'] ?? '';
    const isApi = path === 'api' || path.startsWith('api/');

    if (isApi) {
      const methods = methodsFor(path.replace(/\/+$/, ''));
      invocationLogger(context).info('unmatched api request', { method: request.method, status: methods.length > 0 ? 405 : 404 });
      return methods.length > 0
        ? problemHttpResponse(
            new HttpError(405, 'method_not_allowed', 'Method not allowed', { headers: { Allow: methods.join(', ') } }),
            correlationId,
            hsts,
          )
        : problemHttpResponse(new HttpError(404, 'not_found', 'Not found'), correlationId, hsts);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return problemHttpResponse(
        new HttpError(405, 'method_not_allowed', 'Method not allowed', { headers: { Allow: 'GET, HEAD' } }),
        correlationId,
        hsts,
      );
    }

    const served =
      path === 'config.json'
        ? consoleConfigResponse(runtime.services.config, request.method)
        : await runtime.statics.serve(path, request.method);
    if (served.status !== 200) return problemHttpResponse(new HttpError(404, 'not_found', 'Not found'), correlationId, hsts);
    return {
      status: served.status,
      headers: { ...served.headers, ...(hsts ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) },
      ...(served.body === undefined ? {} : { body: served.body }),
    };
  },
});
