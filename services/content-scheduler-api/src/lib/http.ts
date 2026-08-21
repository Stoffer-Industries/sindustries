export function sendError(res, status, code, message) {
  return res.status(status).json({
    error: {
      code,
      message,
    },
  });
}

export function badRequest(res, code, message) {
  return sendError(res, 400, code, message);
}

export function notFound(res, code, message) {
  return sendError(res, 404, code, message);
}