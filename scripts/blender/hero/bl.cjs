// Send Python code (file arg) to the Blender MCP addon socket (localhost:9876, NUL-terminated JSON) and print the result.
const net = require('net'), fs = require('fs')
const code = fs.readFileSync(process.argv[2], 'utf8')
const s = net.connect(9876, 'localhost', () => s.write(JSON.stringify({ type: 'execute', code, strict_json: false }) + '\0'))
let buf = ''
s.setTimeout(1800000)
const done = () => {
  const txt = buf.replace(/\0+$/, '')
  if (process.env.RAW) console.log(txt)
  try { const r = JSON.parse(txt); if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stdout.write('STDERR: ' + r.stderr); if (r.result !== undefined && r.result !== null) console.log('RESULT:', typeof r.result === 'string' ? r.result : JSON.stringify(r.result)); if (r.status === 'error') console.log('ERROR:', r.message); process.exit(r.status === 'error' ? 1 : 0) }
  catch { console.log('UNPARSED:', txt.slice(0, 2000)); process.exit(4) }
}
s.on('data', d => { buf += d; if (buf.endsWith('\0')) { s.end(); done() } })
s.on('close', () => { if (buf) done(); else { console.log('CLOSED empty'); process.exit(5) } })
s.on('timeout', () => { console.log('TIMEOUT'); process.exit(2) })
s.on('error', e => { console.log('ERR', e.message); process.exit(3) })
