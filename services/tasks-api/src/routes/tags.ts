import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest } from '../lib/http';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

export const tagsRouter = Router();

tagsRouter.get('/tags', async (_req, res, next) => {
  try {
    const tags = await prisma.tag.findMany({
      orderBy: [{ name: 'asc' }]
    });

    return res.status(200).json({ data: tags });
  } catch (error) {
    return next(error);
  }
});

tagsRouter.post('/tags', async (req, res, next) => {
  try {
    const name = normalizeString(req.body?.name)?.toLowerCase();
    if (!name) {
      return badRequest(res, 'NAME_REQUIRED', 'name is required');
    }

    const tag = await prisma.tag.upsert({
      where: { name },
      create: { name },
      update: {}
    });

    return res.status(201).json({ data: tag });
  } catch (error) {
    return next(error);
  }
});
