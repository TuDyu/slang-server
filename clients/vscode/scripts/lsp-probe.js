// Minimal LSP client used to verify server behaviour from the command line.
// Usage: node probe.js <slang-server> <workspace> [catalog|diags]
const { spawn } = require('child_process')

const [, , serverPath, root, mode = 'diags'] = process.argv
const child = spawn(serverPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
let err = ''
child.stderr.on('data', (d) => (err += d.toString()))

const rootUri = 'file:///' + root.replace(/\\/g, '/')
let buf = Buffer.alloc(0)
const diags = []
let started = false

function send(o) {
  const s = JSON.stringify(o)
  child.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`)
}

child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  for (;;) {
    const he = buf.indexOf('\r\n\r\n')
    if (he < 0) return
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, he).toString())
    if (!m) {
      buf = buf.slice(he + 4)
      continue
    }
    const len = parseInt(m[1], 10)
    if (buf.length < he + 4 + len) return
    const msg = JSON.parse(buf.slice(he + 4, he + 4 + len).toString())
    buf = buf.slice(he + 4 + len)

    if (msg.id === 1 && !started) {
      started = true
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })
      if (mode === 'catalog') {
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'workspace/executeCommand',
          params: { command: 'slang.getConfigCatalog', arguments: [] },
        })
      } else {
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri: rootUri + '/warn.sv',
              languageId: 'systemverilog',
              version: 1,
              text:
                'module top;\n    int unused_thing;\n    localparam int a = 1;\n' +
                '    localparam bit b = a;\nendmodule\n',
            },
          },
        })
      }
    }

    if (msg.id === 2 && msg.result) {
      const r = msg.result
      console.log('catalog entries:', r.diagnostics.length)
      console.log('effective:', JSON.stringify(r.effectiveDiagnostics))
      const unused = r.diagnostics.find((d) => d.code === 'unused-variable')
      console.log('unused-variable:', unused ? `${unused.subsystem} [${unused.groups}]` : 'missing')
    }

    if (msg.method === 'textDocument/publishDiagnostics') diags.push(...msg.params.diagnostics)
  }
})

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'w' }],
    capabilities: { textDocument: {} },
  },
})

setTimeout(() => {
  if (mode !== 'catalog') {
    const uniq = [...new Map(diags.map((d) => [d.code + d.message, d])).values()]
    if (uniq.length === 0) console.log('(no diagnostics)')
    for (const d of uniq) console.log(`  [${d.severity}] ${d.code}: ${d.message}`)
    const warnings = err.split('\n').filter((l) => /WARN|ERROR/.test(l))
    if (warnings.length) console.log('server:', warnings.join(' | ').slice(0, 300))
  }
  child.kill()
  process.exit(0)
}, 9000)
