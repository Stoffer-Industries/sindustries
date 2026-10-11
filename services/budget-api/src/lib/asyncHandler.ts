import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wrap an async (or sync) Express handler so that rejected promises and
 * synchronous throws are forwarded to `next(err)` instead of becoming
 * unhandled rejections or hanging the request.
 *
 * Express 4 does not await middleware/handler return values, so a handler
 * declared as `async (req, res, next) => { await ... }` whose `await` rejects
 * never reaches the registered error middleware. This wrapper is the
 * single, consistent layer that fixes that — see
 * docs/specs/budget-api-async-handler-inventory.md for the full inventory
 * of every async handler it covers.
 *
 * The handler may still respond normally (e.g. `res.status(401).json(...)` or
 * `return next()`) — the wrapper only catches values that propagate as
 * rejections or throws. Calling `next` directly inside the handler is
 * preserved as-is; the wrapper will not call it again on success.
 */
type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => unknown | Promise<unknown>;

export function asyncHandler(
  handler: AsyncRequestHandler
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(next);
  };
}
