import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const windows = process.platform === 'win32';
const runtime = join(root, '.internpath-dev');
const lockPath = join(runtime, 'operation.lock');
const statePath = join(runtime, 'stack.json');
const logPath = join(runtime, 'stack.log');
const envPath = join(root, '.env');
const runtimeEnvPath = join(root, '.env.internpath-current');
const dockerContext = ['--context', 'desktop-linux'];
const compose = [...dockerContext, 'compose', '--profile', 'infra'];
const containers = ['postgres', 'rabbitmq', 'mailpit', 'rustfs'];
const services = [
  ['identity', 3001],
  ['job', 3002],
  ['verification', 3003],
  ['lifecycle', 3004],
  ['notification', 3005],
];
const webUrl = 'http://localhost:3100/';
const tokenPattern = /^[\da-f-]{36}$/;
const appPorts = [3000, ...services.map(([, port]) => port), 3100];
const children = new Set();

function pnpmCommand(args) {
  if (!windows) return ['pnpm', args];
  const entry = process.env.npm_execpath;
  if (!entry) throw new Error('Run this command through pnpm.');
  // pnpm's .cmd shim needs a shell. Use the CLI entry point from the current pnpm invocation.
  if (extname(entry).toLowerCase() === '.exe') return [entry, args];
  return [process.execPath, [entry, ...args]];
}

function run(command, args, { capture = false, env = process.env } = {}) {
  const [program, programArgs] = command === 'pnpm' ? pnpmCommand(args) : [command, args];
  const result = spawnSync(program, programArgs, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stderr) console.error(result.stderr.trimEnd());
    throw new Error(`${command} ${args.join(' ')} failed (${result.signal ?? result.status}).`);
  }
  return result.stdout?.trim();
}

function dockerRunning() {
  const result = spawnSync('docker', [...dockerContext, 'info'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function startInfra(selected) {
  if (!dockerRunning()) run('docker', ['desktop', 'start', '--timeout', '90']);
  run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '90', ...selected]);
}

function readStack() {
  if (!existsSync(statePath)) return null;
  const { pid, token } = JSON.parse(readFileSync(statePath, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 1 || !tokenPattern.test(token)) {
    throw new Error('Invalid dev stack state in .internpath-dev/stack.json.');
  }
  const result = windows
    ? spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
        ],
        { encoding: 'utf8', windowsHide: true },
      )
    : spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (windows && result.status !== 0) {
    throw new Error('PowerShell could not verify the InternPATH supervisor process.');
  }
  const command = result.stdout.trimEnd();
  const expectedArgs = ` ${script} supervise ${token}`;
  const quotedArgs = ` "${script}" supervise ${token}`;
  return command.endsWith(expectedArgs) || command.endsWith(quotedArgs) ? pid : null;
}

function signal(pid, value) {
  try {
    return process.kill(pid, value);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

function stopWindowsTree(pid) {
  if (signal(pid, 0)) run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
}

async function stopApps(pid = readStack()) {
  if (windows && pid) {
    stopWindowsTree(pid);
  } else if (pid && signal(-pid, 'SIGTERM')) {
    const deadline = Date.now() + 10_000;
    while (signal(-pid, 0) && Date.now() < deadline) await delay(200);
    if (signal(-pid, 'SIGKILL')) {
      const killDeadline = Date.now() + 3_000;
      while (signal(-pid, 0) && Date.now() < killDeadline) await delay(200);
      if (signal(-pid, 0)) throw new Error('The InternPATH process group has not stopped.');
    }
  }
  rmSync(statePath, { force: true });
}

async function waitForHttp(port, path) {
  const url = `http://127.0.0.1:${port}${path}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
    await response?.body?.cancel();
    if (response?.ok) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is in use. Stop that process and try again.`, { cause: error })
          : error,
      );
    });
    server.listen(port, () => server.close(resolve));
  });
}

function stopSupervisor(error) {
  console.error(error.message);
  if (!windows) {
    signal(-process.pid, 'SIGTERM');
    return;
  }
  for (const child of children) {
    try {
      if (child.pid) stopWindowsTree(child.pid);
    } catch (stopError) {
      console.error(stopError.message);
    }
  }
  process.exit(1);
}

function readEnv(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

function prepareBroker() {
  const url = process.env.RABBITMQ_URL ?? readEnv(envPath).RABBITMQ_URL;
  if (!url) throw new Error('Set RABBITMQ_URL in .env.');
  const broker = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(broker.hostname)) return;
  if (broker.protocol !== 'amqp:' || (broker.port && broker.port !== '5672')) return;

  const vhost = decodeURIComponent(broker.pathname.slice(1)) || '/';
  if (vhost !== '/') {
    // A recreated RabbitMQ container may be missing the local runtime's virtual host.
    const ctl = [...compose, 'exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q'];
    const vhosts = run('docker', [...ctl, 'list_vhosts', 'name'], { capture: true });
    if (!vhosts.split('\n').includes(vhost)) run('docker', [...ctl, 'add_vhost', vhost]);
    const user = decodeURIComponent(broker.username);
    run('docker', [...ctl, 'set_permissions', '-p', vhost, user, '.*', '.*', '.*']);
  }
  run('pnpm', ['infra:topology'], { env: { ...process.env, RABBITMQ_URL: url } });
}

function launchApp(name, task = 'start:dev') {
  const [command, args] = pnpmCommand(['--filter', `@internpath/${name}`, task]);
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.add(child);
  child.once('error', stopSupervisor);
  child.once('exit', (code, exitSignal) => {
    children.delete(child);
    stopSupervisor(new Error(`${name} exited (${exitSignal ?? code}).`));
  });
}

async function supervise() {
  prepareBroker();
  const [[identity, identityPort], ...backends] = services;
  launchApp(identity);
  await waitForHttp(identityPort, '/ready');
  for (const [name] of backends) launchApp(name);
  await Promise.all(backends.map(([, port]) => waitForHttp(port, '/ready')));
  launchApp('gateway');
  await waitForHttp(3000, '/health');
  launchApp('web', 'dev');
  await waitForHttp(3100, '/');
  if (process.connected) {
    process.send('ready');
    process.disconnect();
  }
}

async function startApps() {
  const token = randomUUID();
  const env = { ...process.env, ...readEnv(runtimeEnvPath) };
  const log = openSync(logPath, 'w', 0o600);
  const supervisor = spawn(process.execPath, [script, 'supervise', token], {
    cwd: root,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log, 'ipc'],
  });
  closeSync(log);

  const ready = new Promise((resolve, reject) => {
    supervisor.once('message', resolve);
    supervisor.once('error', reject);
    supervisor.once('exit', () =>
      reject(new Error('An InternPATH process exited during startup.')),
    );
  });
  try {
    if (supervisor.pid) writeFileSync(statePath, JSON.stringify({ pid: supervisor.pid, token }));
    await ready;
    supervisor.unref();
  } catch (error) {
    await stopApps(supervisor.pid ?? null);
    throw new Error(`${error.message} See .internpath-dev/stack.log.`, { cause: error });
  }
}

async function up() {
  if (readStack()) {
    console.log(`InternPATH is already running at ${webUrl} Run pnpm dev:down before updating it.`);
    return;
  }
  if (run('git', ['branch', '--show-current'], { capture: true }) !== 'main') {
    throw new Error('Switch to main before running pnpm dev:up.');
  }
  if (!existsSync(envPath)) throw new Error('Set up .env as shown in docs/getting-started.md.');

  await Promise.all(appPorts.map(checkPort));

  run('git', ['pull', '--ff-only', 'origin', 'main']);
  run('pnpm', ['install', '--frozen-lockfile']);
  run('pnpm', ['--filter', './apps/*', '--if-present', 'prisma:generate']);
  startInfra(containers);
  console.log('Starting InternPATH. Logs are in .internpath-dev/stack.log.');
  await startApps();
  console.log(`InternPATH is ready at ${webUrl}`);
}

async function down() {
  await stopApps();
  if (dockerRunning()) {
    run('docker', [...compose, 'stop', ...containers]);
    if (run('docker', [...dockerContext, 'ps', '--quiet'], { capture: true })) {
      throw new Error('InternPATH stopped. Docker Desktop is still running for other containers.');
    }
    run('docker', ['desktop', 'stop', '--timeout', '60']);
  }
  console.log('InternPATH and Docker Desktop stopped.');
}

function databaseTarget(settings, key, port) {
  const value = settings[key];
  const url = URL.canParse(value) ? new URL(value) : null;
  if (
    !url ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    (url.port || '5432') !== port ||
    url.pathname.length <= 1
  ) {
    throw new Error(`${key} must point to a local InternPATH PostgreSQL database on port ${port}.`);
  }
  return [decodeURIComponent(url.pathname), url.searchParams.get('schema') ?? 'public'];
}

function migrationEnv() {
  const shared = readEnv(envPath);
  const hasOverlay = existsSync(runtimeEnvPath);
  const overlay = readEnv(runtimeEnvPath);
  const localPort = process.env.POSTGRES_PORT || shared.POSTGRES_PORT || '5432';
  const urls = {};
  const databases = new Set();

  for (const [name] of services) {
    const prefix = name.toUpperCase();
    const appUrl = `${prefix}_DATABASE_URL`;
    const directUrl = `${prefix}_DIRECT_URL`;
    if (hasOverlay && (!overlay[appUrl] || !overlay[directUrl])) {
      throw new Error(`Set both ${appUrl} and ${directUrl} in .env.internpath-current.`);
    }
    // Nest loads the app's .env before the root .env, with inherited variables taking precedence.
    const settings = {
      ...shared,
      ...readEnv(join(root, 'apps', name, '.env')),
      ...process.env,
      ...overlay,
    };
    const [database, schema] = databaseTarget(settings, appUrl, localPort);
    const [directDatabase, directSchema] = databaseTarget(settings, directUrl, localPort);
    if (database !== directDatabase || schema !== directSchema) {
      throw new Error(`${appUrl} and ${directUrl} must target the same database and schema.`);
    }
    if (databases.has(database)) throw new Error(`Configure a separate database for ${name}.`);
    databases.add(database);
    urls[appUrl] = settings[appUrl];
    urls[directUrl] = settings[directUrl];
  }
  return { ...process.env, ...urls };
}

function migrate() {
  if (readStack()) throw new Error('Run pnpm dev:down before migrating the local databases.');
  if (!existsSync(envPath)) throw new Error('Set up .env as shown in docs/getting-started.md.');
  const env = migrationEnv();
  startInfra(['postgres']);
  for (const [name] of services) {
    run('pnpm', ['--filter', `@internpath/${name}`, 'exec', 'prisma', 'migrate', 'deploy'], {
      env,
    });
  }
  console.log('InternPATH migrations completed.');
}

const actions = { up, down, migrate };
const action = process.argv[2];
const isSupervisor =
  action === 'supervise' && process.connected && tokenPattern.test(process.argv[3]);
try {
  if (isSupervisor) {
    await supervise();
  } else {
    if (!windows && process.platform !== 'darwin') {
      throw new Error('These commands require Docker Desktop on Windows or macOS.');
    }
    if (!Object.hasOwn(actions, action)) {
      throw new Error('Use pnpm dev:up, pnpm dev:down, or pnpm dev:migrate.');
    }
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error('Another InternPATH dev command is in progress.', { cause: error });
    }
    const unlock = () => rmSync(lockPath, { force: true });
    process.once('exit', unlock);
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
    try {
      await actions[action]();
    } finally {
      process.removeListener('exit', unlock);
      unlock();
    }
  }
} catch (error) {
  if (isSupervisor) stopSupervisor(error);
  else {
    console.error(error.message);
    process.exitCode = 1;
  }
}
