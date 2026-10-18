// A local stand-in for the `daytona` CLI, injected as ctx.daytonaRun(args, opts).
//
// Each sandbox is a temporary HOME. `exec` runs the command string with /bin/sh in that HOME, so
// the provider's real remote scripts (bootstrap.sh, the seed steps, the sentinel) run for real
// against a local bare remote. gh, claude and herdr are stub scripts in $HOME/.local/bin that log
// their arguments. Every call is recorded so tests can assert on exactly what reached the CLI.

import { execFile } from 'node:child_process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './index.mjs';

const STUBS = {
  gh: `#!/bin/sh
echo "gh $*" >> "$HOME/gh.log"
if [ "$1 $2" = "auth login" ]; then cat > "$HOME/gh-received"; fi
exit 0
`,
  claude: `#!/bin/sh
echo "claude $*" >> "$HOME/claude.log"
exit 0
`,
  herdr: `#!/bin/sh
echo "herdr $*" >> "$HOME/herdr.log"
exit 0
`,
};

let scriptSeq = 0;
async function sh(home, cmd, timeoutMs) {
  // On Windows the command line mangles long, quoted commands (32k limit, quoting rules), so the
  // command goes through a script file run by Git for Windows' sh. Elsewhere: sh -c, as before.
  let args = ['-c', cmd];
  if (process.platform === 'win32') {
    const file = join(home, `.mock-cmd-${process.pid}-${++scriptSeq}.sh`);
    await writeFile(file, cmd);
    args = [file];
  }
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'sh' : '/bin/sh', args, {
      cwd: home,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: home, LANG: 'C' },
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

export async function mockDaytona({ failCreate = false } = {}) {
  const root = await tempDir('padakan-daytona-');
  const boxes = new Map(); // id -> { home, state }
  const calls = [];
  const opts = { dropSentinel: false, execDown: false };

  async function run(args, { timeout = 600_000 } = {}) {
    calls.push(args);
    const [verb, id] = args;
    const box = boxes.get(id);
    switch (verb) {
      case 'version':
        return { code: 0, stdout: 'Daytona CLI version v0.192.0\n', stderr: '' };
      case 'list':
        return { code: 0, stdout: [...boxes].map(([n, b]) => `${n}\t${b.state}`).join('\n'), stderr: '' };
      case 'snapshot':
        return { code: 0, stdout: 'padakan-base\tactive\n', stderr: '' };
      case 'create': {
        const name = args[args.indexOf('--name') + 1];
        if (failCreate) return { code: 1, stdout: '', stderr: 'quota exceeded' };
        if (boxes.has(name)) return { code: 1, stdout: '', stderr: 'sandbox already exists' };
        const home = join(root, name);
        await mkdir(join(home, '.local', 'bin'), { recursive: true });
        for (const [bin, text] of Object.entries(STUBS)) {
          await writeFile(join(home, '.local', 'bin', bin), text);
          await chmod(join(home, '.local', 'bin', bin), 0o755);
        }
        boxes.set(name, { home, state: 'started' });
        return { code: 0, stdout: `Sandbox ${name} created\n`, stderr: '' };
      }
      case 'exec': {
        if (!box || box.state !== 'started' || opts.execDown) return { code: 1, stdout: '', stderr: 'sandbox is not running' };
        const cmd = args.slice(args.indexOf('--') + 1).join(' ');
        if (opts.dropSentinel && /^cat .*run-[0-9a-f]+\.done/.test(cmd)) return { code: 0, stdout: '', stderr: '' };
        const r = await sh(box.home, cmd, timeout);
        return { ...r, code: 0 }; // like the real CLI: the exit status does not carry the command's
      }
      case 'info':
        if (!box || box.state === 'deleted') return { code: 1, stdout: '', stderr: `sandbox ${id} not found` };
        return { code: 0, stdout: `Name:   ${id}\nState:  ${box.state}\nTarget: eu\n`, stderr: '' };
      case 'stop':
      case 'start':
        if (!box || box.state === 'deleted') return { code: 1, stdout: '', stderr: 'not found' };
        box.state = verb === 'stop' ? 'stopped' : 'started';
        return { code: 0, stdout: '', stderr: '' };
      case 'delete':
        if (!box || box.state === 'deleted') return { code: 1, stdout: '', stderr: `sandbox ${id} not found` };
        box.state = 'deleted';
        return { code: 0, stdout: '', stderr: '' };
      case 'preview-url':
        return { code: 0, stdout: `https://${args[3]}-${id}.proxy.daytonaproxy01.net\n`, stderr: '' };
      default:
        return { code: 1, stdout: '', stderr: `unknown command ${verb}` };
    }
  }

  return { run, calls, boxes, opts, root, home: (id) => boxes.get(id)?.home };
}
