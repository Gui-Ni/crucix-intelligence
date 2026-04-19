const {readFileSync, existsSync} = require('fs');
const {join} = require('path');
const ROOT = 'C:/Users/admin/.openclaw/workspace/projects/Crucix';
const zhPath = join(ROOT, 'locales/zh.json');
const zhSize = existsSync(zhPath) ? readFileSync(zhPath, 'utf-8').length : 0;
console.log('zh.json size:', zhSize, 'bytes');
const html = readFileSync(join(ROOT, 'dashboard/public/jarvis.html'), 'utf-8');
console.log('ALL_LOCALES uses CRUX_LOCALES:', html.includes('window.__CRUX_LOCALES__'));
console.log('syncLocale exists:', html.includes('function syncLocale'));
const langMatch = html.match(/let currentLang = [^;]+;/);
console.log('currentLang default:', langMatch ? langMatch[0] : 'NOT FOUND');
const server = readFileSync(join(ROOT, 'server.mjs'), 'utf-8');
console.log('/jarvis.html route in server:', server.includes("/jarvis.html"));
// Check if zh locale is properly read by the server
const serverLocales = server.match(/supportedCodes = \[[^\]]+\]/);
console.log('supportedCodes:', serverLocales ? serverLocales[0] : 'NOT FOUND');
// Test: what would ALL_LOCALES be on page load?
const allLocalesMatch = html.match(/const ALL_LOCALES = \{[^}]+\}/);
console.log('ALL_LOCALES:', allLocalesMatch ? allLocalesMatch[0].slice(0, 100) : 'NOT FOUND');
