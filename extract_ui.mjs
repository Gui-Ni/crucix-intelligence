// Extract all UI hardcoded strings from jarvis.html
import { readFileSync } from 'fs';

const html = readFileSync('dashboard/public/jarvis.html', 'utf8');

// Extract text from title, h1-h6, button, span, div, label, p tags
const tagRegex = /<(?:title|h[1-6]|button|span|div|label|p|th|td)[^>]*>([^<]+)<\/[a-z]+>/gi;
const uiStrings = new Set();

let match;
while ((match = tagRegex.exec(html)) !== null) {
  const text = match[1].trim();
  if (text && text.length > 1 && /[a-zA-Z]{2,}/.test(text) && !text.includes('<') && !text.includes('{')) {
    // Exclude URLs and code-like strings
    if (!text.startsWith('http') && !text.includes('${') && !text.includes('{{')) {
      uiStrings.add(text);
    }
  }
}

// Also extract from data attributes and aria-labels
const ariaRegex = /aria-label=["']([^"']+)["']/gi;
while ((match = ariaRegex.exec(html)) !== null) {
  const text = match[1].trim();
  if (text && text.length > 1) uiStrings.add(text);
}

// Also from button text content and other known patterns
const btnRegex = /class="[^"]*btn[^"]*"[^>]*>([^<]+)</gi;
while ((match = btnRegex.exec(html)) !== null) {
  const text = match[1].trim();
  if (text && text.length > 1) uiStrings.add(text);
}

// Sort and output
const sorted = [...uiStrings].sort();
sorted.forEach(s => console.log(JSON.stringify(s)));
