import { beforeEach, describe, expect, it } from 'vitest'
import type { AssistantChangeInput } from '../../shared/assistant'
import type { AppState } from '../../shared/types'
import { testEvaluators, testRepository } from '../../test/assistant'
import { buildProposal, type ProposalInput } from './proposals'
import {
  AssistantValidationError,
  expandChange,
  sectionSchema,
  settingsOverview
} from './settingsSpec'

const evaluators = testEvaluators()
let state: AppState
let projectId: string

beforeEach(() => {
  const fixture = testRepository()
  state = fixture.repo.get()
  projectId = fixture.projectId
})

const proposal = (
  changes: AssistantChangeInput[],
  examples: ProposalInput['examples'] = []
): ProposalInput => ({
  summary: 'Değişiklik',
  reason: 'Çünkü',
  changes,
  examples
})

const refused = async (
  changes: AssistantChangeInput[],
  message: RegExp,
  examples: ProposalInput['examples'] = []
): Promise<void> => {
  const error = await buildProposal(proposal(changes, examples), state, evaluators).catch(
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AssistantValidationError)
  expect((error as Error).message).toMatch(message)
}

describe('settings assistant proposals: guard', () => {
  it('accepts a category change and shows it with tested examples', async () => {
    const built = await buildProposal(
      proposal(
        [{ section: 'guard', scope: 'global', patch: { categories: { docker: 'deny' } } }],
        [
          { input: 'docker system prune -af', expected: 'deny' },
          { input: 'docker ps', expected: 'allow' }
        ]
      ),
      state,
      evaluators
    )
    expect(built.view.changes).toEqual([
      {
        section: 'guard',
        scope: 'global',
        diffs: [{ kind: 'set', field: 'categories.docker', from: 'ask', to: 'deny' }]
      }
    ])
    expect(built.view.examples).toEqual([
      expect.objectContaining({
        kind: 'guard',
        input: 'docker system prune -af',
        before: 'ask',
        after: 'deny',
        ruleId: 'docker.prune'
      }),
      expect.objectContaining({ input: 'docker ps', before: 'allow', after: 'allow' })
    ])
    expect(built.view.risks).toEqual([])
    expect(built.view.confirmations).toEqual([])
    // Nothing is written.
    expect(state.settings.guard.categories.docker).toBe('ask')
  })

  it('adds a custom rule to the existing ones with { add }', async () => {
    const built = await buildProposal(
      proposal(
        [
          {
            section: 'guard',
            scope: 'global',
            patch: {
              customRules: {
                add: [{ kind: 'prefix', pattern: 'terraform apply*', action: 'deny' }]
              }
            }
          }
        ],
        [{ input: 'terraform apply -auto-approve', expected: 'deny' }]
      ),
      state,
      evaluators
    )
    expect(built.view.changes[0].diffs).toEqual([
      {
        kind: 'ruleAdded',
        field: 'customRules',
        rule: { kind: 'prefix', pattern: 'terraform apply*', action: 'deny' }
      }
    ])
    expect(built.after.settings.guard.customRules).toHaveLength(1)
  })

  it('merges rule overrides and removes one with null', () => {
    const call = expandChange(
      { section: 'guard', scope: 'global', patch: { ruleOverrides: { 'git.forcePush': 'deny' } } },
      state,
      evaluators.catalog
    )
    expect(call.patch).toEqual({ ruleOverrides: { 'git.forcePush': 'deny' } })
    const withOverride = {
      ...state,
      settings: {
        ...state.settings,
        guard: {
          ...state.settings.guard,
          ruleOverrides: { 'git.forcePush': 'deny', 'git.clean': 'allow' }
        }
      }
    } as AppState
    const removal = expandChange(
      { section: 'guard', scope: 'global', patch: { ruleOverrides: { 'git.clean': null } } },
      withOverride,
      evaluators.catalog
    )
    expect(removal.patch).toEqual({ ruleOverrides: { 'git.forcePush': 'deny' } })
  })

  it('needs confirmation to allow Disk and system, and notes relaxed categories', async () => {
    const built = await buildProposal(
      proposal([
        {
          section: 'guard',
          scope: 'global',
          patch: { categories: { disk: 'allow', git: 'allow' } }
        }
      ]),
      state,
      evaluators
    )
    expect(built.view.confirmations).toEqual(['guardAllow:disk'])
    expect(built.view.risks).toEqual([
      { kind: 'guardAllow', category: 'disk' },
      { kind: 'guardRelaxed', category: 'git', to: 'allow' }
    ])
  })

  it('reports turning the guard off', async () => {
    const built = await buildProposal(
      proposal([{ section: 'guard', scope: 'global', patch: { enabled: false } }]),
      state,
      evaluators
    )
    expect(built.view.risks).toEqual([{ kind: 'guardOff' }])
  })

  it('scopes project overrides to the project and inherits with "inherit"', async () => {
    const built = await buildProposal(
      proposal(
        [
          {
            section: 'guard',
            scope: 'project',
            projectId,
            patch: { categories: { docker: 'allow' } }
          }
        ],
        [{ input: 'docker system prune -af', projectId, expected: 'allow' }]
      ),
      state,
      evaluators
    )
    expect(built.view.changes[0]).toMatchObject({ scope: 'project', projectId, projectName: 'App' })
    expect(built.after.projects[0].guard?.categories).toEqual({ docker: 'allow' })
    expect(built.after.settings.guard.categories.docker).toBe('ask')
    const back = expandChange(
      {
        section: 'guard',
        scope: 'project',
        projectId,
        patch: { categories: { docker: 'inherit' } }
      },
      built.after,
      evaluators.catalog
    )
    expect(back.patch).toEqual({ categories: {} })
  })

  it('refuses unknown fields, categories, actions and rule ids with the field path', async () => {
    await refused(
      [{ section: 'guard', scope: 'global', patch: { colour: 'red' } }],
      /changes\[0\]\.patch\.colour: unknown field; allowed: "enabled"/
    )
    await refused(
      [{ section: 'guard', scope: 'global', patch: { categories: { kubernetes: 'deny' } } }],
      /patch\.categories\.kubernetes: unknown category/
    )
    await refused(
      [{ section: 'guard', scope: 'global', patch: { categories: { docker: 'block' } } }],
      /patch\.categories\.docker: must be one of "allow", "ask", "deny"/
    )
    await refused(
      [{ section: 'guard', scope: 'global', patch: { ruleOverrides: { 'docker.nope': 'deny' } } }],
      /ruleOverrides\.docker\.nope: unknown built-in rule id/
    )
  })

  it('refuses unsafe, broken or empty patterns with the reason', async () => {
    const rule = (pattern: string, kind = 'regex'): AssistantChangeInput => ({
      section: 'guard',
      scope: 'global',
      patch: { customRules: [{ kind, pattern, action: 'deny' }] }
    })
    await refused(
      [rule('(a+)+$')],
      /customRules\[0\]\.pattern: regex could backtrack catastrophically/
    )
    await refused([rule('docker (rm')], /customRules\[0\]\.pattern: not a valid JavaScript regex/)
    await refused([rule('   ', 'prefix')], /customRules\[0\]\.pattern: must not be empty/)
    await refused(
      [{ section: 'guard', scope: 'global', patch: { customRules: { remove: ['missing'] } } }],
      /customRules\.remove\[0\]: unknown rule id; current ids: none/
    )
  })

  it('refuses examples that do not give their expected outcome', async () => {
    await refused(
      [{ section: 'guard', scope: 'global', patch: { categories: { docker: 'deny' } } }],
      /examples\[0\] "docker system prune -af": expected allow but the proposed settings give deny \(rule docker\.prune\)/,
      [{ input: 'docker system prune -af', expected: 'allow' }]
    )
  })

  it('refuses a proposal that changes nothing', async () => {
    await refused(
      [{ section: 'guard', scope: 'global', patch: { categories: { docker: 'ask' } } }],
      /changes nothing/
    )
  })

  it('refuses project scope without a known project, and for global-only sections', async () => {
    await refused(
      [
        {
          section: 'guard',
          scope: 'project',
          projectId: 'nope',
          patch: { categories: { docker: 'deny' } }
        }
      ],
      /projectId: unknown project/
    )
    await refused(
      [{ section: 'usage', scope: 'project', projectId, patch: { display: 'remaining' } }],
      /"usage" has no project settings/
    )
  })
})

describe('settings assistant proposals: test queue', () => {
  it('turns the queue on and adds a pattern; examples show the classification', async () => {
    const built = await buildProposal(
      proposal(
        [
          {
            section: 'testQueue',
            scope: 'global',
            patch: {
              enabled: true,
              customPatterns: { add: [{ kind: 'prefix', pattern: 'make e2e' }] }
            }
          }
        ],
        [
          { input: 'make e2e', expected: 'queued' },
          { input: 'make build', expected: 'notQueued' }
        ]
      ),
      state,
      evaluators
    )
    expect(built.view.changes[0].diffs).toEqual([
      { kind: 'set', field: 'enabled', from: false, to: true },
      { kind: 'ruleAdded', field: 'customPatterns', rule: { kind: 'prefix', pattern: 'make e2e' } }
    ])
    expect(built.view.examples.map((e) => [e.kind, e.before, e.after])).toEqual([
      ['testQueue', 'notQueued', 'queued'],
      ['testQueue', 'notQueued', 'notQueued']
    ])
  })

  it('edits disabled built-ins by id and refuses unknown ids and out-of-range numbers', async () => {
    const built = await buildProposal(
      proposal([
        { section: 'testQueue', scope: 'global', patch: { disabledBuiltins: { add: ['js.jest'] } } }
      ]),
      state,
      evaluators
    )
    expect(built.view.changes[0].diffs).toEqual([
      { kind: 'builtinOff', id: 'js.jest', label: 'Jest' }
    ])
    await refused(
      [{ section: 'testQueue', scope: 'global', patch: { disabledBuiltins: ['nope'] } }],
      /disabledBuiltins\[0\]: unknown built-in id/
    )
    await refused(
      [{ section: 'testQueue', scope: 'global', patch: { maxConcurrent: 99 } }],
      /maxConcurrent: must be between 1 and 32/
    )
    await refused(
      [{ section: 'testQueue', scope: 'global', patch: { auto: { cpuHighPercent: 'high' } } }],
      /auto\.cpuHighPercent: must be a whole number/
    )
    await refused(
      [{ section: 'testQueue', scope: 'project', projectId, patch: { mode: 'fixed' } }],
      /mode: must be one of "inherit", "off"/
    )
  })

  it('notes turning the queue off', async () => {
    const on = {
      ...state,
      settings: { ...state.settings, testQueue: { ...state.settings.testQueue, enabled: true } }
    }
    const built = await buildProposal(
      proposal([{ section: 'testQueue', scope: 'global', patch: { enabled: false } }]),
      on,
      evaluators
    )
    expect(built.view.risks).toEqual([{ kind: 'testQueueOff' }])
  })
})

describe('settings assistant proposals: claude, usage, general', () => {
  it('asks to confirm bypass permissions (mode or switch)', async () => {
    const mode = await buildProposal(
      proposal([
        { section: 'claude', scope: 'global', patch: { permissionMode: 'bypassPermissions' } }
      ]),
      state,
      evaluators
    )
    expect(mode.view.confirmations).toEqual(['bypass'])
    const project = await buildProposal(
      proposal([
        {
          section: 'claude',
          scope: 'project',
          projectId,
          patch: { permissionMode: 'bypassPermissions' }
        }
      ]),
      state,
      evaluators
    )
    expect(project.view.confirmations).toEqual(['bypass'])
    const toggle = await buildProposal(
      proposal([{ section: 'claude', scope: 'global', patch: { allowBypass: true } }]),
      state,
      evaluators
    )
    expect(toggle.view.risks).toEqual([{ kind: 'bypass' }])
    await refused(
      [{ section: 'claude', scope: 'global', patch: { permissionMode: 'yolo' } }],
      /permissionMode: must be one of "default"/
    )
  })

  it('validates usage and general values', async () => {
    const built = await buildProposal(
      proposal([
        {
          section: 'usage',
          scope: 'global',
          patch: { display: 'remaining', trayMetric: 'weekly' }
        },
        { section: 'general', scope: 'global', patch: { language: 'en', launchAtLogin: true } }
      ]),
      state,
      evaluators
    )
    expect(built.view.changes.map((c) => c.section)).toEqual(['usage', 'general'])
    expect(built.after.settings.language).toBe('en')
    expect(built.after.settings.launchAtLogin).toBe(true)
    await refused(
      [{ section: 'usage', scope: 'global', patch: { trayAccount: 'someone' } }],
      /trayAccount: must be one of "auto", "selected"/
    )
    await refused(
      [{ section: 'general', scope: 'global', patch: { language: 'de' } }],
      /language: must be one of "tr", "en", null/
    )
  })

  it('applies later changes on top of earlier ones to the same section', async () => {
    const built = await buildProposal(
      proposal([
        {
          section: 'guard',
          scope: 'global',
          patch: { customRules: { add: [{ kind: 'prefix', pattern: 'a*', action: 'ask' }] } }
        },
        {
          section: 'guard',
          scope: 'global',
          patch: { customRules: { add: [{ kind: 'prefix', pattern: 'b*', action: 'ask' }] } }
        }
      ]),
      state,
      evaluators
    )
    expect(built.after.settings.guard.customRules.map((r) => r.pattern)).toEqual(['a*', 'b*'])
    expect(built.view.changes).toHaveLength(1)
  })
})

describe('settings assistant overview and schema', () => {
  it('lists sections, accounts and projects without paths', () => {
    const overview = settingsOverview(state, evaluators.catalog)
    expect(Object.keys(overview.sections as object)).toEqual([
      'guard',
      'testQueue',
      'claude',
      'usage',
      'general'
    ])
    expect(JSON.stringify(overview)).not.toContain('/Users/dev')
    expect(JSON.stringify(overview)).not.toContain('configDir')
  })

  it('names built-in rules in English with their category', () => {
    const schema = sectionSchema('guard', evaluators.catalog) as {
      builtInRules: { id: string; name: string }[]
    }
    const rule = schema.builtInRules.find((r) => r.id === 'git.forcePush')
    expect(rule?.name).not.toMatch(/^guard\.rules\./)
    expect(rule).toMatchObject({ category: 'git' })
  })
})
