// Builds the single-file terminal: dist/RoyalTrades.html (engine and robot inlined, opens straight in Chrome).
const fs = require('fs'), path = require('path');
let out = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8');
for (const name of ['moxie-engine.js', 'royal-robot.js']) {
  const tag = `<script src="${name}"></script>`;
  if (!out.includes(tag)) throw new Error(name + ' tag missing');
  const code = fs.readFileSync(path.join(__dirname, 'engine', name), 'utf8');
  out = out.replace(tag, () => '<script>\n' + code.replace(/<\/script/gi, '<\\/script') + '\n</script>');
}
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'RoyalTrades.html'), out);
console.log('dist/RoyalTrades.html', (out.length / 1024).toFixed(1) + ' KB');
