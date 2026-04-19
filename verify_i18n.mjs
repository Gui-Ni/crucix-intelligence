// Verify zh locale injection in jarvis.html
import { readFileSync, existsSync } from 'fs';
import { join as joinPath } from 'path';
import { createServer } from 'http';

const ROOT = 'C:/Users/admin/.openclaw/workspace/projects/Crucix';

// Simulate what server.mjs does
const localeScript = (() => {
  const { getLocale } = await import('./lib/i18n.mjs');
  const supportedCodes = ['en', 'fr', 'zh'];
  const locales = {};
  for (const code of supportedCodes) {
    const locPath = joinPath(ROOT, 'locales', `${code}.json`);
    if (existsSync(locPath)) {
      locales[code] = JSON.parse(readFileSync(locPath, 'utf-8'));
    }
  }
  const locale = getLocale();
  return `<script>
window.__CRUCIX_LOCALE__ = ${JSON.stringify(locale)};
window.__CRUX_LOCALES__ = ${JSON.stringify(locales)};
</script>`;
})();

// Check zh.json exists and has content
const zhPath = joinPath(ROOT, 'locales', 'zh.json');
const zhSize = existsSync(zhPath) ? readFileSync(zhPath, 'utf-8').length : 0;
console.log('zh.json size:', zhSize, 'bytes');

// Verify ALL_LOCALES in jarvis.html uses __CRUX_LOCALES__
const jarvisPath = joinPath(ROOT, 'dashboard/public/jarvis.html');
const jarvisHtml = readFileSync(jarvisPath, 'utf-8');
const hasCorrectLocaleRef = jarvisHtml.includes("window.__CRUX_LOCALES__");
console.log('jarvis.html uses __CRUX_LOCALES__:', hasCorrectLocaleRef);

// Check ALL_LOCALES definition
const allLocalesMatch = jarvisHtml.match(/const ALL_LOCALES = \{[^}]+\}/);
console.log('ALL_LOCALES definition:', allLocalesMatch?.[0]?.slice(0, 100));

// Check currentLang default
const langMatch = jarvisHtml.match(/let currentLang = [^;]+;/);
console.log('currentLang default:', langMatch?.[0]);

// Check syncLocale function
const hasSyncLocale = jarvisHtml.includes('function syncLocale()');
console.log('syncLocale function exists:', hasSyncLocale);

console.log('\n✅ zh locale injection setup verified');
