// Builds v116/index.html: the v1.16 test terminal (separate storage 'twm116.*') with its engine and the shared robot inlined.
const fs = require('fs'), path = require('path');
let out = fs.readFileSync(path.join(__dirname, 'web.html'), 'utf8');
for (const [name, file] of [['moxie-engine.js', path.join(__dirname, 'moxie-engine.js')], ['royal-robot.js', path.join(__dirname, '..', 'engine', 'royal-robot.js')]]) {
  const tag = `<script src="${name}"></script>`;
  if (!out.includes(tag)) throw new Error(name + ' tag missing');
  out = out.replace(tag, () => '<script>\n' + fs.readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script') + '\n</script>');
}
fs.writeFileSync(path.join(__dirname, 'index.html'), out);
console.log('v116/index.html', (out.length / 1024).toFixed(1) + ' KB');
