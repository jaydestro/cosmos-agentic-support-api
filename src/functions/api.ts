import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { handlers } from '../handlers/index.ts';
import { pickCorrelationId } from '../http/pipeline.ts';
import { invocationLogger, runtimeFailureResponse, toHttpResponse, toRawRequest } from './adapter.ts';
import { getContract, getRuntime } from './runtime.ts';

// One Functions entry per contract operation, so routes, methods and operation ids cannot drift.
for (const op of getContract().operations) {
  const handler = handlers[op.operationId];
  if (handler === undefined) throw new Error(`No handler is registered for ${op.operationId}`);

  app.http(op.operationId, {
    methods: [op.method],
    route: op.route,
    // Function keys never authorize anything here; protected operations validate an Entra token in code.
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
      let runtime;
      try {
        runtime = getRuntime();
      } catch {
        return runtimeFailureResponse(pickCorrelationId(request.headers.get('x-correlation-id')));
      }
      return toHttpResponse(await runtime.pipeline(op, handler, toRawRequest(request), invocationLogger(context)));
    },
  });
}
