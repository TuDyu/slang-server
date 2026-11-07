//------------------------------------------------------------------------------
// configPanel.ts
// Settings-style webview for the layered slang server configuration
//
// SPDX-FileCopyrightText: Hudson River Trading
// SPDX-License-Identifier: MIT
//------------------------------------------------------------------------------

import * as vscode from 'vscode'
import {
  ConfigCatalogEntry,
  describeScopeRole,
  ensureScopeFile,
  requestCatalog,
  resolveScopes,
  Scope,
  ScopeId,
  ServerClient,
  writeValue,
} from './configFiles'
import { applyStates, asArray, effectiveState, mergeDiagnostics, WarningState } from './configState'
import { Logger } from './logger'

/// What the webview renders for one warning.
interface WarningRow extends ConfigCatalogEntry {
  /// Effective state after merging every configuration file.
  state: WarningState
  /// File that set the current state, empty for defaults.
  origin: string
}

interface PanelState {
  type: 'state'
  scopes: {
    id: ScopeId
    label: string
    role: string
    path: string
    exists: boolean
  }[]
  active: ScopeId
  diagnostics: WarningRow[]
  options: {
    warnings: string
    notes: boolean
    errorLimit: number
    suppressPaths: string[]
  }
  catalogAvailable: boolean
  message?: string
}

type IncomingMessage =
  | { type: 'setWarning'; code: string; state: WarningState }
  | { type: 'setWarnings'; codes: string[]; state: WarningState }
  | { type: 'setOption'; key: 'warnings' | 'notes' | 'errorLimit'; value: unknown }
  | { type: 'addSuppressPath'; value: string }
  | { type: 'removeSuppressPath'; value: string }
  | { type: 'switchScope'; id: ScopeId }
  | { type: 'openRaw' }
  | { type: 'refresh' }

/// One panel per workspace, reused when the command runs again.
let currentPanel: ConfigPanel | undefined

export class ConfigPanel {
  private readonly disposables: vscode.Disposable[] = []
  private scopes: Scope[] = []
  private catalog: ConfigCatalogEntry[] = []
  private active: ScopeId = 'workspace'
  private catalogAvailable = false
  private note: string | undefined
  private watcher: vscode.FileSystemWatcher | undefined

  static show(context: vscode.ExtensionContext, client: ServerClient, logger: Logger) {
    if (currentPanel) {
      currentPanel.panel.reveal(undefined, true)
      void currentPanel.refresh(client)
      return
    }
    const panel = vscode.window.createWebviewPanel(
      'slangConfig',
      'slang configuration',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    )
    currentPanel = new ConfigPanel(panel, context, logger)
    void currentPanel.refresh(client)
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.panel.webview.html = getHtml(this.panel.webview)
    this.panel.onDidDispose(
      () => {
        currentPanel = undefined
        this.dispose()
      },
      null,
      this.disposables
    )
    this.panel.webview.onDidReceiveMessage(
      (message: IncomingMessage) => void this.onMessage(message),
      null,
      this.disposables
    )

    // Keep the panel in sync when the files are edited elsewhere.
    this.watcher = vscode.workspace.createFileSystemWatcher('**/.slang/**/server.json')
    const onChange = () => {
      if (this.client) {
        void this.refresh(this.client)
      }
    }
    this.watcher.onDidChange(onChange, null, this.disposables)
    this.watcher.onDidCreate(onChange, null, this.disposables)
    this.watcher.onDidDelete(onChange, null, this.disposables)
    this.disposables.push(this.watcher)

    context.subscriptions.push(panel)
  }

  private client: ServerClient | undefined

  async refresh(client: ServerClient) {
    this.client = client
    const catalog = await requestCatalog(client)
    this.catalogAvailable = catalog !== undefined
    this.catalog = catalog?.diagnostics ?? []
    this.scopes = await resolveScopes(catalog)

    if (this.scopes.length === 0) {
      this.note = 'No workspace folder is open.'
    } else if (!this.scopes.some((scope) => scope.id === this.active)) {
      this.active = this.scopes[0].id
    }
    await this.post()
  }

  private activeScope(): Scope | undefined {
    return this.scopes.find((scope) => scope.id === this.active)
  }

  private async onMessage(message: IncomingMessage) {
    const scope = this.activeScope()
    try {
      switch (message.type) {
        case 'switchScope':
          this.active = message.id
          break
        case 'refresh':
          if (this.client) {
            await this.refresh(this.client)
          }
          return
        case 'openRaw':
          if (scope) {
            await openScopeFile(scope)
          }
          return
        case 'setWarning':
          if (scope) {
            await setStates(scope, [message.code], message.state)
          }
          break
        case 'setWarnings':
          if (scope) {
            await setStates(scope, message.codes, message.state)
          }
          break
        case 'setOption':
          if (scope) {
            await setOption(scope, message.key, message.value)
          }
          break
        case 'addSuppressPath':
          if (scope) {
            const current = asArray(scope.data.diagnostics?.suppressPaths)
            const next = [...new Set([...current, message.value])]
            await writeValue(scope, ['diagnostics', 'suppressPaths'], next)
          }
          break
        case 'removeSuppressPath':
          if (scope) {
            const next = asArray(scope.data.diagnostics?.suppressPaths).filter(
              (entry) => entry !== message.value
            )
            await writeValue(
              scope,
              ['diagnostics', 'suppressPaths'],
              next.length > 0 ? next : undefined
            )
          }
          break
      }
      // Re-read from disk so the panel always reflects what other tools wrote.
      if (this.client) {
        await this.refresh(this.client)
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      this.logger.error(`Configuration update failed: ${text}`)
      void vscode.window.showErrorMessage(
        `Failed to update ${scope?.path ?? 'configuration'}: ${text}`
      )
    }
  }

  private async post() {
    const effective = mergeDiagnostics(this.scopes)

    const origin = new Map<string, ScopeId>()
    for (const scope of this.scopes) {
      for (const code of asArray(scope.data.diagnostics?.ignore)) {
        origin.set(code, scope.id)
      }
      for (const code of Object.keys(scope.data.diagnostics?.severity ?? {})) {
        origin.set(code, scope.id)
      }
    }

    const state: PanelState = {
      type: 'state',
      scopes: this.scopes.map((scope) => ({
        id: scope.id,
        label: scope.label,
        role: describeScopeRole(scope.id),
        path: scope.path,
        exists: scope.exists,
      })),
      active: this.active,
      diagnostics: this.catalog.map((entry) => ({
        ...entry,
        state: effectiveState(effective, entry.code),
        origin: origin.get(entry.code) ?? '',
      })),
      options: {
        warnings: effective.warnings ?? 'all',
        notes: effective.notes ?? true,
        errorLimit: effective.errorLimit ?? 0,
        suppressPaths: effective.suppressPaths,
      },
      catalogAvailable: this.catalogAvailable,
      message: this.note,
    }

    await this.panel.webview.postMessage(state)
  }

  private dispose() {
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.disposables.length = 0
  }
}

async function setStates(scope: Scope, codes: string[], state: WarningState) {
  if (codes.length === 0) {
    return
  }
  const next = applyStates(scope.data, codes, state)
  await writeValue(scope, ['diagnostics', 'ignore'], next.ignore)
  await writeValue(scope, ['diagnostics', 'severity'], next.severity)
}

async function setOption(scope: Scope, key: 'warnings' | 'notes' | 'errorLimit', value: unknown) {
  if (key === 'errorLimit') {
    const limit = Number(value)
    if (!Number.isFinite(limit) || limit < 0) {
      return
    }
    await writeValue(scope, ['diagnostics', 'errorLimit'], Math.floor(limit))
    return
  }
  await writeValue(scope, ['diagnostics', key], value)
}

async function openScopeFile(scope: Scope) {
  await ensureScopeFile(scope)
  await vscode.window.showTextDocument(vscode.Uri.file(scope.path))
}

function getHtml(webview: vscode.Webview): string {
  const nonce = Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
      Math.floor(Math.random() * 62)
    )
  ).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>slang configuration</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 0; margin: 0;
  }
  header {
    background: var(--vscode-editor-background, #1e1e1e);
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    padding: 10px 16px 8px;
  }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .tab {
    padding: 5px 12px; border-radius: 4px; cursor: pointer;
    border: 1px solid transparent; background: transparent;
    color: var(--vscode-foreground); font-size: inherit; font-family: inherit;
  }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
  .tab.active {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .tab.missing { font-style: italic; opacity: .8; }
  .path {
    margin-top: 6px; opacity: .7; font-size: .85em;
    font-family: var(--vscode-editor-font-family); word-break: break-all;
  }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  input[type="search"], input[type="text"], input[type="number"], select {
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
    border-radius: 3px; padding: 4px 6px; font-family: inherit; font-size: inherit;
  }
  input[type="search"] { flex: 1; }
  button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 3px; padding: 5px 12px;
    cursor: pointer; font-family: inherit; font-size: inherit;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.25));
    color: var(--vscode-button-secondaryForeground, inherit);
  }
  button:disabled { opacity: .5; cursor: default; }
  .banner {
    margin: 12px 16px; padding: 10px 12px; border-radius: 4px;
    border-left: 3px solid var(--vscode-editorWarning-foreground, #d7ba7d);
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.12));
  }
  section { padding: 4px 16px 12px; }
  h2 {
    font-size: .92em; text-transform: uppercase; letter-spacing: .04em;
    opacity: .7; margin: 18px 0 8px; font-weight: 600;
  }
  .option {
    display: grid; grid-template-columns: 240px 1fr; gap: 8px 12px;
    align-items: center; padding: 5px 0;
  }
  .option .desc { grid-column: 2; opacity: .65; font-size: .85em; margin-top: -2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--vscode-badge-background, rgba(128,128,128,.25));
    color: var(--vscode-badge-foreground, inherit);
    border-radius: 10px; padding: 2px 4px 2px 10px; font-size: .85em;
  }
  .chip button { background: none; color: inherit; padding: 0 4px; font-size: 1em; }
  .bulk {
    display: none; gap: 8px; align-items: center; flex-wrap: wrap;
    margin-top: 8px; padding: 8px 10px; border-radius: 4px;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,.14));
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3));
  }
  .bulk.visible { display: flex; }
  .group-title {
    font-size: .85em; font-weight: 600; opacity: .75;
    padding: 12px 0 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  tr.row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  tr.row.selected { background: var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,.2)); }
  td { padding: 5px 6px; vertical-align: top; }
  td.check { width: 22px; }
  td.code { width: 200px; }
  td.state { width: 160px; }
  td.state select { width: 100%; }
  .code-text {
    font-family: var(--vscode-editor-font-family);
    overflow-wrap: anywhere;
  }
  .desc { opacity: .8; }
  .meta { opacity: .5; font-size: .82em; margin-top: 2px; }
  .count { opacity: .7; font-size: .85em; white-space: nowrap; }
  .state-off .code-text { color: var(--vscode-disabledForeground, #888); }
</style>
</head>
<body>
<header>
  <div class="tabs" id="tabs"></div>
  <div class="path" id="path"></div>
  <div class="toolbar">
    <input type="search" id="search" placeholder="Search warnings by name, description or group">
    <label><input type="checkbox" id="onlyChanged"> Only configured</label>
    <span class="count" id="count"></span>
    <button class="secondary" id="openRaw">Open JSON</button>
  </div>
  <div class="bulk" id="bulk">
    <strong id="bulkCount">0 selected</strong>
    <select id="bulkState">
      <option value="off">Off</option>
      <option value="error">Error</option>
      <option value="warning">Warning (default)</option>
      <option value="information">Information</option>
      <option value="hint">Hint</option>
    </select>
    <button id="applyBulk">Apply</button>
    <button class="secondary" id="clearBulk">Clear</button>
  </div>
</header>

<div id="banner"></div>

<section>
  <h2>Unlisted warnings</h2>
  <div class="option">
    <select id="warningsMode">
      <option value="all">all — report every warning</option>
      <option value="none">none — hide every warning</option>
      <option value="slang">slang — slang's default set</option>
    </select>
    <div class="desc">Applies to warnings without their own setting below.</div>
  </div>
  <div class="option">
    <label><input type="checkbox" id="notes"> Show notes</label>
    <div class="desc">Secondary messages attached to a diagnostic.</div>
  </div>
  <div class="option">
    <input type="number" id="errorLimit" min="0" step="1" style="width: 120px">
    <div class="desc">Maximum number of errors to report. 0 means unlimited.</div>
  </div>
  <div class="option">
    <div class="chips" id="suppressChips"></div>
    <div class="desc">Files matching these paths or globs never report warnings.</div>
  </div>
  <div class="option">
    <input type="text" id="newSuppress" placeholder="build/** or vendor">
    <div class="desc">Press Enter to add a suppressed path.</div>
  </div>
</section>

<section id="list"></section>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi()
let state = null
let selected = new Set()
let query = ''
let onlyChanged = false

const el = (id) => document.getElementById(id)
const post = (msg) => vscode.postMessage(msg)

const ICONS = { off: 'circle-slash', error: 'error', warning: 'warning', information: 'info', hint: 'lightbulb' }
const LABELS = { off: 'Off', error: 'Error', warning: 'Warning', information: 'Information', hint: 'Hint' }

function matches(row) {
  if (onlyChanged && row.state === 'warning' && !row.origin) return false
  if (!query) return true
  const hay = (row.code + ' ' + row.description + ' ' + row.groups.join(' ') + ' ' + row.subsystem).toLowerCase()
  return hay.includes(query)
}

function render() {
  if (!state) return

  el('tabs').innerHTML = state.scopes.map((scope) => {
    const classes = ['tab']
    if (scope.id === state.active) classes.push('active')
    if (!scope.exists) classes.push('missing')
    return '<button class="' + classes.join(' ') + '" data-scope="' + scope.id + '" title="' +
      escapeHtml(scope.role) + '">' + scope.label + '</button>'
  }).join('')

  const active = state.scopes.find((s) => s.id === state.active)
  el('path').textContent = active
    ? active.role + ' — ' + active.path + (active.exists ? '' : '  (not created yet)')
    : ''

  el('banner').innerHTML = state.message
    ? '<div class="banner">' + state.message + '</div>'
    : (!state.catalogAvailable
      ? '<div class="banner">The running slang-server does not provide a warning catalog, so only ' +
        'the options above are available. Set "slang.path" to a locally built server and restart ' +
        'the language server.</div>'
      : '')

  el('warningsMode').value = state.options.warnings
  el('notes').checked = state.options.notes
  if (document.activeElement !== el('errorLimit')) el('errorLimit').value = state.options.errorLimit

  el('suppressChips').innerHTML = state.options.suppressPaths.length === 0
    ? '<span class="origin">none</span>'
    : state.options.suppressPaths.map((entry) =>
        '<span class="chip">' + entry +
        '<button data-remove="' + entry + '" title="Remove">&times;</button></span>').join('')

  const rows = state.diagnostics.filter(matches)
  let html = ''
  let subsystem = ''
  for (const row of rows) {
    if (row.subsystem !== subsystem) {
      subsystem = row.subsystem
      html += '<div class="group-title">' + subsystem + '</div><table>'
    }
    const isSelected = selected.has(row.code)
    const changed = row.state !== 'warning'
    const meta = [
      row.groups.length ? 'groups: ' + row.groups.join(', ') : '',
      row.origin ? 'from ' + row.origin : (changed ? 'from warnings mode' : ''),
    ]
      .filter(Boolean)
      .join(' · ')
    html += '<tr class="row' + (isSelected ? ' selected' : '') +
      (row.state === 'off' ? ' state-off' : '') + '" data-code="' + row.code + '">' +
      '<td class="check"><input type="checkbox" data-check="' + row.code + '"' +
        (isSelected ? ' checked' : '') + '></td>' +
      '<td class="code"><div class="code-text">' + row.code + '</div></td>' +
      '<td class="state"><select data-state-for="' + row.code + '">' +
        Object.keys(LABELS).map((value) =>
          '<option value="' + value + '"' + (value === row.state ? ' selected' : '') + '>' +
          LABELS[value] + (value === 'warning' ? ' (default)' : '') + '</option>').join('') +
      '</select></td>' +
      '<td class="desc">' + escapeHtml(row.description) +
        (meta ? '<div class="meta">' + escapeHtml(meta) + '</div>' : '') +
      '</td>' +
    '</tr>'
    // Close the table when the next row belongs to another subsystem.
    const index = rows.indexOf(row)
    if (index + 1 >= rows.length || rows[index + 1].subsystem !== subsystem) html += '</table>'
  }

  if (state.diagnostics.length === 0) {
    html = '<p class="origin">No warnings available.</p>'
  } else if (rows.length === 0) {
    html = '<p class="origin">No warning matches the current filter.</p>'
  }
  el('list').innerHTML = html

  el('count').textContent = state.diagnostics.length
    ? rows.length + ' of ' + state.diagnostics.length + (onlyChanged ? ' configured' : '')
    : ''

  const bulk = el('bulk')
  bulk.classList.toggle('visible', selected.size > 0)
  el('bulkCount').textContent = selected.size + ' selected'
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  return text.replace(/[&<>"]/g, (ch) => map[ch])
}

el('search').addEventListener('input', (e) => { query = e.target.value.toLowerCase(); render() })
el('onlyChanged').addEventListener('change', (e) => { onlyChanged = e.target.checked; render() })
el('openRaw').addEventListener('click', () => post({ type: 'openRaw' }))
el('warningsMode').addEventListener('change', (e) => {
  if (state && e.target.value === state.options.warnings) return
  post({ type: 'setOption', key: 'warnings', value: e.target.value })
})
el('notes').addEventListener('change', (e) => {
  if (state && e.target.checked === state.options.notes) return
  post({ type: 'setOption', key: 'notes', value: e.target.checked })
})
el('errorLimit').addEventListener('change', (e) => {
  const value = Number(e.target.value)
  if (state && value === state.options.errorLimit) return
  post({ type: 'setOption', key: 'errorLimit', value })
})

el('newSuppress').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const value = e.target.value.trim()
  if (!value) return
  e.target.value = ''
  post({ type: 'addSuppressPath', value })
})

el('applyBulk').addEventListener('click', () => {
  if (selected.size === 0) return
  post({ type: 'setWarnings', codes: [...selected], state: el('bulkState').value })
  selected = new Set()
  render()
})
el('clearBulk').addEventListener('click', () => { selected = new Set(); render() })

el('list').addEventListener('change', (e) => {
  const check = e.target.getAttribute('data-check')
  if (check) {
    if (e.target.checked) selected.add(check)
    else selected.delete(check)
    render()
    return
  }
  const code = e.target.getAttribute('data-state-for')
  if (code) post({ type: 'setWarning', code, state: e.target.value })
})

el('suppressChips').addEventListener('click', (e) => {
  const value = e.target.getAttribute('data-remove')
  if (value) post({ type: 'removeSuppressPath', value })
})

el('tabs').addEventListener('click', (e) => {
  const scope = e.target.closest('[data-scope]')
  if (!scope) return
  selected = new Set()
  post({ type: 'switchScope', id: scope.getAttribute('data-scope') })
})

window.addEventListener('message', (event) => {
  if (event.data.type !== 'state') return
  state = event.data
  render()
})

post({ type: 'refresh' })
</script>
</body>
</html>`
}

/// Entry point for the command.
export async function showConfigPanel(
  context: vscode.ExtensionContext,
  client: ServerClient | undefined,
  logger: Logger
) {
  if (!client) {
    void vscode.window.showErrorMessage('slang-server is not running')
    return
  }
  ConfigPanel.show(context, client, logger)
}
