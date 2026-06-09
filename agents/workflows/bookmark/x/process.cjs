#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');
const { STATE_DIR, getPending, setPending, addProcessed } = require('./lib/state.cjs');
const { extractDomain, slugify } = require('./lib/categorize.cjs');

const BOOKMARKS_DIR = process.env.OPENCLAW_WORKSPACE
  ? path.join(process.env.OPENCLAW_WORKSPACE, 'brain', 'bookmarks', 'x')
  : path.join(process.env.HOME || '/root', '.openclaw', 'workspace', 'brain', 'bookmarks', 'x');

// Channel taxonomy passed to MiniMax each call.
const CHANNEL_TAGS = {
  'infra': [
    'openclaw', 'infra', 'infrastructure', 'disk usage', 'cpu usage', 'memory usage',
    'network usage', 'self-hosted', 'deployment', 'devops', 'tooling', 'prompts', 'tools', 'scripts'
  ],
  'brain': [
    'obsidian', 'second brain', 'pkm', 'knowledge base', 'memory',
    'embeddings', 'vector database', 'vector search', 'rag'
  ],
  'personal': [
    'travel', 'family', 'health', 'fitness', 'lifestyle', 'learning',
    'academy', 'certification', 'course', 'training'
  ],
  'app-assistant': [
    'meeting notes', 'ai notes', 'meeting templates', 'calendar', 'transcript', 'summarization', 'granola'
  ],
  'app-tasks': [
    'workflow', 'tasks', 'task management', 'task tracking', 'automation',
    'kanban', 'todo', 'project management', 'product management', 'roadmap', 'backlog'
  ],
  'crypto': [
    'crypto', 'blockchain', 'bitcoin', 'ethereum', 'wallet', 'exchange',
    'defi', 'web3', 'x402'
  ],
  'outreach': [
    'social media', 'content creation', 'audience', 'marketing', 'growth', 'distribution'
  ],
  'general': [
    '*'
  ]
};

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

function logTagsToCSV({ id, title, tags, summary, originalTweet, url, channel }) {
  const normalizedTags = normalizeTags(tags);
  const processedAt = new Date().toISOString();
  const domain = extractDomain(url || '');

  const csvPath = path.join(STATE_DIR, 'x-bookmark-tags-log.csv');
  const header = 'processed_at,id,title,channel,tags_csv,tags_count,domain,url,,summary,original_tweet';
  ensureCsvWithHeader(csvPath, header);

  const row = [
    csvEscape(processedAt),
    csvEscape(id),
    csvEscape(title),
    csvEscape(channel),
    csvEscape(normalizedTags.join(';')),
    csvEscape(normalizedTags.length),
    csvEscape(domain),
    csvEscape(url),
    csvEscape(summary),
    csvEscape(originalTweet)
  ].join(',') + '\n';

  fs.appendFileSync(csvPath, row);
}

function fetchTitleWithModule(mod, url, redirectDepth = 0) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = mod.get(url, { timeout: 6000 }, (res) => {
      // handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectDepth < 5) {
        const nextUrl = new URL(res.headers.location, url).toString();
        const nextMod = nextUrl.startsWith('https:') ? https : http;
        fetchTitleWithModule(nextMod, nextUrl, redirectDepth + 1).then(done);
        res.resume();
        return;
      }

      let data = '';
      res.on('data', chunk => {
        if (settled) return;
        data += chunk;
        if (data.length > 20000) {
          const match = data.match(/<title>([^<]+)<\/title>/i);
          done(match ? match[1].trim() : null);
          res.destroy();
        }
      });
      res.on('end', () => {
        const match = data.match(/<title>([^<]+)<\/title>/i);
        done(match ? match[1].trim() : null);
      });
      res.on('close', () => {
        const match = data.match(/<title>([^<]+)<\/title>/i);
        done(match ? match[1].trim() : null);
      });
      res.on('error', () => done(null));
    });

    req.on('error', () => done(null));
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
  });
}

async function fetchURLTitle(url, isTweetLink = false) {
  if (isTweetLink) return null;
  const mod = String(url || '').startsWith('http:') ? http : https;
  return fetchTitleWithModule(mod, url);
}

function getAcpxCommand() {
  return (process.env.BOOKMARK_LLM_ACPX_COMMAND || '/opt/homebrew/bin/acpx').trim();
}

function pickChannel({ url, title, tweetText, summary, tags }) {
  const haystack = [url, title, tweetText, summary, ...(tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let best = { channel: 'general', score: 0 };
  for (const [channel, terms] of Object.entries(CHANNEL_TAGS)) {
    if (channel === 'general') continue;
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(String(term).toLowerCase())) score += 1;
    }
    if (score > best.score) best = { channel, score };
  }

  return best.score > 0 ? best.channel : 'general';
}

async function generateMetadata(url, tweetText, isTweetLink = false) {
  let title;
  if (isTweetLink) {
    title = (tweetText || '').split('\n')[0].substring(0, 80);
  } else {
    title = await fetchURLTitle(url) || slugify((tweetText || '').substring(0, 80));
  }

  const domain = extractDomain(url);
  const text = String(tweetText || '');
  const MAX_LLM_CHARS = Number(process.env.BOOKMARK_LLM_MAX_CHARS || 12000);
  const llmText = text.length > MAX_LLM_CHARS
    ? `${text.slice(0, Math.floor(MAX_LLM_CHARS * 0.75))}\n\n...[truncated for classification]...\n\n${text.slice(-Math.floor(MAX_LLM_CHARS * 0.25))}`
    : text;

  function callViaAcpx() {
    const acpxCommand = getAcpxCommand();
    const model = (process.env.BOOKMARK_LLM_MODEL || 'minimax').trim();
    const timeoutMs = parseInt(process.env.BOOKMARK_LLM_TIMEOUT_SECONDS || '120', 10) * 1000;
    const prompt = [
      'You are classifying X bookmarks for a second brain.',
      `Return STRICT JSON only: {"summary":"...","tags":["..."],"channel":"..."}.`,
      '- summary: 2-4 concise sentences',
      '- tags: 3-8 lowercase tags',
      `- channel must be one of: ${Object.keys(CHANNEL_TAGS).join(', ')}`,
      '- if unsure, set channel to "general"',
      `Channel hints: ${JSON.stringify(CHANNEL_TAGS)}`,
      '',
      `URL: ${url}`,
      `Title: ${title || ''}`,
      `Tweet Text:\n${llmText}`
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
    const summary = String(parsed.summary || '').trim();
    const llmChannel = String(parsed.channel || '').trim().toLowerCase();
    const guessedChannel = pickChannel({ url, title, tweetText: llmText, summary, tags });
    const channel = Object.hasOwn(CHANNEL_TAGS, llmChannel) ? llmChannel : guessedChannel;

    return {
      summary: summary || text.substring(0, 300),
      tags: tags.length ? tags : ['needs-review'],
      channel,
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
  const fallbackSummary = (tweetText || '').substring(0, 300);

  return {
    summary: fallbackSummary,
    tags: fallbackTags,
    channel: pickChannel({ url, title, tweetText, summary: fallbackSummary, tags: fallbackTags }),
    title
  };
}

async function processBookmark(bookmark) {
  let url = bookmark.url || bookmark.expandedUrl;
  let isTweetLink = false;

  if (!url) {
    url = `https://x.com/i/web/status/${bookmark.id}`;
    isTweetLink = true;
  }

  const metadata = await generateMetadata(url, bookmark.text || '', isTweetLink);
  const channel = metadata.channel || 'general';
  const categoryDir = path.join(BOOKMARKS_DIR, channel);
  ensureDir(categoryDir);

  logTagsToCSV({
    id: bookmark.id,
    title: metadata.title,
    tags: metadata.tags,
    summary: metadata.summary,
    originalTweet: bookmark.text,
    url,
    channel
  });

  const date = new Date().toISOString().split('T')[0];
  const safeTags = normalizeTags(metadata.tags);

  const frontmatter = `---
title: "${metadata.title || bookmark.id}"
type: ${channel}
date_archived: ${date}
source_tweet: https://x.com/i/web/status/${bookmark.id}
link: ${url}
tags: [${safeTags.map(t => `"${t}"`).join(', ')}]
---

${metadata.summary}

---

**Original Tweet:**
${bookmark.text || 'N/A'}
`;

  const filename = path.join(categoryDir, `${slugify(metadata.title || String(bookmark.id))}.md`);
  fs.writeFileSync(filename, frontmatter);

  console.log(`Archived: ${metadata.title || bookmark.id} -> ${channel}/`);
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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
