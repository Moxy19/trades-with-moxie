// Builds the single-file terminal: dist/TradesWithMoxie.html (engine inlined, opens straight in Chrome).
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8');
const eng = fs.readFileSync(path.join(__dirname, 'engine', 'moxie-engine.js'), 'utf8');
const tag = '<script src="moxie-engine.js"></script>';
if (!html.includes(tag)) throw new Error('engine tag missing');
const out = html.replace(tag, () => '<script>\n' + eng.replace(/<\/script/gi, '<\\/script') + '\n</script>');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'TradesWithMoxie.html'), out);
console.log('dist/TradesWithMoxie.html', (out.length / 1024).toFixed(1) + ' KB');
