const ENTITY_MAP = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’'
};

function decodeHtmlEntities(value = '') {
  return String(value).replace(
    /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi,
    (entity, code) => {
      if (code[0] === '#') {
        const isHex = code[1].toLowerCase() === 'x';
        const number = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        if (!Number.isFinite(number) || number <= 0 || number > 0x10ffff) return entity;
        try {
          return String.fromCodePoint(number);
        } catch {
          return entity;
        }
      }
      return ENTITY_MAP[code.toLowerCase()] ?? entity;
    }
  );
}

function extractTitle(html = '') {
  const match = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function extractArticleText(html = '') {
  let text = String(html);
  if (!text.trim()) return '';

  text = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|nav|p|pre|section|table|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || '');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const suffix = '\n\n...[truncated]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (suffixBytes >= maxBytes) {
    return suffix.slice(0, maxBytes);
  }
  const available = Math.max(0, maxBytes - suffixBytes);
  let end = Math.min(text.length, available);

  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > available) {
    end -= Math.max(1, Math.ceil((Buffer.byteLength(text.slice(0, end), 'utf8') - available) / 2));
  }

  return `${text.slice(0, end).trimEnd()}${suffix}`;
}

module.exports = {
  decodeHtmlEntities,
  extractArticleText,
  extractTitle,
  truncateUtf8
};
