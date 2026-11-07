import tape from 'tape'
import {
  applyStates,
  effectiveState,
  mergeDiagnostics,
  nextWarningEntries,
} from '../../src/lib/configState'

tape('mergeDiagnostics overrides scalars and appends lists', (t) => {
  const merged = mergeDiagnostics([
    {
      id: 'workspace',
      data: {
        diagnostics: {
          warnings: 'all',
          ignore: ['unused-variable'],
          severity: { 'implicit-conv': 'error' },
          suppressPaths: ['build/**'],
        },
      },
    },
    {
      id: 'local',
      data: {
        diagnostics: {
          warnings: 'none',
          ignore: ['width-trunc'],
          severity: { 'unused-def': 'hint' },
        },
      },
    },
  ])

  t.equal(merged.warnings, 'none', 'later file overrides the mode')
  t.deepEqual(merged.ignore, ['unused-variable', 'width-trunc'], 'ignore lists are appended')
  t.deepEqual(
    merged.severity,
    { 'implicit-conv': 'error', 'unused-def': 'hint' },
    'severity maps merge'
  )
  t.deepEqual(merged.suppressPaths, ['build/**'], 'suppressPaths are kept')
  t.end()
})

tape('mergeDiagnostics tolerates missing and malformed sections', (t) => {
  const merged = mergeDiagnostics([
    { id: 'workspace', data: {} },
    { id: 'user', data: { diagnostics: 'nonsense' } },
    { id: 'local', data: { diagnostics: { ignore: 'not-a-list' } } },
  ])

  t.deepEqual(merged.ignore, [], 'invalid lists are dropped')
  t.equal(merged.warnings, undefined, 'no mode is reported')
  t.end()
})

tape('effectiveState prefers ignore, then severity, then the global mode', (t) => {
  const base = mergeDiagnostics([
    {
      id: 'workspace',
      data: {
        diagnostics: {
          warnings: 'all',
          ignore: ['unused-variable'],
          severity: { 'implicit-conv': 'error', 'unused-def': 'hint' },
        },
      },
    },
  ])

  t.equal(effectiveState(base, 'unused-variable'), 'off', 'ignored warnings are off')
  t.equal(effectiveState(base, 'implicit-conv'), 'error', 'severity upgrades are honored')
  t.equal(effectiveState(base, 'unused-def'), 'hint', 'severity downgrades are honored')
  t.equal(effectiveState(base, 'width-trunc'), 'warning', 'unset warnings use the default')

  const none = mergeDiagnostics([{ id: 'local', data: { diagnostics: { warnings: 'none' } } }])
  t.equal(effectiveState(none, 'unused-variable'), 'off', 'warnings none hides unset warnings')

  const noneWithError = mergeDiagnostics([
    {
      id: 'local',
      data: { diagnostics: { warnings: 'none', severity: { 'implicit-conv': 'error' } } },
    },
  ])
  t.equal(
    effectiveState(noneWithError, 'implicit-conv'),
    'error',
    'an explicit severity survives warnings none'
  )
  t.end()
})

tape('nextWarningEntries keeps ignore and severity consistent', (t) => {
  const data = {
    diagnostics: {
      ignore: ['unused-variable'],
      severity: { 'implicit-conv': 'error' },
    },
  }

  t.deepEqual(
    nextWarningEntries(data, 'implicit-conv', 'off'),
    { ignore: ['unused-variable', 'implicit-conv'], severity: undefined },
    'turning a warning off moves it to ignore and drops the override'
  )

  t.deepEqual(
    nextWarningEntries(data, 'unused-variable', 'warning'),
    { ignore: undefined, severity: { 'implicit-conv': 'error' } },
    'restoring the default drops explicit settings'
  )

  t.deepEqual(
    nextWarningEntries(data, 'width-trunc', 'hint'),
    {
      ignore: ['unused-variable'],
      severity: { 'implicit-conv': 'error', 'width-trunc': 'hint' },
    },
    'downgrading adds a severity entry'
  )

  t.deepEqual(
    nextWarningEntries({}, 'width-trunc', 'warning'),
    { ignore: undefined, severity: undefined },
    'an empty configuration produces nothing to write'
  )
  t.end()
})

tape('applyStates applies one state to many warnings at once', (t) => {
  const data = {
    diagnostics: {
      ignore: ['unused-variable'],
      severity: { 'implicit-conv': 'error' },
    },
  }

  t.deepEqual(
    applyStates(data, ['unused-def', 'width-trunc'], 'off'),
    {
      ignore: ['unused-variable', 'unused-def', 'width-trunc'],
      severity: { 'implicit-conv': 'error' },
    },
    'batch off appends every code to ignore'
  )

  t.deepEqual(
    applyStates(data, ['implicit-conv', 'width-trunc'], 'hint'),
    {
      ignore: ['unused-variable'],
      severity: { 'implicit-conv': 'hint', 'width-trunc': 'hint' },
    },
    'batch downgrade rewrites severity for every code'
  )

  t.deepEqual(
    applyStates(data, ['unused-variable', 'implicit-conv'], 'warning'),
    { ignore: undefined, severity: undefined },
    'batch reset removes every explicit setting and prunes empty containers'
  )

  t.deepEqual(
    applyStates({}, ['a', 'b'], 'error'),
    { ignore: undefined, severity: { a: 'error', b: 'error' } },
    'a batch on an empty configuration only writes severity'
  )
  t.end()
})
