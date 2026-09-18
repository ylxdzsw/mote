import { spawnSync } from 'node:child_process'
import os from 'node:os'

const user = process.env.MOTED_WORKER_USER || 'mote-ai'
const args = ['--quiet', '--wait', '--collect', '--unit', `moted-probe-${process.pid}`, '--service-type=exec', '--property=KillMode=control-group', '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict', '--property=ProtectHome=read-only', '--property=PrivateTmp=yes', '--property=PrivateDevices=yes', '--property=ProtectControlGroups=yes', '--property=ProtectKernelTunables=yes', '--property=ProtectKernelModules=yes', '--property=ProtectHostname=yes', '--property=RestrictSUIDSGID=yes', '--property=LockPersonality=yes', `--uid=${user}`, '--', process.execPath, '-e', 'console.log(JSON.stringify({uid:process.getuid?.(),gid:process.getgid?.(),pid:process.pid,platform:process.platform}))']
console.log(JSON.stringify({node: process.version, host: os.hostname(), worker: user, command: ['systemd-run', ...args]}))
if (process.argv.includes('--run')) {
  const result = spawnSync('systemd-run', args, { encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  process.exit(result.status ?? 1)
}
