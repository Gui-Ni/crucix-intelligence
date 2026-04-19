const fs = require('fs');
const content = fs.readFileSync('C:/Users/admin/.openclaw/workspace/projects/Crucix/server.mjs', 'utf8');
console.log('Total chars:', content.length);
// Find all app.get calls
const matches = content.match(/app\.get\([^)]+\)/g);
console.log('app.get calls:', JSON.stringify(matches));
// Find jarvis
console.log('Contains jarvis.html:', content.includes('jarvis.html'));
console.log('Contains __CRUX_LOCALES__:', content.includes('__CRUX_LOCALES__'));
