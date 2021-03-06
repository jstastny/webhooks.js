import { WebhookEventName } from "@octokit/webhooks-definitions/schema";
import { isntWebhook } from "./isnt-webhook";
import { getMissingHeaders } from "./get-missing-headers";
import { getPayload } from "./get-payload";
import { verifyAndReceive } from "./verify-and-receive";
import { IncomingMessage, ServerResponse } from "http";
import { State, WebhookEventHandlerError } from "../types";

export function middleware(
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
  next?: Function
): Promise<void> | undefined {
  if (isntWebhook(request, { path: state.path })) {
    // the next callback is set when used as an express middleware. That allows
    // it to define custom routes like /my/custom/page while the webhooks are
    // expected to be sent to the / root path. Otherwise the root path would
    // match all requests and would make it impossible to define custom routes
    if (next) {
      next();
      return;
    }

    state.log.debug(`ignored: ${request.method} ${request.url}`);
    response.statusCode = 404;
    response.end("Not found");
    return;
  }

  const missingHeaders = getMissingHeaders(request).join(", ");
  if (missingHeaders) {
    const error = new Error(
      `[@octokit/webhooks] Required headers missing: ${missingHeaders}`
    );

    return state.eventHandler.receive(error).catch(() => {
      response.statusCode = 400;
      response.end(error.message);
    });
  }

  const eventName = request.headers["x-github-event"] as WebhookEventName;
  const signatureSHA1 = request.headers["x-hub-signature"] as string;
  const signatureSHA256 = request.headers["x-hub-signature-256"] as string;
  const id = request.headers["x-github-delivery"] as string;

  state.log.debug(`${eventName} event received (id: ${id})`);

  // GitHub will abort the request if it does not receive a response within 10s
  // See https://github.com/octokit/webhooks.js/issues/185
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    response.statusCode = 202;
    response.end("still processing\n");
  }, 9000).unref();

  return getPayload(request)
    .then((payload) => {
      return verifyAndReceive(state, {
        id: id,
        name: eventName as any,
        payload: payload as any,
        signature: signatureSHA256 || signatureSHA1,
      });
    })

    .then(() => {
      clearTimeout(timeout);

      if (didTimeout) return;

      response.end("ok\n");
    })

    .catch((error: WebhookEventHandlerError) => {
      clearTimeout(timeout);

      if (didTimeout) return;

      const statusCode = Array.from(error)[0].status;
      response.statusCode = statusCode || 500;
      response.end(error.toString());
    });
}
