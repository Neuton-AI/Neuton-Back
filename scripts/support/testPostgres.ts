import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const backend = fileURLToPath(new URL('../../', import.meta.url));
const tempRoot = fileURLToPath(new URL('../../../Temp/', import.meta.url));
const host = '127.0.0.1';
const username = 'neuton_test_runner';
const password = randomBytes(24).toString('hex');
const systemKeys = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'SYSTEMDRIVE']);
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toUpperCase())));
childEnv.NEUTON_SKIP_ENV_FILES = '1';
childEnv.TSX_TSCONFIG_PATH = 'tsconfig.test.json';

function run(command: string, args: string[], env = childEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: backend, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer().once('error', reject);
    listener.listen(0, host, () => {
      const address = listener.address();
      listener.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not select a local PostgreSQL port'));
      });
    });
  });
}

await mkdir(tempRoot, { recursive: true });
const directory = await mkdtemp(join(tempRoot, 'neuton-postgres-'));
const dataDirectory = join(directory, 'data');
const passwordFile = join(directory, 'password');
const pgCtlArgs = ['-D', dataDirectory, '-w'];
const requestedTests = process.argv.slice(2);
let started = false;

try {
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  await run('initdb', ['-D', dataDirectory, '-U', username, '--auth=scram-sha-256',
    `--pwfile=${passwordFile}`, '--encoding=UTF8', '--locale=C']);
  await rm(passwordFile);
  const port = await availablePort();
  await appendFile(join(dataDirectory, 'postgresql.conf'),
    `\nlisten_addresses = '${host}'\nport = ${port}\nunix_socket_directories = ''\n`);
  await run('pg_ctl', [...pgCtlArgs, '-l', join(directory, 'postgres.log'), 'start']);
  started = true;

  const adminUrl = `postgresql://${username}:${password}@${host}:${port}/postgres`;
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 5 });
  try {
    const [server] = await admin<{ data_directory: string }[]>`SHOW data_directory`;
    if (!server || await realpath(server.data_directory) !== await realpath(dataDirectory)) {
      throw new Error('PostgreSQL did not start in the disposable data directory');
    }
    await admin`CREATE DATABASE neuton_disposable`;
  } finally {
    await admin.end();
  }

  const url = new URL('/neuton_disposable', adminUrl).href;
  const env = { ...childEnv, DATABASE_URL: url };
  await run(process.execPath, ['--import', 'tsx', '--import', './scripts/support/testEnv.ts', 'src/db/migrate.ts'], env);
  const testFiles = requestedTests.length ? requestedTests : (await readdir(join(backend, 'scripts')))
    .filter((name) => name.endsWith('.test.ts')).map((name) => `scripts/${name}`);
  await run(process.execPath, ['--import', 'tsx', '--import', './scripts/support/testEnv.ts', '--test', '--', ...testFiles], env);
} finally {
  if (started) await run('pg_ctl', [...pgCtlArgs, '-m', 'fast', 'stop']);
  await rm(directory, { recursive: true, maxRetries: 3 });
}
