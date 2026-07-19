// Generic X tweet posting route — exposes the shared XClient as a generic
// "post a tweet" endpoint so sibling services (notably the bookmark
// approval flow at agents/workflows/bookmarks/scripts/x_author_tweet.py)
// can post without owning OAuth credentials.
//
// Implements AC1, AC3, and AC5 (reframed as a credentials check) of
// task 55ac9240-d54a-4b2c-88c4-8bb8af85d2b2 (Bookmark approval — author
// tweet notification).
//
// Endpoint:
//   POST /api/v1/x/tweets
//     body: { text: string, in_reply_to_tweet_id?: string }
//     200:  { data: { url: string, postedAt: ISO-8601 } }
//     400:  TWEET_TOO_LONG | INVALID_BODY
//     502:  X_API_ERROR
//     503:  MISSING_CREDENTIALS
//
// Auth: this endpoint is intended for in-cluster callers. The lobster
// runs on the same host as the tasks-api dev container and calls
// http://localhost:4001/api/v1/x/tweets unauthenticated, matching the
// pattern of every other tasks-api write endpoint in this MVP. If the
// tasks-api ever stops being localhost-only, this route MUST be locked
// down (header token or LAN allowlist) before exposing it externally.

import { Router } from 'express';
import { getXClient } from './contentSchedulerPublish.ts';

const MAX_TWEET_LENGTH = 280;

export function xTweetRouter(): Router {
  const router = Router();

  router.post('/x/tweets', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({
        error: { code: 'INVALID_BODY', message: 'Request body must be a JSON object' }
      });
      return;
    }
    const text = body.text;
    const inReplyToTweetId = body.in_reply_to_tweet_id;
    if (typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({
        error: { code: 'INVALID_BODY', message: '`text` must be a non-empty string' }
      });
      return;
    }
    if (text.length > MAX_TWEET_LENGTH) {
      res.status(400).json({
        error: {
          code: 'TWEET_TOO_LONG',
          message: `text exceeds ${MAX_TWEET_LENGTH} characters`,
          maxLength: MAX_TWEET_LENGTH,
          length: text.length
        }
      });
      return;
    }
    if (inReplyToTweetId !== undefined && typeof inReplyToTweetId !== 'string') {
      res.status(400).json({
        error: { code: 'INVALID_BODY', message: '`in_reply_to_tweet_id` must be a string when present' }
      });
      return;
    }

    // AC5 (reframed per Quinn comment 48101f8f): credentials check first,
    // before any HTTP call to api.twitter.com. Returning null from
    // getXClient() means the OAuth 1.0a env vars are not configured.
    const client = getXClient();
    if (client === null) {
      res.status(503).json({
        error: { code: 'MISSING_CREDENTIALS', message: 'X credentials are not configured' }
      });
      return;
    }

    try {
      const result = await client.createTweet({
        text,
        in_reply_to_tweet_id: inReplyToTweetId
      });
      res.status(200).json({
        data: {
          url: result.url,
          postedAt: result.postedAt.toISOString()
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown X client error';
      // Surface truncated upstream body so the Python caller can record
      // a useful error reason in tweetLog.error, but never leak secrets.
      const safeMessage = message.slice(0, 200);
      console.error('[xTweet] client.createTweet failed:', safeMessage);
      res.status(502).json({
        error: { code: 'X_API_ERROR', message: safeMessage }
      });
    }
  });

  return router;
}