const fs = require('fs');
const lines = fs.readFileSync('C:/Users/admin/.openclaw/workspace/projects/Crucix/server.mjs', 'utf8').split('\n');
for (let i = 257; i < 275; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}
