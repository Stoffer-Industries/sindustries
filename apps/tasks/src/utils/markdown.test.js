import { describe, it, expect } from 'vitest';
import { renderMarkdown, toggleMarkdownTaskCheckbox } from '../utils/markdown.js';

describe('renderMarkdown', () => {
  it('renders empty string for null/undefined input', () => {
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
    expect(renderMarkdown('')).toBe('');
  });

  it('renders bold text', () => {
    const html = renderMarkdown('**bold text**');
    expect(html).toContain('<strong>bold text</strong>');
  });

  it('renders italic text', () => {
    const html = renderMarkdown('*italic text*');
    expect(html).toContain('<em>italic text</em>');
  });

  it('renders links', () => {
    const html = renderMarkdown('[example](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('>example</a>');
  });

  it('renders code blocks', () => {
    const html = renderMarkdown('```\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
    expect(html).toContain('const x = 1;');
  });

  it('renders inline code', () => {
    const html = renderMarkdown('use `const` keyword');
    expect(html).toContain('<code>const</code>');
  });

  it('renders unordered lists', () => {
    const html = renderMarkdown('- item 1\n- item 2');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>item 1</li>');
    expect(html).toContain('<li>item 2</li>');
  });

  it('renders ordered lists', () => {
    const html = renderMarkdown('1. first\n2. second');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>first</li>');
  });

  it('renders headers', () => {
    const html = renderMarkdown('# H1\n## H2\n### H3');
    expect(html).toContain('<h1>H1</h1>');
    expect(html).toContain('<h2>H2</h2>');
    expect(html).toContain('<h3>H3</h3>');
  });

  it('renders blockquotes', () => {
    const html = renderMarkdown('> quoted text');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('quoted text');
  });

  it('renders GFM task checkboxes', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo');
    expect(html).toContain('type="checkbox"');
  });

  it('sanitizes XSS attacks', () => {
    const html = renderMarkdown('<script>alert("xss")</script>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert');
  });

  it('sanitizes event handler attributes', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('allows safe anchor tags with target', () => {
    const html = renderMarkdown('[link](https://safe.com)');
    expect(html).toContain('<a');
    expect(html).toContain('href="https://safe.com"');
  });

  it('renders tables (GFM)', () => {
    const md = '| Col A | Col B |\n| --- | --- |\n| val1 | val2 |';
    const html = renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Col A</th>');
    expect(html).toContain('<td>val1</td>');
  });

  it('handles plain text without errors', () => {
    const html = renderMarkdown('just plain text');
    expect(html).toContain('just plain text');
  });
});

describe('toggleMarkdownTaskCheckbox', () => {
  it('toggles the requested markdown task-list checkbox', () => {
    expect(toggleMarkdownTaskCheckbox('- [ ] first\n- [x] second', 0, true)).toBe('- [x] first\n- [x] second');
    expect(toggleMarkdownTaskCheckbox('- [ ] first\n- [x] second', 1, false)).toBe('- [ ] first\n- [ ] second');
  });

  it('preserves non-checkbox lines and returns original text when index is missing', () => {
    const markdown = 'Intro\n- [ ] task\nOutro';
    expect(toggleMarkdownTaskCheckbox(markdown, 4, true)).toBe(markdown);
  });
});
