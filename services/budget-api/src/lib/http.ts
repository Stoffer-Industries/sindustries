import type { Request, Response } from 'express';

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INTERNAL_SERVER_ERROR';

export function jsonError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string
) {
  return res.status(status).json({ error: { code, message } });
}

export function requireHeader(req: Request, name: string): string | null {
  const v = req.header(name);
  return v && v.trim().length > 0 ? v : null;
}

