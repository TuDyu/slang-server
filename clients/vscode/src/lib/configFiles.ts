//------------------------------------------------------------------------------
// configFiles.ts
// Reading and writing the layered slang server configuration files
//
// SPDX-FileCopyrightText: Hudson River Trading
// SPDX-License-Identifier: MIT
//------------------------------------------------------------------------------

import * as vscode from 'vscode'
import * as path from 'path'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  ParseError,
  printParseErrorCode,
} from 'jsonc-parser'
import { EffectiveDiagnostics } from './configState'
import { Logger } from './logger'

export type ScopeId = 'workspace' | 'local' | 'user'

/// The server reports which files it layers, in ascending precedence order.
export interface ConfigCatalogEntry {
  code: string
  name: string
  subsystem: string
  description: string
  groups: string[]
}

export interface ConfigCatalog {
  diagnostics: ConfigCatalogEntry[]
  workspaceFile?: string | null
  userFile?: string | null
  localFile?: string | null
  workspaceFileExists: boolean
  userFileExists: boolean
  localFileExists: boolean
  effectiveDiagnostics: EffectiveDiagnostics
}

export interface ServerClient {
  sendRequest(method: string, params: unknown): Promise<unknown>
}

export interface Scope {
  id: ScopeId
  label: string
  path: string
  exists: boolean
  data: Record<string, any>
}

export function describeScope(id: ScopeId): string {
  switch (id) {
    case 'workspace':
      return '.slang/server.json'
    case 'local':
      return '.slang/local/server.json'
    case 'user':
      return '~/.slang/server.json'
  }
}

export function describeScopeRole(id: ScopeId): string {
  switch (id) {
    case 'workspace':
      return 'shared, tracked in git'
    case 'local':
      return 'personal, not tracked'
    case 'user':
      return 'applies to every workspace'
  }
}

export function readJsonc(text: string): Record<string, any> {
  const errors: ParseError[] = []
  const value = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    throw new Error(`${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`)
  }
  return value ?? {}
}

async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString('utf8')
  } catch {
    return undefined
  }
}

export async function loadScope(
  id: ScopeId,
  file: string,
  exists: boolean
): Promise<Scope | undefined> {
  let data: Record<string, any> = {}
  if (exists) {
    const text = await readFileIfExists(file)
    if (text === undefined) {
      return undefined
    }
    try {
      data = readJsonc(text)
    } catch (e) {
      void vscode.window.showWarningMessage(
        `Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`
      )
      return undefined
    }
  }
  return { id, label: describeScope(id), path: file, exists, data }
}

/// Ask the running server for the catalog, or undefined when it predates the command.
export async function requestCatalog(client: ServerClient): Promise<ConfigCatalog | undefined> {
  try {
    const result = await client.sendRequest('workspace/executeCommand', {
      command: 'slang.getConfigCatalog',
      arguments: [],
    })
    if (!result || !Array.isArray((result as ConfigCatalog).diagnostics)) {
      return undefined
    }
    return result as ConfigCatalog
  } catch {
    return undefined
  }
}

/// Fall back to the documented locations when the server cannot report them.
function defaultConfigPaths() {
  const result: Partial<Record<ScopeId, string>> = {}
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder) {
    result.workspace = path.join(folder.uri.fsPath, '.slang', 'server.json')
    result.local = path.join(folder.uri.fsPath, '.slang', 'local', 'server.json')
  }
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) {
    result.user = path.join(home, '.slang', 'server.json')
  }
  return result
}

/// Resolve the three layered files, in ascending precedence order.
export async function resolveScopes(catalog: ConfigCatalog | undefined): Promise<Scope[]> {
  const fallback = defaultConfigPaths()
  const candidates: { id: ScopeId; file: string | null | undefined }[] = [
    { id: 'workspace', file: catalog?.workspaceFile ?? fallback.workspace },
    { id: 'local', file: catalog?.localFile ?? fallback.local },
    { id: 'user', file: catalog?.userFile ?? fallback.user },
  ]

  const scopes: Scope[] = []
  for (const candidate of candidates) {
    if (!candidate.file) {
      continue
    }
    let exists = false
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(candidate.file))
      exists = true
    } catch {
      exists = false
    }
    const scope = await loadScope(candidate.id, candidate.file, exists)
    if (scope) {
      scopes.push(scope)
    }
  }
  return scopes
}

/// Write a value with jsonc edits so comments and formatting survive.
/// Passing undefined removes the key and prunes empty containers.
export async function writeValue(scope: Scope, keyPath: (string | number)[], value: unknown) {
  const uri = vscode.Uri.file(scope.path)
  const text = await readFileIfExists(scope.path)
  const existed = text !== undefined

  const edits = modify(text ?? '{}\n', keyPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const updated = applyEdits(text ?? '{}\n', edits)

  if (!existed) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'))
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'))
  scope.exists = true
  scope.data = readJsonc(updated)
}

/// Create the file with a minimal skeleton when it does not exist yet.
export async function ensureScopeFile(scope: Scope) {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(scope.path))
    return
  } catch {
    // Missing; create below.
  }
  const uri = vscode.Uri.file(scope.path)
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'))
  await vscode.workspace.fs.writeFile(uri, Buffer.from('{}\n', 'utf8'))
  scope.exists = true
  scope.data = {}
}

/// Prompt for one of the layered files and open it as text.
export async function openConfigurationFile(
  client: ServerClient | undefined,
  logger: Logger
): Promise<void> {
  if (!client) {
    void vscode.window.showErrorMessage('slang-server is not running')
    return
  }
  const catalog = await requestCatalog(client)
  if (!catalog) {
    logger.info('slang.getConfigCatalog is unavailable; using default file paths')
  }

  const scopes = await resolveScopes(catalog)
  if (scopes.length === 0) {
    void vscode.window.showErrorMessage('No workspace folder is open')
    return
  }

  const picked = await vscode.window.showQuickPick(
    scopes.map((scope) => ({
      label: describeScope(scope.id),
      description: scope.exists ? scope.path : `${scope.path} (not created yet)`,
      detail: describeScopeRole(scope.id),
      scope,
    })),
    { title: 'Open configuration file', placeHolder: 'Pick a configuration file' }
  )
  if (!picked) {
    return
  }

  await ensureScopeFile(picked.scope)
  await vscode.window.showTextDocument(vscode.Uri.file(picked.scope.path))
}
