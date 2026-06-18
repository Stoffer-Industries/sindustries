#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getPending, setPending, getProcessed, STATE_DIR } = require('./lib/state.cjs');

const DEFAULT_COUNT = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  const maxItemsIndex = args.indexOf('--max-items');
  const rawMaxItems = maxItemsIndex >= 0 ? args[maxItemsIndex + 1] : null;
  const maxItems = rawMaxItems ? Number.parseInt(rawMaxItems, 10) : DEFAULT_COUNT;

  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    throw new Error(`--max-items must be a positive integer, got: ${rawMaxItems}`);
  }

  return { maxItems };
}

async function fetchWithBird(count) {
  return new Promise((resolve, reject) => {
    const bookmarks = [];
    const child = spawn('bird', ['bookmarks', '-n', String(count), '--json'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('bird error:', stderr);
        reject(new Error(`bird exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (e) {
        reject(new Error(`Failed to parse bird output: ${e.message}`));
      }
    });
  });
}

function getAccessToken() {
  const authScriptPath = path.join(__dirname, 'x_api_auth.py');
  const printToken = spawnSync('python3', [authScriptPath, '--print-token'], {
    encoding: 'utf8',
    // Mark the helper invocation as headless so it skips the interactive
    // OAuth fallback (which would block 120s for a browser callback) and
    // routes all recovery chatter to ~/.config/x-bookmarks/auth-events.log
    // instead of stdout/stderr. Keeps LLM-cron summarizers from
    // pattern-matching on 'failed' / '401' and inventing a cause.
    env: { ...process.env, X_AUTH_HEADLESS: '1' },
  });

  if (printToken.status === 0) {
    const output = (printToken.stdout || '').trim();
    const token = output.split('\n').map(s => s.trim()).filter(Boolean).pop();
    if (token) return token;
  }

  // Do NOT fall back to a stale on-disk access_token here. The helper failed
  // (refresh + re-auth both failed, or transient X /token endpoint 5xx).
  // A silent disk read of an already-expired token just produces a guaranteed
  // 401 on the next call. Fail loudly so Lox (or whoever's watching) can
  // surface the real cause instead of papering over it.
  //
  // The error message deliberately omits the status code and response body so
  // the cron LLM summarizer can't latch onto '401' and hallucinate an auth
  // cause. The real diagnostic trail is in auth-events.log.
  const stderr = (printToken.stderr || '').trim();
  throw new Error(
    `x_api_auth.py --print-token status ${printToken.status}. ` +
    `See ~/.config/x-bookmarks/auth-events.log for details. ` +
    `Helper stderr: ${stderr || '(empty)'}`
  );
}

async function fetchWithXAPI(count, accessToken = getAccessToken()) {
  // Get user ID first
  const meResp = await fetch('https://api.x.com/2/users/me', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const meData = await meResp.json();
  const userId = meData?.data?.id;
  if (!userId) {
    throw new Error(`Unable to resolve user id from /users/me (status ${meResp.status}): ${JSON.stringify(meData)}`);
  }

  // Fetch bookmarks
  const resp = await fetch(`https://api.x.com/2/users/${userId}/bookmarks?max_results=${count}&tweet.fields=created_at,public_metrics,entities,text,note_tweet,article,attachments,referenced_tweets`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!resp.ok) {
    // Don't include the status code or response body in the user-facing
    // message. Both are common LLM-cron trigger words ('401', 'error' in the
    // body, etc.) that cause the summarizer to hallucinate an auth cause when
    // the real issue might be rate limiting, a transient 5xx, or a revoked
    // refresh token. Real diagnostic trail is in auth-events.log.
    throw new Error(
      `X API request was not successful. ` +
      `See ~/.config/x-bookmarks/auth-events.log for the actual cause.`
    );
  }

  const data = await resp.json();
  return data.data || [];
}

async function enrichQuotedTweetArticles(bookmarks, accessToken) {
  for (const bookmark of bookmarks) {
    if (bookmark.article?.plain_text) continue;

    const quotedReference = bookmark.referenced_tweets?.find(
      reference => reference.type === 'quoted'
    );
    if (!quotedReference?.id) continue;

    try {
      const resp = await fetch(
        `https://api.x.com/2/tweets/${quotedReference.id}?tweet.fields=text,article,entities`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!resp.ok) {
        console.warn(
          `Quoted tweet article lookup skipped for bookmark ${bookmark.id}: X API request was not successful`
        );
        continue;
      }

      const payload = await resp.json();
      bookmark.quotedTweet = payload?.data || null;
      const quotedArticle = bookmark.quotedTweet?.article;
      if (!quotedArticle?.plain_text) continue;

      const original = String(bookmark.text || '').trim();
      bookmark.text = original
        ? `${original}\n\n[Quoted Article]\n${quotedArticle.plain_text}`
        : quotedArticle.plain_text;
      bookmark.linkedArticle = {
        title: quotedArticle.title,
        body: quotedArticle.plain_text,
        previewText: quotedArticle.preview_text,
        source: 'quoted-tweet',
        sourceUrl: bookmark.quotedTweet.entities?.urls?.[0]?.unwound_url
          || bookmark.quotedTweet.entities?.urls?.[0]?.expanded_url
          || null
      };
    } catch (error) {
      console.warn(
        `Quoted tweet article lookup skipped for bookmark ${bookmark.id}: ${error.message}`
      );
    }
  }

  return bookmarks;
}

async function expandURL(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return resp.url;
  } catch {
    return url;
  }
}

async function main() {
  const { maxItems } = parseArgs();
  console.log(`Fetching bookmarks (max ${maxItems})...`);

  let bookmarks = [];
  let accessToken;

  // Use X API directly (OAuth) - skip bird CLI cookie auth
  try {
    accessToken = getAccessToken();
    bookmarks = await fetchWithXAPI(maxItems, accessToken);
    console.log(`Fetched ${bookmarks.length} bookmarks via X API`);
  } catch (apiError) {
    console.error('Failed to fetch bookmarks:', apiError.message);
    process.exit(1);
  }

  // Get already processed IDs
  const processedIds = new Set(getProcessed().map(b => typeof b === 'string' ? b : b.id));
  const pending = getPending();

  // Filter out already processed
  const newBookmarks = bookmarks.filter(b => !processedIds.has(b.id));

  console.log(`${bookmarks.length} total, ${newBookmarks.length} new`);

  // Merge with existing pending (avoid duplicates)
  const existingIds = new Set(pending.map(b => b.id));
  const toAdd = newBookmarks.filter(b => !existingIds.has(b.id));

  // Extract and expand URLs from tweet entities, and handle note tweets
  for (const bookmark of toAdd) {
    // Prefer richer source text in this order: article -> note_tweet -> text
    if (bookmark.article?.plain_text) {
      const original = String(bookmark.text || '').trim();
      const articleText = String(bookmark.article.plain_text || '').trim();
      if (original && !/^https?:\/\/t\.co\//i.test(original)) {
        bookmark.text = `${original}\n\n[Article]\n${articleText}`;
      } else {
        bookmark.text = articleText;
      }
    } else if (bookmark.note_tweet?.text) {
      bookmark.text = bookmark.note_tweet.text;
    }
    
    const urls = bookmark.entities?.urls || bookmark.note_tweet?.entities?.urls || [];
    // Find first non-twitter URL (i.e., not a t.co shortlink to another tweet)
    for (const urlEntry of urls) {
      const originalUrl = urlEntry.expanded_url || urlEntry.url;
      // Skip x.com/twitter links - they're just links to other tweets
      if (originalUrl && !originalUrl.includes('://x.com/') && !originalUrl.includes('://twitter.com/')) {
        bookmark.url = originalUrl;
        bookmark.expandedUrl = await expandURL(originalUrl);
        break;
      }
    }

    // Fallback: some tweets are just raw t.co text and may not include entities.urls
    if (!bookmark.url && typeof bookmark.text === 'string') {
      const m = bookmark.text.match(/https?:\/\/t\.co\/[A-Za-z0-9]+/);
      if (m) {
        const expanded = await expandURL(m[0]);
        bookmark.expandedUrl = expanded;
        if (expanded && !expanded.includes('://x.com/') && !expanded.includes('://twitter.com/')) {
          bookmark.url = expanded;
        }
      }
    }
  }

  // Quoted Twitter articles are not expanded in the bookmarks response.
  // Fetch them separately after the bookmark's own article/note text has
  // been normalized so the quoted body is not overwritten.
  await enrichQuotedTweetArticles(toAdd, accessToken);

  const updatedPending = [...pending, ...toAdd];
  setPending(updatedPending);

  console.log(`Added ${toAdd.length} to pending. Total pending: ${updatedPending.length}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  enrichQuotedTweetArticles,
  fetchWithXAPI
};
