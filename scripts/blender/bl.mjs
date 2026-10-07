// Run a Python file (or -e "code") inside Blender through the Blender MCP add-on socket (localhost:9876).
//   node scripts/blender/bl.mjs <file.py> [NAME=value ...]     (each NAME=value is defined as a Python string first)
//   node scripts/blender/bl.mjs -e "import bpy; print(bpy.app.version_string)"
// Protocol (add-on mcp_to_blender_server.py): {"type":"execute","code":…,"strict_json":false} + "\0"; reply + "\0".
import net from 'node:net'
import fs from 'node:fs'

const args = process.argv.slice(2)
const inline = args[0] === '-e'
const defs = args.slice(1).map((a) => {
  const i = a.indexOf('=')
  return `${a.slice(0, i)} = ${JSON.stringify(a.slice(i + 1))}\n`
})
const code = (inline ? '' : defs.join('')) + (inline ? args[1] : fs.readFileSync(args[0], 'utf8'))
const s = net.connect(Number(process.env.BLENDER_PORT || 9876), '127.0.0.1', () => s.write(JSON.stringify({ type: 'execute', code, strict_json: false }) + '\0'))
let buf = ''
s.on('data', (d) => {
  buf += d
  const end = buf.indexOf('\0')
  if (end < 0) return
  const r = JSON.parse(buf.slice(0, end))
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status === 'error') console.error(r.message)
  s.end()
  process.exit(r.status === 'error' ? 1 : 0)
})
s.on('error', (e) => {
  console.error(`Blender MCP socket: ${e.message} (is Blender running with the MCP add-on server started?)`)
  process.exit(2)
})
