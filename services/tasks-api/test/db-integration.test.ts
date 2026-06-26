import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

describe('tasks api db integration', () => {
  it('reads seeded rows and persists create/update/archive through postgres', async () => {
    const app = createApp();

    const seeded = await request(app).get('/api/v1/tasks').query({ limit: 5 });
    expect(seeded.status).toBe(200);
    expect(seeded.body.data.length).toBeGreaterThan(0);

    const title = `CI integration task ${Date.now()}`;

    const created = await request(app).post('/api/v1/tasks').send({
      title,
      priority: 'high',
      tags: ['ci-integration']
    });

    expect(created.status).toBe(201);
    expect(created.body.data.title).toBe(title);
    expect(created.body.data.priority).toBe('high');

    const taskId = created.body.data.id;

    const moved = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .send({ status: 'doing' });

    expect(moved.status).toBe(200);
    expect(moved.body.data.status).toBe('doing');

    const commented = await request(app)
      .post(`/api/v1/tasks/${taskId}/comments`)
      .send({ author: 'CI', text: 'Happy-path integration comment' });

    expect(commented.status).toBe(201);
    expect(commented.body.data.author).toBe('CI');
    expect(commented.body.data.text).toBe('Happy-path integration comment');

    const detail = await request(app).get(`/api/v1/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.comments).toEqual([
      expect.objectContaining({ author: 'CI', text: 'Happy-path integration comment' })
    ]);

    const archived = await request(app).delete(`/api/v1/tasks/${taskId}`);
    expect(archived.status).toBe(200);
    expect(archived.body.data.id).toBe(taskId);

    const afterArchive = await request(app).get(`/api/v1/tasks/${taskId}`);
    expect(afterArchive.status).toBe(404);
  });
});
