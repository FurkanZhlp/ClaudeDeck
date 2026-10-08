import { positionals, type Cmd } from '../commands'
import { hit, type CmdDetector, type DetectContext, type Hit } from './types'

/** Destructive SQL sent to a database client, and migration tools that wipe a database. */

const CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlite',
  'sqlcmd',
  'mongosh',
  'mongo',
  'redis-cli',
  'clickhouse',
  'clickhouse-client',
  'duckdb',
  'cockroach',
  'cqlsh',
  'usql',
  'pgcli',
  'mycli',
  'litecli',
  'turso',
  'invoke-sqlcmd',
  'd1'
])

const DROP =
  /\bDROP\s+(?:DATABASE|SCHEMA|TABLE|COLLECTION|KEYSPACE|OWNED)\b|\.dropDatabase\s*\(|\.drop\s*\(\s*\)|\bFLUSH(?:ALL|DB)\b/i
const TRUNCATE = /\bTRUNCATE\b|\.deleteMany\s*\(\s*\{\s*\}\s*\)|\.remove\s*\(\s*\{\s*\}\s*\)/i

/** Statements of a text: `DELETE FROM x` without a WHERE clause. */
function deleteWithoutWhere(text: string): boolean {
  return text.split(';').some((s) => /\bDELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s))
}

const isClient = (cmd: Cmd): boolean =>
  CLIENTS.has(cmd.name) ||
  (cmd.name === 'wrangler' && cmd.args.some((a) => a.text === 'd1')) ||
  (cmd.name === 'prisma' && cmd.args[0]?.text === 'db' && cmd.args[1]?.text === 'execute') ||
  (cmd.name === 'supabase' && cmd.args[0]?.text === 'db' && cmd.args[1]?.text === 'query')

/** The text a client may run: its arguments, plus the whole input for stdin and heredocs. */
export function sqlHits(cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  if (!isClient(cmd)) return []
  const text = ctx.input
  if (DROP.test(text)) return [hit('database.drop', cmd, index)]
  if (TRUNCATE.test(text) || deleteWithoutWhere(text)) return [hit('database.truncate', cmd, index)]
  return []
}

const ARTISAN = new Set(['migrate:fresh', 'migrate:reset', 'migrate:refresh', 'db:wipe'])
const RAILS = /^db:(drop|reset|purge|truncate_all|schema:load|migrate:reset|setup)(:|$)/
const RESET_TOOLS: Record<string, RegExp> = {
  prisma: /^migrate reset|^db push .*--(force-reset|accept-data-loss)/,
  sequelize: /^db:(drop|migrate:undo:all)/,
  'sequelize-cli': /^db:(drop|migrate:undo:all)/,
  typeorm: /^schema:drop/,
  knex: /^migrate:rollback .*--all/,
  'drizzle-kit': /^drop\b/,
  supabase: /^db reset/,
  mix: /^ecto\.(drop|reset)/,
  flyway: /^clean/,
  liquibase: /^drop-all/,
  alembic: /^downgrade base/,
  dropdb: /.*/,
  mysqladmin: /(^|\s)drop\s/,
  'django-admin': /^(flush|reset_db)/
}

export const databaseRules: CmdDetector = (cmd, index, ctx) => {
  const sql = sqlHits(cmd, index, ctx)
  if (sql.length) return sql
  const words = positionals(cmd.args).map((a) => a.text)
  const line = words.join(' ')
  const reset = (): Hit[] => [hit('database.migrateReset', cmd, index)]
  // php artisan migrate:fresh, sail artisan db:wipe
  const artisan = words.findIndex((w) => /(^|[\\/])artisan$/.test(w))
  if (
    (cmd.name === 'php' || cmd.name === 'sail') &&
    artisan >= 0 &&
    ARTISAN.has(words[artisan + 1])
  )
    return reset()
  if (cmd.name === 'artisan' && ARTISAN.has(words[0])) return reset()
  if (['rails', 'rake', 'bin/rails'].includes(cmd.name) && words.some((w) => RAILS.test(w)))
    return reset()
  if (
    /^python[\d.]*$/.test(cmd.name) &&
    /(^|[\\/])manage\.py$/.test(words[0] ?? '') &&
    /^(flush|reset_db)$/.test(words[1] ?? '')
  )
    return reset()
  if (cmd.name === 'manage.py' && /^(flush|reset_db)$/.test(words[0] ?? '')) return reset()
  if (cmd.name === 'dotnet' && /^ef database drop/.test(line)) return reset()
  const tool = RESET_TOOLS[cmd.name]
  const full = cmd.args.map((a) => a.text).join(' ')
  if (tool && (tool.test(line) || tool.test(full))) return reset()
  return []
}
