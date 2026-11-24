/**
 * Compliance (@compliance): R1/R3/R4 static & artifact verification checks (4 tests).
 * Verifies proprietary IP/no-OSS-license, zero secrets in source/.next/static, scope exclusions, and Terraform/CI validity.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';

const execFileAsync = promisify(execFile);
const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'target', '.next', '.git', '.terraform', 'test-results']);

/** Runs a CLI command asynchronously so Playwright test timeouts remain authoritative. */
async function runCmd(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; missingBinary: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000 });
    return { ok: true, stdout, stderr, missingBinary: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? ''),
      stderr: [e.stderr, !e.stderr ? e.message : ''].filter(Boolean).join('\n'),
      missingBinary: e.code === 'ENOENT',
    };
  }
}

/** Recursively collects regular file paths under dir, skipping build/vendor directories. */
function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('C1 R3 IP protection, proprietary copyright & zero OSS license grant @compliance', async () => {
  const copyrightPath = path.join(REPO_ROOT, 'COPYRIGHT.md');
  expect(fs.existsSync(copyrightPath), 'Missing COPYRIGHT.md at repo root').toBe(true);
  const copyrightText = fs.readFileSync(copyrightPath, 'utf8');
  expect(copyrightText).toMatch(/copyright/i);
  expect(copyrightText).toMatch(/evaluation/i);
  expect(copyrightText).toMatch(/all rights reserved|written permission|no.*commercial/i);

  // Recursively scan repo (ignoring build/vendor dirs) for any OSS LICENSE / COPYING / UNLICENSE files
  for (const file of walkFiles(REPO_ROOT)) {
    const base = path.basename(file);
    if (/^(license|copying|unlicense)($|\.|[-_])|[-_.]license($|\.)/i.test(base)) {
      throw new Error(`Forbidden OSS license file found: ${file}`);
    }
  }

  const cargoPath = path.join(REPO_ROOT, 'backend', 'Cargo.toml');
  expect(fs.existsSync(cargoPath), 'Missing backend/Cargo.toml').toBe(true);
  const cargoToml = fs.readFileSync(cargoPath, 'utf8');
  expect(cargoToml).toMatch(/publish\s*=\s*false/);
  expect(cargoToml).not.toMatch(/^\s*license(-file)?\s*=/m);

  for (const pkgPath of [
    path.join(REPO_ROOT, 'e2e', 'package.json'),
    path.join(REPO_ROOT, 'frontend', 'package.json'),
    ...(fs.existsSync(path.join(REPO_ROOT, 'package.json')) ? [path.join(REPO_ROOT, 'package.json')] : []),
  ]) {
    expect(fs.existsSync(pkgPath), `Missing ${pkgPath}`).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    expect(pkg.private, `${pkgPath} must set private: true`).toBe(true);
    expect(pkg.license, `${pkgPath} must omit license`).toBeUndefined();
    expect(pkg.licenses, `${pkgPath} must omit licenses`).toBeUndefined();
  }
});

test('C2 R3 secret hygiene & .next/static client bundle scan @compliance', async () => {
  const gitignorePath = path.join(REPO_ROOT, '.gitignore');
  expect(fs.existsSync(gitignorePath), 'Missing .gitignore').toBe(true);
  const gitignore = fs.readFileSync(gitignorePath, 'utf8');
  expect(gitignore).toMatch(/^\s*\.env\b/m);
  expect(gitignore).toMatch(/\.env\.local|\.env\.\*/);
  expect(gitignore).toMatch(/\*\.tfstate/);
  expect(gitignore).toMatch(/\*\.tfvars/);

  const sourceRoots = [
    path.join(REPO_ROOT, 'backend', 'src'),
    path.join(REPO_ROOT, 'frontend', 'src'),
    path.join(REPO_ROOT, 'e2e', 'tests'),
    path.join(REPO_ROOT, 'infra'),
    path.join(REPO_ROOT, '.github'),
  ];
  const nextConfigs = ['next.config.ts', 'next.config.mjs', 'next.config.js']
    .map((f) => path.join(REPO_ROOT, 'frontend', f))
    .filter((f) => fs.existsSync(f));

  for (const file of [...sourceRoots.flatMap(walkFiles), ...nextConfigs]) {
    const content = fs.readFileSync(file, 'utf8');
    expect(content, `AWS key pattern in ${file}`).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(content, `Private key header in ${file}`).not.toMatch(/-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----/);
    expect(content, `Hardcoded API token pattern in ${file}`).not.toMatch(
      /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk_live_[A-Za-z0-9]{16,})\b/,
    );
    if (file !== THIS_FILE) {
      expect(content, `Hardcoded secret fallback in ${file}`).not.toMatch(
        /(DEMO_ACCESS_TOKEN|FACILITATOR_TOKEN|ADMIN_TOKEN)[^\n;]{0,80}(?:\?\?|\|\||unwrap_or(?:_else)?\s*\([^)]*)\s*['"][^'"]{4,}['"]/,
      );
      expect(content, `Non-local DB URL with credentials in ${file}`).not.toMatch(
        /postgres(?:ql)?:\/\/[^\s'"`$:{}]+:[^\s'"`$@{}]+@(?!(?:localhost|127\.0\.0\.1|postgres|db)\b)[A-Za-z0-9._-]+/,
      );
    }
  }

  const frontendSrcDir = path.join(REPO_ROOT, 'frontend', 'src');
  expect(fs.existsSync(frontendSrcDir), 'Missing frontend/src').toBe(true);

  const forbiddenClientTokens = [
    'DEMO_ACCESS_TOKEN',
    'FACILITATOR_TOKEN',
    'ADMIN_TOKEN',
    'DATABASE_URL',
    'AWS_SECRET_ACCESS_KEY',
    'postgres://',
    'postgresql://',
  ];
  // Require >= 12 chars so short test words like 'facilitator' never false-fail on UI route strings.
  const runtimeSecrets = [
    process.env.DEMO_ACCESS_TOKEN,
    process.env.FACILITATOR_TOKEN,
    process.env.ADMIN_TOKEN,
  ].filter((v): v is string => typeof v === 'string' && v.length >= 12);

  const scanClientFiles = (files: string[]) => {
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const secretName of forbiddenClientTokens) {
        expect(content, `Forbidden secret ref ${secretName} in ${file}`).not.toContain(secretName);
      }
      for (const secretVal of runtimeSecrets) {
        expect(content, `Leaked runtime secret value in ${file}`).not.toContain(secretVal);
      }
      const nextPubMatches = content.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? [];
      for (const envName of nextPubMatches) {
        expect(envName, `Suspicious NEXT_PUBLIC_* var ${envName} in ${file}`).not.toMatch(
          /(TOKEN|SECRET|PASSWORD|KEY|ADMIN|FACILITATOR|DATABASE|CREDENTIAL)/,
        );
      }
    }
  };

  scanClientFiles(walkFiles(frontendSrcDir));

  const nextStaticDir = path.join(REPO_ROOT, 'frontend', '.next', 'static');
  if (!fs.existsSync(nextStaticDir)) {
    const requireBuild = process.env.CI === 'true' || process.env.E2E_REQUIRE_BUILD === '1';
    if (requireBuild) {
      expect(fs.existsSync(nextStaticDir), 'Missing built frontend/.next/static bundle').toBe(true);
    } else {
      test.skip(true, 'frontend/.next/static not built yet (set CI=true or E2E_REQUIRE_BUILD=1 to enforce)');
    }
  } else {
    scanClientFiles(walkFiles(nextStaticDir));
  }
});

test('C3 R1/R3 scope exclusions (no AI, payments, accounts, native mobile, or mocks) @compliance', async () => {
  expect(fs.existsSync(path.join(REPO_ROOT, 'ios'))).toBe(false);
  expect(fs.existsSync(path.join(REPO_ROOT, 'android'))).toBe(false);

  const forbiddenExactPkgs = [
    'ai',
    'ollama',
    'openai',
    'anthropic',
    'langchain',
    'async-openai',
    'async_openai',
    'rig-core',
    'rig_core',
    'stripe',
    'paypal',
    'paddle',
    'braintree',
    'react-native',
    'expo',
    'capacitor',
    'faker',
  ];
  const forbiddenPkgPrefixes = ['@ai-sdk/', '@anthropic-ai/', '@stripe/', '@capacitor/', '@faker-js/'];

  const cargoPath = path.join(REPO_ROOT, 'backend', 'Cargo.toml');
  expect(fs.existsSync(cargoPath), 'Missing backend/Cargo.toml').toBe(true);
  const cargo = fs.readFileSync(cargoPath, 'utf8').toLowerCase();

  const fePkgPath = path.join(REPO_ROOT, 'frontend', 'package.json');
  expect(fs.existsSync(fePkgPath), 'Missing frontend/package.json').toBe(true);
  const fePkg = JSON.parse(fs.readFileSync(fePkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const feDeps = [...Object.keys(fePkg.dependencies ?? {}), ...Object.keys(fePkg.devDependencies ?? {})];

  for (const dep of feDeps) {
    const isForbidden =
      forbiddenExactPkgs.includes(dep) || forbiddenPkgPrefixes.some((prefix) => dep.startsWith(prefix));
    expect(isForbidden, `Forbidden dependency ${dep} in frontend/package.json`).toBe(false);
  }
  for (const pkg of forbiddenExactPkgs) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(cargo, `Forbidden crate ${pkg} in backend/Cargo.toml`).not.toMatch(
      new RegExp(`(^\\s*${escaped}\\s*=|^\\[dependencies\\.${escaped}\\])`, 'm'),
    );
  }

  const migrationsDir = path.join(REPO_ROOT, 'backend', 'migrations');
  expect(fs.existsSync(migrationsDir), 'Missing backend/migrations').toBe(true);
  const initSqlPath = path.join(migrationsDir, '0001_init.sql');
  expect(fs.existsSync(initSqlPath), 'Missing 0001_init.sql').toBe(true);
  const initSql = fs.readFileSync(initSqlPath, 'utf8');
  expect(initSql, 'Forbidden participant account table in 0001_init.sql').not.toMatch(
    /CREATE\s+TABLE[^;]*\b(participant_accounts)\b/i,
  );

  const appSrcFiles = [
    ...walkFiles(path.join(REPO_ROOT, 'backend', 'src')),
    ...walkFiles(path.join(REPO_ROOT, 'frontend', 'src')),
  ];
  expect(appSrcFiles.length).toBeGreaterThan(0);
  for (const file of appSrcFiles) {
    const src = fs.readFileSync(file, 'utf8');
    expect(src, `Mock data marker in ${file}`).not.toMatch(/\b(MOCK_DATA|mockResponses|mockSessions|mockWorkshop|DUMMY_DATA)\b/);
  }
});

test('C4 R4 AWS Terraform (fmt -check, validate) & GitHub Actions CI/CD validation @compliance', async () => {
  test.setTimeout(240_000);
  const infraDir = path.join(REPO_ROOT, 'infra');
  expect(fs.existsSync(infraDir), 'Missing infra/ directory').toBe(true);
  const tfFiles = fs.readdirSync(infraDir).filter((f) => f.endsWith('.tf'));
  expect(tfFiles.length, 'Expected .tf files in infra/').toBeGreaterThan(0);

  const combinedTf = tfFiles.map((f) => fs.readFileSync(path.join(infraDir, f), 'utf8')).join('\n');
  expect(combinedTf).toMatch(/demo_enabled/);
  expect(combinedTf).not.toMatch(/AKIA[0-9A-Z]{16}|-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----/);

  const fmt = await runCmd('terraform', ['fmt', '-check', '-recursive', infraDir]);
  expect(fmt.missingBinary, 'terraform binary unavailable').toBe(false);
  expect(fmt.ok, `terraform fmt -check failed:\n${fmt.stdout}\n${fmt.stderr}`).toBe(true);

  if (fs.existsSync(path.join(infraDir, '.terraform'))) {
    const val = await runCmd('terraform', ['validate'], infraDir);
    expect(val.ok, `terraform validate failed:\n${val.stdout}\n${val.stderr}`).toBe(true);
  } else {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-tf-'));
    try {
      for (const f of tfFiles) fs.copyFileSync(path.join(infraDir, f), path.join(tmpDir, f));
      const init = await runCmd('terraform', ['init', '-backend=false', '-input=false'], tmpDir);
      if (init.ok) {
        const val = await runCmd('terraform', ['validate'], tmpDir);
        expect(val.ok, `terraform validate failed:\n${val.stdout}\n${val.stderr}`).toBe(true);
      } else if (process.env.CI === 'true' || process.env.E2E_REQUIRE_TERRAFORM_VALIDATE === '1') {
        expect(init.ok, `terraform init failed in CI:\n${init.stderr}`).toBe(true);
      } else {
        const isTransientNet =
          /Failed to query available provider packages|could not connect|network|TLS|timeout|registry\.terraform\.io/i.test(
            init.stderr,
          );
        if (!isTransientNet && /Error:|Invalid|Unsupported|Missing required/i.test(init.stderr)) {
          expect(init.ok, `terraform init config/syntax error:\n${init.stderr}`).toBe(true);
        }
        test.skip(true, `terraform init skipped offline: ${init.stderr.slice(0, 200)}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const ciPath = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
  expect(fs.existsSync(ciPath), 'Missing .github/workflows/ci.yml').toBe(true);
  const ciText = fs.readFileSync(ciPath, 'utf8');
  expect(ciText).toMatch(/cargo\s+fmt\b/);
  expect(ciText).toMatch(/cargo\s+clippy\b/);
  expect(ciText).toMatch(/cargo\s+test\b/);
  expect(ciText).toMatch(/terraform\b[^\n]*\bfmt\b/);
  expect(ciText).toMatch(/terraform\b[^\n]*\bvalidate\b/);
  expect(ciText).toMatch(/\blint\b/);
  expect(ciText).toMatch(/\btypecheck\b/);
  expect(ciText).toMatch(/\bbuild\b/);

  const pyCheck = await runCmd('python', [
    '-c',
    'import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding="utf-8"))',
    ciPath,
  ]);
  if (!pyCheck.missingBinary && !/No module named '?yaml'?/i.test(pyCheck.stderr)) {
    expect(pyCheck.ok, `ci.yml YAML parse failed:\n${pyCheck.stderr}`).toBe(true);
  }

  const actionlint = await runCmd('actionlint', [ciPath]);
  if (!actionlint.missingBinary) {
    expect(actionlint.ok, `actionlint failed:\n${actionlint.stdout}\n${actionlint.stderr}`).toBe(true);
  }
});
