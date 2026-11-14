const { execFileSync, spawn } = require('node:child_process');
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Client } = require('../apps/identity/node_modules/pg');
const { argon2idAsync } = require('../apps/identity/node_modules/@noble/hashes/argon2');

const root = path.resolve(__dirname, '..');
const identityRoot = path.join(root, 'apps/identity');
const gatewayRoot = path.join(root, 'apps/gateway');
const envText = readFileSync(path.join(root, '.env'), 'utf8');
const envValue = (name) => envText.split(/\r?\n/).find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).replace(/^"|"$/g, '');
const directUrl = envValue('IDENTITY_DIRECT_URL');
const brokerUrl = envValue('RABBITMQ_URL');
if (!directUrl || !brokerUrl) throw new Error('Identity database or RabbitMQ URL is missing');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, child, expectStatus = 200) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`Service exited before ready: ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.status === expectStatus) return;
    } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Service did not become ready: ${url}`);
}

function startService(cwd, env) {
  const register = require.resolve('../node_modules/ts-node/register');
  const child = spawn(process.execPath, ['-r', register, 'src/main.ts'], {
    cwd, env: { ...process.env, ...env, DISABLE_INFRA: 'false', LOG_LEVEL: 'silent' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.stdout.on('data', () => undefined);
  return { child, errors: () => stderr };
}

async function main() {
  const adminUrl = new URL(directUrl); adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  const dbName = `id_e2e_${randomBytes(4).toString('hex')}`;
  let identity;
  let gateway;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const databaseUrl = new URL(directUrl); databaseUrl.pathname = `/${dbName}`;
    execFileSync(process.execPath, [require.resolve('../apps/identity/node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: identityRoot, env: { ...process.env, IDENTITY_DATABASE_URL: databaseUrl.toString(),
        IDENTITY_DIRECT_URL: databaseUrl.toString() }, stdio: 'pipe',
    });
    const db = new Client({ connectionString: databaseUrl.toString() });
    await db.connect();
    const userId = randomUUID();
    const companyId = randomUUID();
    const password = 'IntegrationPassword!123';
    const salt = randomBytes(16);
    const hash = await argon2idAsync(password, salt, { t: 3, m: 64 * 1024, p: 1, dkLen: 32 });
    const passwordHash = `$argon2id$v=19$m=65536,t=3,p=1$${salt.toString('base64').replace(/=+$/u, '')}$${Buffer.from(hash).toString('base64').replace(/=+$/u, '')}`;
    await db.query(`INSERT INTO users (id,email,password_hash,role,status,email_verified_at,full_name)
      VALUES ($1,'integration@test.ac.th',$2,'STUDENT','ACTIVE',NOW(),'Integration User')`, [userId, passwordHash]);
    await db.query(`INSERT INTO companies (id,name,registration_no,email_domain,status)
      VALUES ($1,'Integration Company','INTEGRATION-001','integration.test','VERIFIED')`, [companyId]);
    await db.end();

    const keypair = generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const secret = randomBytes(32).toString('hex');
    const edgeSecret = randomBytes(24).toString('hex');
    const identityPort = await freePort();
    const gatewayPort = await freePort();
    const identityUrl = `http://127.0.0.1:${identityPort}`;
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    identity = startService(identityRoot, { PORT: String(identityPort), IDENTITY_DATABASE_URL: databaseUrl.toString(),
      IDENTITY_DIRECT_URL: databaseUrl.toString(), RABBITMQ_URL: brokerUrl,
      IDENTITY_SERVICE_SECRET_GATEWAY: secret, JWT_PRIVATE_KEY: keypair.privateKey, JWT_PUBLIC_KEY: keypair.publicKey });
    await waitFor(`${identityUrl}/health`, identity.child);
    gateway = startService(gatewayRoot, { PORT: String(gatewayPort), IDENTITY_URL: identityUrl,
      IDENTITY_SERVICE_SECRET_GATEWAY: secret, EDGE_SHARED_SECRET: edgeSecret, JWT_PUBLIC_KEY: keypair.publicKey });
    await waitFor(`${gatewayUrl}/health`, gateway.child);

    const login = await fetch(`${gatewayUrl}/api/v1/auth/login`, { method: 'POST',
      headers: { 'X-Edge-Secret': edgeSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'integration@test.ac.th', password }) });
    if (login.status !== 200) throw new Error(`Login through Gateway returned ${login.status}: ${await login.text()}`);
    const session = await login.json();
    if (!session.access_token || session.user?.id !== userId) throw new Error('Login returned an invalid session');
    const headers = { Authorization: `Bearer ${session.access_token}`, 'X-Edge-Secret': edgeSecret };
    const get = (route) => fetch(`${gatewayUrl}/api/v1${route}`, { headers });
    const blockedInternal = await get('/internal/v1/denylist');
    if (blockedInternal.status !== 404) throw new Error(`Internal route returned ${blockedInternal.status}`);
    const missingToken = await fetch(`${gatewayUrl}/api/v1/users/me`, { headers: { 'X-Edge-Secret': edgeSecret } });
    if (missingToken.status !== 401) throw new Error(`Anonymous profile returned ${missingToken.status}`);

    let profile;
    for (let attempt = 0; attempt < 40; attempt++) {
      profile = await get('/users/me');
      if (profile.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (profile.status !== 200) throw new Error(`Gateway profile returned ${profile.status}: ${await profile.text()}`);
    const user = await profile.json();
    if (user.id !== userId) throw new Error('Wrong user returned through Gateway');

    const updated = await fetch(`${gatewayUrl}/api/v1/users/me`, { method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name: 'Updated via Gateway' }) });
    if (updated.status !== 200 || (await updated.json()).full_name !== 'Updated via Gateway')
      throw new Error(`Profile update through Gateway returned ${updated.status}`);
    const directory = await get('/directory/companies');
    if (directory.status !== 200 || !(await directory.json()).some((company) => company.id === companyId))
      throw new Error(`Directory through Gateway returned ${directory.status}`);

    const updateDb = new Client({ connectionString: databaseUrl.toString() });
    await updateDb.connect();
    await updateDb.query(`INSERT INTO token_denylist (user_id,reason) VALUES ($1,'integration test')`, [userId]);
    await updateDb.end();
    let suspended;
    for (let attempt = 0; attempt < 175; attempt++) {
      suspended = await get('/users/me');
      if (suspended.status === 401) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (suspended.status !== 401 || (await suspended.json()).error?.code !== 'ACCOUNT_SUSPENDED')
      throw new Error(`Gateway did not refresh Identity denylist: ${suspended.status}`);
    console.log('PASS: Gateway → Identity login, profile read/update, Directory, internal route block, denylist refresh');
  } finally {
    if (gateway) gateway.child.kill();
    if (identity) identity.child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (gateway?.errors()) console.error(gateway.errors());
    if (identity?.errors()) console.error(identity.errors());
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
