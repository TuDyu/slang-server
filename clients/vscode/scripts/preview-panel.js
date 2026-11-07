// Build a standalone copy of the configuration webview so it can be exercised in a
// browser. Not part of the extension build; used for manual UI verification.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src', 'lib', 'configPanel.ts'), 'utf8')

const marker = 'return `<!DOCTYPE html>'
const start = source.indexOf(marker)
const endMarker = '</html>`'
const end = source.indexOf(endMarker, start)
if (start < 0 || end < 0) {
  console.error('webview template not found')
  process.exit(1)
}

let html = source.substring(start + marker.length, end + '</html>'.length)

// The real webview gets a nonce and the VS Code API from the host. Standalone copies
// simplify both so the page can run from disk.
html = html.replace('${webview.cspSource}', "'unsafe-inline'")
html = html.replace(/script-src 'nonce-\$\{nonce\}'/, "script-src 'unsafe-inline'")
html = html.replace(/\$\{nonce\}/g, 'test-nonce')

const harness = `<script>
  window.__posted = []
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m) })
  window.addEventListener('load', () => {
    window.postMessage({
      type: 'state',
      scopes: [
        { id: 'workspace', label: '.slang/server.json', role: 'shared, tracked in git',
          path: 'D:\\\\proj\\\\.slang\\\\server.json', exists: true },
        { id: 'local', label: '.slang/local/server.json', role: 'personal, not tracked',
          path: 'D:\\\\proj\\\\.slang\\\\local\\\\server.json', exists: false },
        { id: 'user', label: '~/.slang/server.json', role: 'applies to every workspace',
          path: 'C:\\\\Users\\\\me\\\\.slang\\\\server.json', exists: false }
      ],
      active: 'workspace',
      diagnostics: [
        { code: 'unused-variable', name: 'UnusedVariable', subsystem: 'Analysis',
          description: "unused variable '{}'", groups: ['unused'], state: 'off', origin: 'workspace' },
        { code: 'unused-def', name: 'UnusedDefinition', subsystem: 'Analysis',
          description: 'unused definition: {}', groups: ['unused'], state: 'warning', origin: '' },
        { code: 'implicit-conv', name: 'ImplicitConvert', subsystem: 'Expressions',
          description: 'implicit conversion from {} to {}', groups: ['extra', 'conversion'],
          state: 'error', origin: 'local' },
        { code: 'width-trunc', name: 'WidthTruncate', subsystem: 'Expressions',
          description: 'implicit conversion truncates from {} to {} bits',
          groups: ['extra', 'conversion'], state: 'hint', origin: 'workspace' }
      ],
      options: { warnings: 'all', notes: true, errorLimit: 0, suppressPaths: ['build/**', 'vendor'] },
      catalogAvailable: true
    }, '*')
  })
</script>`

html = html.replace('<body>', '<body>' + harness)

const outDir = path.join(root, '.preview')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'panel.html')
fs.writeFileSync(outFile, html)
console.log('wrote', outFile, html.length, 'bytes')
console.log('open it in a browser to iterate on the UI without launching VS Code')
