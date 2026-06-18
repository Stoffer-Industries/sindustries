#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');
const { STATE_DIR, getPending, setPending, addProcessed } = require('./lib/state.cjs');
const { extractDomain, slugify } = require('./lib/categorize.cjs');
const {
  extractArticleText,
  extractTitle,
  truncateUtf8
} = require('./lib/extract_article.cjs');

const BOOKMARKS_DIR = process.env.OPENCLAW_WORKSPACE
  ? path.join(process.env.OPENCLAW_WORKSPACE, 'brain', 'bookmarks', 'x')
  : path.join(process.env.HOME || '/root', '.openclaw', 'workspace', 'brain', 'bookmarks', 'x');


function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value) {
  const str = value == null ? '' : String(value)
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
  return `"${str.replace(/"/g, '""')}"`;
}

function normalizeTags(tags = []) {
  const banned = new Set(['x', 'twitter', 'x.com', 'tweet', 'tweets']);
  return [...new Set(
    (Array.isArray(tags) ? tags : [])
      .map(tag => String(tag || '').trim().toLowerCase())
      .filter(Boolean)
      .filter(tag => !banned.has(tag))
  )];
}

function extractJsonObject(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const slice = candidate.slice(first, last + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function ensureCsvWithHeader(csvPath, header) {
  ensureDir(path.dirname(csvPath));
  if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0) {
    fs.writeFileSync(csvPath, `${header}\n`);
    return;
  }

  const firstLine = fs.readFileSync(csvPath, 'utf8').split('\n')[0].trim();
  if (firstLine !== header) {
    const backupPath = `${csvPath}.backup-${Date.now()}`;
    fs.renameSync(csvPath, backupPath);
    fs.writeFileSync(csvPath, `${header}\n`);
    console.log(`Backed up legacy tags log to: ${backupPath}`);
  }
}

function logTagsToCSV({ id, title, tags, originalTweet, url }) {
  const normalizedTags = normalizeTags(tags);
  const processedAt = new Date().toISOString();
  const domain = extractDomain(url || '');

  const csvPath = path.join(STATE_DIR, 'x-bookmark-tags-log.csv');
  const header = 'processed_at,id,title,tags_csv,tags_count,domain,url,original_tweet';
  ensureCsvWithHeader(csvPath, header);

  const row = [
    csvEscape(processedAt),
    csvEscape(id),
    csvEscape(title),
    csvEscape(normalizedTags.join(';')),
    csvEscape(normalizedTags.length),
    csvEscape(domain),
    csvEscape(url),
    csvEscape(originalTweet)
  ].join(',') + '\n';

  fs.appendFileSync(csvPath, row);
}

const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);

function softWarn(url, reason) {
  console.warn(`Linked article skipped for ${url}: ${reason}`);
}

function positiveIntFromEnv(name, fallback) {
  const value = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isTweetStatusUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return ['x.com', 'twitter.com', 'mobile.twitter.com'].includes(hostname)
      && /\/status\/\d+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function fetchPageWithModule(mod, url, redirectDepth = 0) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timeoutMs = positiveIntFromEnv('BOOKMARK_INGEST_FETCH_TIMEOUT_MS', 12000);
    const maxHtmlBytes = positiveIntFromEnv('BOOKMARK_INGEST_MAX_HTML_BYTES', 2 * 1024 * 1024);
    const req = mod.get(url, {
      timeout: timeoutMs,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'StofferIndustriesBookmarkIngest/1.0'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectDepth < 5) {
        const nextUrl = new URL(res.headers.location, url).toString();
        const nextMod = nextUrl.startsWith('https:') ? https : http;
        fetchPageWithModule(nextMod, nextUrl, redirectDepth + 1).then(done);
        res.resume();
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        done({ ok: false, error: `HTTP ${res.statusCode}` });
        return;
      }

      const contentType = String(res.headers['content-type'] || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
      if (!HTML_CONTENT_TYPES.has(contentType)) {
        res.resume();
        done({
          ok: false,
          error: `unsupported Content-Type ${contentType || '(missing)'}`
        });
        return;
      }

      const chunks = [];
      let receivedBytes = 0;
      res.on('data', chunk => {
        if (settled) return;
        receivedBytes += chunk.length;
        if (receivedBytes > maxHtmlBytes) {
          done({ ok: false, error: `HTML exceeded ${maxHtmlBytes} bytes` });
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        done({
          ok: true,
          finalUrl: url,
          html,
          title: extractTitle(html)
        });
      });
      res.on('error', error => done({ ok: false, error: error.message }));
    });

    req.on('error', error => done({ ok: false, error: error.message }));
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, error: `request timed out after ${timeoutMs}ms` });
    });
  });
}

async function fetchLinkedArticle(url) {
  const mod = String(url || '').startsWith('http:') ? http : https;
  const page = await fetchPageWithModule(mod, url);
  if (!page.ok) {
    softWarn(url, page.error);
    return { title: null, article: null, error: page.error };
  }

  try {
    const extracted = extractArticleText(page.html);
    if (!extracted) {
      const error = 'body extraction returned no text';
      softWarn(url, error);
      return { title: page.title, article: null, error };
    }

    const maxBodyBytes = positiveIntFromEnv('BOOKMARK_INGEST_MAX_BODY_BYTES', 200 * 1024);
    return {
      title: page.title,
      article: {
        body: truncateUtf8(extracted, maxBodyBytes),
        domain: extractDomain(page.finalUrl || url),
        fetchedAt: new Date().toISOString(),
        url: page.finalUrl || url
      },
      error: null
    };
  } catch (error) {
    softWarn(url, `body extraction failed: ${error.message}`);
    return { title: page.title, article: null, error: error.message };
  }
}

function getAcpxCommand() {
  return (process.env.BOOKMARK_LLM_ACPX_COMMAND || '/opt/homebrew/bin/acpx').trim();
}

function truncateForLlm(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const marker = '\n\n...[truncated]...\n\n';
  const available = Math.max(0, maxChars - marker.length);
  const startChars = Math.floor(available * 0.75);
  const endChars = available - startChars;
  return `${text.slice(0, startChars)}${marker}${text.slice(-endChars)}`.slice(0, maxChars);
}

async function generateMetadata(url, tweetText, isTweetLink = false, linkedArticle = null, fetchedTitle = null) {
  let title;
  if (isTweetLink) {
    title = (tweetText || '').split('\n')[0].substring(0, 80);
  } else {
    title = fetchedTitle || slugify((tweetText || '').substring(0, 80));
  }

  const domain = extractDomain(url);
  const MAX_LLM_CHARS = positiveIntFromEnv('BOOKMARK_LLM_MAX_CHARS', 12000);
  const articleForLlm = linkedArticle
    ? String(linkedArticle.body || '').slice(0, 10000)
    : '';
  const combinedText = [
    `Tweet Text:\n${String(tweetText || '')}`,
    articleForLlm ? `Linked Article:\n${articleForLlm}` : ''
  ].filter(Boolean).join('\n\n');
  const llmText = truncateForLlm(combinedText, MAX_LLM_CHARS);

  function callViaAcpx() {
    const acpxCommand = getAcpxCommand();
    const model = (process.env.BOOKMARK_LLM_MODEL || 'minimax').trim();
    const timeoutMs = parseInt(process.env.BOOKMARK_LLM_TIMEOUT_SECONDS || '120', 10) * 1000;
    const prompt = [
      'You are tagging X bookmarks for a second brain.',
      'Return STRICT JSON only: {"tags":["..."]}.',
      '- tags: 3-8 lowercase keyword tags describing the content',
      '- no topic classification, no summary, just tags',
      '',
      `URL: ${url}`,
      `Title: ${title || ''}`,
      llmText
    ].join('\n');

    const result = spawnSync(
      acpxCommand,
      ['--approve-all', '--format', 'quiet', '--model', model, 'codex', 'exec', '-f', '-'],
      {
        input: prompt,
        encoding: 'utf8',
        timeout: timeoutMs,
        cwd: process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw', 'workspace')
      }
    );

    if (result.error) throw new Error(`acpx exec error: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().slice(0, 240);
      throw new Error(`acpx exited ${result.status}: ${detail}`);
    }

    const raw = (result.stdout || '').trim();
    if (!raw) throw new Error('acpx returned empty output');

    const parsed = extractJsonObject(raw);
    if (!parsed) throw new Error('acpx output did not contain valid JSON');

    const tags = normalizeTags(parsed.tags || []);

    return {
      tags: tags.length ? tags : ['needs-review'],
      title
    };
  }

  try {
    // Retry once before fallback to reduce transient failures
    try {
      return callViaAcpx();
    } catch (firstErr) {
      console.log('acpx first attempt failed, retrying:', firstErr.message);
      return callViaAcpx();
    }
  } catch (e) {
    console.log('acpx generation failed:', e.message);
  }

  const baseDomainTag = (domain || '').replace(/^www\./, '').split('.')[0];
  const fallbackTags = normalizeTags([
    baseDomainTag && baseDomainTag !== 'x' ? baseDomainTag : '',
    'needs-review'
  ].filter(Boolean));

  return {
    tags: fallbackTags,
    title
  };
}

async function processBookmark(bookmark) {
  ensureDir(BOOKMARKS_DIR);

  let url = bookmark.url || bookmark.expandedUrl;
  let isTweetLink = isTweetStatusUrl(url);
  // The bookmarked tweet's own article is primary content. A quoted article
  // is used only when the bookmark does not carry a direct article body.
  const quotedArticle = !bookmark.article?.plain_text
    ? bookmark.linkedArticle
    : null;

  if (!url) {
    url = `https://x.com/i/web/status/${bookmark.id}`;
    isTweetLink = true;
  }

  const linkedPage = quotedArticle
    ? { title: quotedArticle.title || null, article: null }
    : isTweetLink
    ? { title: null, article: null }
    : await fetchLinkedArticle(url);
  const selectedArticle = quotedArticle || linkedPage.article;
  const metadata = await generateMetadata(
    url,
    bookmark.text || '',
    isTweetLink,
    selectedArticle,
    quotedArticle?.title || linkedPage.title
  );

  logTagsToCSV({
    id: bookmark.id,
    title: metadata.title,
    tags: metadata.tags,
    originalTweet: bookmark.text,
    url
  });

  const date = new Date().toISOString().split('T')[0];
  const safeTags = normalizeTags(metadata.tags);

  const linkedArticleSection = quotedArticle
    ? `

**Linked Article:** (from quoted tweet)
Title: ${quotedArticle.title || 'N/A'}
Source: ${quotedArticle.sourceUrl || 'N/A'}
Body:
${quotedArticle.body}
`
    : linkedPage.article
    ? `

**Linked Article:**
Source: ${linkedPage.article.url}
Domain: ${linkedPage.article.domain}
Fetched: ${linkedPage.article.fetchedAt}

${linkedPage.article.body}
`
    : '';

  const frontmatter = `---
title: "${metadata.title || bookmark.id}"
source: x
date_archived: ${date}
source_tweet: https://x.com/i/web/status/${bookmark.id}
link: ${url}
tags: [${safeTags.map(t => `"${t}"`).join(', ')}]
---

**Original Tweet:**
${bookmark.text || 'N/A'}
${linkedArticleSection}
`;

  const filename = path.join(BOOKMARKS_DIR, `${slugify(metadata.title || String(bookmark.id))}.md`);
  fs.writeFileSync(filename, frontmatter);

  console.log(`Archived: ${metadata.title || bookmark.id}`);
  return bookmark.id;
}

async function main() {
  console.log('Processing pending bookmarks...');
  ensureDir(BOOKMARKS_DIR);

  const pending = getPending();
  if (pending.length === 0) {
    console.log('No pending bookmarks.');
    return;
  }

  console.log(`Processing ${pending.length} bookmarks...`);

  const processed = [];
  for (const bookmark of pending) {
    try {
      const id = await processBookmark(bookmark);
      if (id) processed.push(id);
    } catch (e) {
      console.error(`Error processing ${bookmark.id}:`, e.message);
    }
  }

  addProcessed(processed);
  const remaining = pending.filter(b => !processed.includes(b.id));
  setPending(remaining);

  console.log(`Done. Processed: ${processed.length}, Remaining: ${remaining.length}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  fetchLinkedArticle,
  generateMetadata,
  processBookmark,
  truncateForLlm
};
