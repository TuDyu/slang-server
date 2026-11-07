//------------------------------------------------------------------------------
// configState.ts
// Pure helpers for interpreting the layered slang server configuration files
//
// SPDX-FileCopyrightText: Hudson River Trading
// SPDX-License-Identifier: MIT
//------------------------------------------------------------------------------

export type WarningState = 'error' | 'warning' | 'information' | 'hint' | 'off'

/// A configuration file's parsed contents.
export interface ConfigFile {
  id: string
  data: Record<string, any>
}

/// Merged `diagnostics` settings, following the server's layering rules.
export interface EffectiveDiagnostics {
  warnings?: string
  notes?: boolean
  ignore: string[]
  severity: Record<string, string>
  suppressPaths: string[]
  errorLimit?: number
}

export function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

/// Scalars are overridden by later files, lists are appended, and maps merge by key.
/// Files must be ordered from lowest to highest precedence.
export function mergeDiagnostics(files: ConfigFile[]): EffectiveDiagnostics {
  const merged: EffectiveDiagnostics = {
    ignore: [],
    severity: {},
    suppressPaths: [],
  }
  for (const file of files) {
    const diagnostics = file.data?.diagnostics
    if (!diagnostics || typeof diagnostics !== 'object') {
      continue
    }

    if (typeof diagnostics.warnings === 'string') {
      merged.warnings = diagnostics.warnings
    }
    if (typeof diagnostics.notes === 'boolean') {
      merged.notes = diagnostics.notes
    }
    if (typeof diagnostics.errorLimit === 'number') {
      merged.errorLimit = diagnostics.errorLimit
    }
    merged.ignore.push(...asArray(diagnostics.ignore))
    merged.suppressPaths.push(...asArray(diagnostics.suppressPaths))
    if (diagnostics.severity && typeof diagnostics.severity === 'object') {
      for (const [warning, level] of Object.entries(diagnostics.severity)) {
        merged.severity[warning] = String(level)
      }
    }
  }
  return merged
}

/// Explicit suppression wins, then a per-warning severity, then the global warning mode.
/// Every warning slang can configure is a warning by default, so anything unset reports
/// as a warning.
export function effectiveState(effective: EffectiveDiagnostics, code: string): WarningState {
  if (effective.ignore.includes(code)) {
    return 'off'
  }

  const override = effective.severity[code]
  if (override === 'error' || override === 'information' || override === 'hint') {
    return override
  }
  if (override === 'warning') {
    return 'warning'
  }

  if (effective.warnings === 'none') {
    return 'off'
  }
  return 'warning'
}

/// Apply a new state for one warning to a file's `ignore` and `severity` lists.
/// Returns the values to write, omitting empty containers.
export function nextWarningEntries(
  data: Record<string, any>,
  code: string,
  state: WarningState
): { ignore?: string[]; severity?: Record<string, string> } {
  return applyStates(data, [code], state)
}

/// Apply one state to many warnings at once, so a batch only writes the file once.
export function applyStates(
  data: Record<string, any>,
  codes: string[],
  state: WarningState
): { ignore?: string[]; severity?: Record<string, string> } {
  const ignore = new Set(asArray(data?.diagnostics?.ignore))
  const severity: Record<string, string> = { ...(data?.diagnostics?.severity ?? {}) }

  for (const code of codes) {
    if (state === 'off') {
      ignore.add(code)
      delete severity[code]
    } else if (state === 'warning') {
      ignore.delete(code)
      delete severity[code]
    } else {
      ignore.delete(code)
      severity[code] = state
    }
  }

  return {
    ignore: ignore.size > 0 ? [...ignore] : undefined,
    severity: Object.keys(severity).length > 0 ? severity : undefined,
  }
}
