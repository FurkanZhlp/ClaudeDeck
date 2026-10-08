import { positionals } from '../commands'
import { hit, type CmdDetector, type DetectContext, type Hit } from './types'

/** Formatting, erasing and partitioning disks, and fork bombs. */

const MKFS = /^(mkfs|newfs|mke2fs|mkswap|wipefs|mkdosfs|mkntfs)([._].*)?$/
const PARTITIONERS = new Set(['fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'cfdisk', 'parted'])
const PARTITION_READ = /^(-l|--list|-p|--print|print|-v|--version|-h|--help)$/
const DISKUTIL_ERASE = new Set([
  'erasedisk',
  'erasevolume',
  'reformat',
  'partitiondisk',
  'zerodisk',
  'randomdisk',
  'secureerase',
  'splitpartition',
  'mergepartitions',
  'resizevolume',
  'deletecontainer',
  'deletevolume',
  'deletesnapshot',
  'delete'
])
const PS_DISK = new Set([
  'format-volume',
  'clear-disk',
  'initialize-disk',
  'remove-partition',
  'set-partition',
  'resize-partition'
])

export const diskTools: CmdDetector = (cmd, index) => {
  const { name, args } = cmd
  const texts = args.map((a) => a.text.toLowerCase())
  if (MKFS.test(name)) return [hit('disk.format', cmd, index)]
  if (PARTITIONERS.has(name)) {
    return texts.some((t) => PARTITION_READ.test(t)) ? [] : [hit('disk.format', cmd, index)]
  }
  if (name === 'diskutil') {
    const sub = positionals(args).map((a) => a.text.toLowerCase())
    // `diskutil apfs deleteVolume`, `diskutil cs delete`, `diskutil eraseDisk`.
    const verb = ['apfs', 'cs', 'ar', 'corestorage', 'appleraid'].includes(sub[0]) ? sub[1] : sub[0]
    return verb && DISKUTIL_ERASE.has(verb) ? [hit('disk.format', cmd, index)] : []
  }
  if (name === 'format' && cmd.shell !== 'powershell') {
    return texts.some((t) => /^[a-z]:\\?$/.test(t) || t.startsWith('/fs:'))
      ? [hit('disk.format', cmd, index)]
      : []
  }
  if (name === 'diskpart' || PS_DISK.has(name)) return [hit('disk.format', cmd, index)]
  if (name === 'asr' && texts.includes('--erase')) return [hit('disk.format', cmd, index)]
  return []
}

/** `:(){ :|:& };:` and the same with any function name. */
const FORK_BOMB =
  /(^|[\s;&|({])([A-Za-z_:][\w:]*)\s*\(\s*\)\s*\{\s*\2\s*\|\s*\2\s*&\s*\}\s*;?\s*\2(?![\w:])/

export function forkBomb(ctx: DetectContext): Hit[] {
  const m = FORK_BOMB.exec(ctx.input)
  return m ? [{ ruleId: 'disk.forkBomb', excerpt: m[0].trim() }] : []
}
