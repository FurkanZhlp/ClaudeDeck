import { describe, expect, it } from 'vitest'
import { decide, mismatches } from '../../test/guard'

// Command STRINGS for the pure evaluator only; nothing here is ever executed.

const MAC_DISK: [string, string | null][] = [
  // Deleting critical folders
  ['rm -rf /', 'disk.systemDelete'],
  ['rm -rf /*', 'disk.systemDelete'],
  ['rm -fr ~', 'disk.systemDelete'],
  ['rm -rf ~/', 'disk.systemDelete'],
  ['rm -rf ~/*', 'disk.systemDelete'],
  ['rm -rf $HOME', 'disk.systemDelete'],
  ['rm -rf "${HOME}/"', 'disk.systemDelete'],
  ['rm -R -f /Users/dev/Documents', 'disk.systemDelete'],
  ['rm -rf ~/Desktop', 'disk.systemDelete'],
  ['rm --recursive --force /usr', 'disk.systemDelete'],
  ['rm -rf /Applications', 'disk.systemDelete'],
  ['rm -rf /Volumes/Backup', 'disk.systemDelete'],
  ['rm -rf /Users/other', 'disk.systemDelete'],
  ['rm -rf .', 'disk.systemDelete'],
  ['rm -rf ./', 'disk.systemDelete'],
  ['rm -rf ..', 'disk.systemDelete'],
  ['rm -rf ../..', 'disk.systemDelete'],
  ['rm -rf *', 'disk.systemDelete'],
  ['rm -rf /Users/dev/projects/app', 'disk.systemDelete'],
  ['sudo rm -rf /', 'disk.systemDelete'],
  ['sudo -u root rm -rf /var', 'disk.systemDelete'],
  ['/bin/rm -rf /', 'disk.systemDelete'],
  ['\\rm -rf ~', 'disk.systemDelete'],
  ['command rm -rf ~', 'disk.systemDelete'],
  ['env FOO=1 rm -rf ~', 'disk.systemDelete'],
  ['nohup rm -rf / &', 'disk.systemDelete'],
  ['timeout 5 rm -rf ~', 'disk.systemDelete'],
  ['bash -c "rm -rf ~"', 'disk.systemDelete'],
  ["sh -c 'cd / && rm -rf *'", 'disk.systemDelete'],
  ['zsh -lc "rm -rf $HOME"', 'disk.systemDelete'],
  ['eval "rm -rf ~"', 'disk.systemDelete'],
  ['echo $(rm -rf ~)', 'disk.systemDelete'],
  ['x=`rm -rf /`', 'disk.systemDelete'],
  ['cd ~ && rm -rf *', 'disk.systemDelete'],
  ['cd / ; rm -rf ./*', 'disk.systemDelete'],
  ['rmdir ~/Documents', 'disk.systemDelete'],
  ['find / -delete', 'disk.systemDelete'],
  ['find ~ -mindepth 1 -delete', 'disk.systemDelete'],
  ['find ~ -exec rm -rf {} +', 'disk.systemDelete'],
  ['find / -type f | xargs rm -f', 'disk.systemDelete'],
  ['find ~ | xargs rm -rf', 'disk.systemDelete'],
  ['rsync -a --delete empty/ ~/', 'disk.systemDelete'],
  ['mv ~ /tmp/old-home', 'disk.systemDelete'],
  ['mv /Users/dev/projects/app /tmp/x', 'disk.systemDelete'],
  ['rm -rf $UNKNOWN_DIR/', 'disk.systemDelete'],
  ['rm -rf "$(git rev-parse --show-toplevel)"', 'disk.systemDelete'],
  ['npx rimraf ~', 'disk.systemDelete'],
  ['docker exec web rm -rf /', 'disk.systemDelete'],
  // Formatting and partitioning
  ['diskutil eraseDisk APFS Blank disk2', 'disk.format'],
  ['diskutil eraseVolume JHFS+ X /Volumes/USB', 'disk.format'],
  ['diskutil zeroDisk disk3', 'disk.format'],
  ['diskutil partitionDisk disk2 GPT JHFS+ A 100%', 'disk.format'],
  ['diskutil apfs deleteVolume disk3s2', 'disk.format'],
  ['diskutil secureErase 0 disk2', 'disk.format'],
  ['sudo newfs_hfs /dev/disk2s1', 'disk.format'],
  ['mkfs.ext4 /dev/sdb1', 'disk.format'],
  ['mkfs -t vfat /dev/sdc', 'disk.format'],
  ['wipefs -a /dev/sdb', 'disk.format'],
  ['fdisk /dev/sda', 'disk.format'],
  ['parted /dev/sda mklabel gpt', 'disk.format'],
  ['sgdisk --zap-all /dev/sdb', 'disk.format'],
  // Raw devices
  ['dd if=/dev/zero of=/dev/disk2 bs=1m', 'disk.rawDevice'],
  ['sudo dd if=x.iso of=/dev/rdisk4', 'disk.rawDevice'],
  ['dd if=/dev/urandom of=/dev/sda', 'disk.rawDevice'],
  ['cat image.img > /dev/sdb', 'disk.rawDevice'],
  ['echo x | sudo tee /dev/nvme0n1', 'disk.rawDevice'],
  ['shred -n 3 /dev/sda', 'disk.rawDevice'],
  // Permissions
  ['chmod -R 777 /', 'disk.recursivePermissions'],
  ['sudo chown -R dev ~', 'disk.recursivePermissions'],
  ['chmod -R 755 /usr', 'disk.recursivePermissions'],
  ['chgrp -R staff /Users', 'disk.recursivePermissions'],
  // Fork bomb
  [':(){ :|:& };:', 'disk.forkBomb'],
  ['bomb(){ bomb|bomb& }; bomb', 'disk.forkBomb']
]

const MAC_DISK_OK: [string, string | null][] = [
  ['rm -rf node_modules', null],
  ['rm -rf dist build .next coverage', null],
  ['rm -rf ./node_modules/.cache', null],
  ['rm -f *.log', null],
  ['rm -rf web/dist/*', null],
  ['cd web && rm -rf dist', null],
  ['cd dist && rm -rf *', null],
  ['rm -rf /tmp/claudedeck-test', null],
  ['rm -rf "$TMPDIR/build"', null],
  ['rm -rf ~/.npm/_cacache', null],
  ['rm -rf ~/Library/Caches/pip', null],
  ['rm -rf /Users/dev/projects/app/tmp', null],
  ['rm file.txt', null],
  ['rm -rf build/$TARGET', null],
  ['rm -rf $(find . -name __pycache__)', 'disk.systemDelete'],
  ['find . -name "*.pyc" -delete', null],
  ['find ~ -name .DS_Store -delete', null],
  ['find . -type d -name node_modules -prune -exec rm -rf {} +', null],
  ['find dist -type f | xargs rm -f', null],
  ['ls | xargs rm -f', null],
  ['echo "rm -rf /"', null],
  ["echo 'rm -rf ~'", null],
  ['grep -r "rm -rf /" docs', null],
  ['git commit -m "remove rm -rf / example"', null],
  ['cat <<EOF > notes.md\nrm -rf /\nEOF', null],
  ['diskutil list', null],
  ['diskutil info disk0', null],
  ['fdisk -l', null],
  ['parted -l', null],
  ['dd if=/dev/zero of=./disk.img bs=1m count=10', null],
  ['echo hi > /dev/null 2>&1', null],
  ['cmd 2>/dev/stderr', null],
  ['chmod +x scripts/build.sh', null],
  ['chmod -R u+w ./vendor', null],
  ['chown -R dev:staff ./data', null],
  ['mv src/old.ts src/new.ts', null],
  ['mkdir -p ~/projects/new', null],
  ['rsync -av --delete dist/ server:/var/www/', null],
  ['rsync -a --delete build/ ./public/', null]
]

describe('guard: disk and system (macOS)', () => {
  it('catches destructive disk commands', () => {
    expect(mismatches(MAC_DISK)).toEqual([])
  })
  it('lets everyday cleanup through', () => {
    expect(mismatches(MAC_DISK_OK)).toEqual([])
  })
  it('denies by default and asks when the target cannot be told', () => {
    expect(decide('rm -rf ~').action).toBe('deny')
    expect(decide('rm -rf $UNKNOWN_DIR/').action).toBe('ask')
    expect(decide('rm -rf "$(git rev-parse --show-toplevel)"').action).toBe('ask')
  })
})

const LINUX_DISK: [string, string | null][] = [
  ['rm -rf /home/dev', 'disk.systemDelete'],
  ['rm -rf /home', 'disk.systemDelete'],
  ['rm -rf /etc', 'disk.systemDelete'],
  ['rm -rf /mnt/data', 'disk.systemDelete'],
  ['rm -rf /media/dev/usb', 'disk.systemDelete'],
  ['sudo rm -rf --no-preserve-root /', 'disk.systemDelete'],
  ['mkfs.btrfs -f /dev/nvme0n1p3', 'disk.format'],
  ['mkswap /dev/sdb2', 'disk.format'],
  ['dd if=/dev/zero of=/dev/mmcblk0', 'disk.rawDevice'],
  ['echo 1 > /dev/sda', 'disk.rawDevice'],
  ['chown -R nobody /home/dev', 'disk.recursivePermissions'],
  ['rm -rf ~/.cache/yarn', null],
  ['rm -rf /var/tmp/x', null],
  ['rm -rf /home/dev/projects/app/target', null]
]

const WIN_DISK: [string, string | null][] = [
  ['rm -rf /c/', 'disk.systemDelete'],
  ['rm -rf C:/', 'disk.systemDelete'],
  ['rm -rf /c/Windows', 'disk.systemDelete'],
  ['rm -rf "C:/Program Files"', 'disk.systemDelete'],
  ['rm -rf /c/Users/dev', 'disk.systemDelete'],
  ['rm -rf ~', 'disk.systemDelete'],
  ['rm -rf $USERPROFILE/Documents', 'disk.systemDelete'],
  ['rm -rf /c/Users/other', 'disk.systemDelete'],
  ['cmd /c rd /s /q C:\\', 'disk.systemDelete'],
  ['cmd //c "rmdir /s /q C:\\Users\\dev"', 'disk.systemDelete'],
  ['cmd.exe /c "del /s /q C:\\*"', 'disk.systemDelete'],
  ['cmd /c format D: /q', 'disk.format'],
  ['format E: /FS:NTFS', 'disk.format'],
  ['diskpart /s wipe.txt', 'disk.format'],
  ['powershell -Command "Remove-Item -Recurse -Force C:\\Windows"', 'disk.systemDelete'],
  ['pwsh -c "Format-Volume -DriveLetter D"', 'disk.format'],
  ["icacls 'C:\\' /grant Everyone:F /T", 'disk.recursivePermissions'],
  ['rm -rf node_modules', null],
  ['rm -rf /c/Users/dev/projects/app/dist', null],
  ['cmd /c rd /s /q build', null],
  ['cmd /c dir C:\\', null]
]

describe('guard: disk and system (Linux, Windows)', () => {
  it('covers Linux forms', () => {
    expect(mismatches(LINUX_DISK, 'linux')).toEqual([])
  })
  it('covers Git Bash and cmd forms on Windows', () => {
    expect(mismatches(WIN_DISK, 'win')).toEqual([])
  })
})
