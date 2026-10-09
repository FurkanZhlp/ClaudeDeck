import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../shared/types'
import type { Evaluators } from '../main/assistant/proposals'
import { createGuardLog } from '../main/guard/guardLog'
import { guardRuleList } from '../main/guard/rules'
import { createGuardService } from '../main/guard/guardService'
import { JsonStore } from '../main/state/jsonStore'
import { emptyState, Repository } from '../main/state/repository'
import { builtinPatternList, classify } from '../main/testQueue/classifier'

/**
 * The real evaluators for settings assistant tests: the guard runs inline (no worker) on the
 * given state and the test queue classifier is the real one. Commands are strings only.
 */
export function testEvaluators(): Evaluators {
  const log = createGuardLog({})
  return {
    catalog: { guardRules: guardRuleList(), testBuiltins: builtinPatternList() },
    classify,
    evaluateGuard: (request, state: AppState) =>
      createGuardService({
        settings: () => state.settings.guard,
        project: (id) => state.projects.find((p) => p.id === id),
        projects: () => state.projects,
        account: (id) => state.accounts.find((a) => a.id === id),
        appDataDir: '/Users/dev/Library/Application Support/ClaudeDeck',
        home: '/Users/dev',
        os: 'darwin',
        env: { HOME: '/Users/dev' },
        realpath: (path) => path,
        log
      }).evaluate(request)
  }
}

/** A repository on a temp file with one account and one project ("App"). */
export function testRepository(): { repo: Repository; dir: string; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'claudedeck-assistant-test-'))
  const repo = new Repository(
    new JsonStore<AppState>(join(dir, 'config.json'), emptyState),
    join(dir, 'accounts')
  )
  const { account } = repo.createAccount({ name: 'Work', color: '#000' })
  repo.createProject({ name: 'App', path: '/Users/dev/projects/app', accountId: account.id })
  return { repo, dir, projectId: repo.get().projects[0].id }
}
