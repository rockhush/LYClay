import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  DigitalEmployeeInstallRecord,
  DigitalEmployeePackageManifest,
  LocalDigitalEmployee,
} from '../../shared/types/digital-employee';
import { getDigitalEmployeesDir, getLegacyDigitalEmployeesDir } from './paths';

const INSTALL_FILE = 'install.json';
const MANIFEST_FILE = 'employee.json';

function isVisibleStatus(
  status: DigitalEmployeeInstallRecord['status'],
): status is LocalDigitalEmployee['status'] {
  return status === 'active' || status === 'degraded' || status === 'repair-required';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function getDigitalEmployeeInstallPath(instanceId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(instanceId)) {
    throw new Error('Invalid digital employee instanceId');
  }
  return join(getDigitalEmployeesDir(), instanceId);
}

export async function ensureDigitalEmployeesRoot(): Promise<string> {
  const root = getDigitalEmployeesDir();
  await mkdir(root, { recursive: true });
  if (!process.env.CLAWX_DIGITAL_EMPLOYEES_DIR?.trim()) {
    await migrateLegacyDigitalEmployees(root);
  }
  return root;
}

async function migrateLegacyDigitalEmployees(targetRoot: string): Promise<void> {
  const legacyRoot = getLegacyDigitalEmployeesDir();
  if (resolve(legacyRoot) === resolve(targetRoot) || !(await pathExists(legacyRoot))) return;
  const entries = await readdir(legacyRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = join(legacyRoot, entry.name);
    const targetDir = join(targetRoot, entry.name);
    if (await pathExists(targetDir)) continue;
    await rename(sourceDir, targetDir);
    try {
      const record = await readInstallRecord(targetDir);
      await writeInstallRecord(targetDir, { ...record, installPath: targetDir });
    } catch {
      // Keep migrated package contents even when legacy metadata needs later repair.
    }
  }
}

export async function writeInstallRecord(
  installDir: string,
  record: DigitalEmployeeInstallRecord,
): Promise<void> {
  await mkdir(installDir, { recursive: true });
  const tempPath = join(installDir, `${INSTALL_FILE}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(tempPath, join(installDir, INSTALL_FILE));
}

export async function readInstallRecord(installDir: string): Promise<DigitalEmployeeInstallRecord> {
  const raw = await readFile(join(installDir, INSTALL_FILE), 'utf8');
  const record = JSON.parse(raw) as DigitalEmployeeInstallRecord;
  if (record.schemaVersion !== 1 || !record.instanceId || !record.agentId) {
    throw new Error(`Invalid ${INSTALL_FILE} in ${installDir}`);
  }
  return record;
}

export async function readInstalledManifest(installDir: string): Promise<DigitalEmployeePackageManifest> {
  const raw = await readFile(join(installDir, MANIFEST_FILE), 'utf8');
  return JSON.parse(raw) as DigitalEmployeePackageManifest;
}

export async function listLocalDigitalEmployees(): Promise<LocalDigitalEmployee[]> {
  const root = await ensureDigitalEmployeesRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const employees: LocalDigitalEmployee[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const installDir = join(root, entry.name);
    if (!(await pathExists(join(installDir, INSTALL_FILE)))) continue;
    try {
      const [record, manifest] = await Promise.all([
        readInstallRecord(installDir),
        readInstalledManifest(installDir),
      ]);
      if (!isVisibleStatus(record.status)) continue;
      employees.push({
        instanceId: record.instanceId,
        marketEmployeeId: record.marketEmployeeId,
        packageId: record.packageId,
        packageVersion: record.packageVersion,
        name: manifest.package.name,
        description: manifest.package.description,
        category: manifest.package.category,
        tags: manifest.package.tags ?? [],
        installPath: record.installPath,
        agentId: record.agentId,
        sessionKey: `agent:${record.agentId}:main`,
        status: record.status,
        enabled: record.userEnabled !== false,
        warnings: record.warnings,
      });
    } catch {
      // Broken entries are intentionally omitted until repair support handles them.
    }
  }

  return employees.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listDigitalEmployeeAgentIds(): Promise<Set<string>> {
  const employees = await listLocalDigitalEmployees();
  return new Set(employees.map((employee) => employee.agentId));
}

export async function findInstalledDigitalEmployeeByPackageId(
  packageId: string,
): Promise<DigitalEmployeeInstallRecord | null> {
  const root = await ensureDigitalEmployeesRoot();
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const installDir = join(root, entry.name);
    if (!(await pathExists(join(installDir, INSTALL_FILE)))) continue;
    try {
      const record = await readInstallRecord(installDir);
      if (record.packageId === packageId && isVisibleStatus(record.status)) {
        return record;
      }
    } catch {
      // Invalid installation records are handled by repair flows.
    }
  }
  return null;
}

export async function publishPreparedEmployeeDirectory(
  preparedDir: string,
  instanceId: string,
): Promise<string> {
  const targetDir = getDigitalEmployeeInstallPath(instanceId);
  if (await pathExists(targetDir)) throw new Error(`Digital employee instance already exists: ${instanceId}`);
  await mkdir(dirname(targetDir), { recursive: true });
  await rename(preparedDir, targetDir);
  return targetDir;
}

export async function setDigitalEmployeeEnabled(
  instanceId: string,
  enabled: boolean,
): Promise<DigitalEmployeeInstallRecord> {
  const installDir = getDigitalEmployeeInstallPath(instanceId);
  const record = await readInstallRecord(installDir);
  if (!isVisibleStatus(record.status)) {
    throw new Error(`Digital employee "${instanceId}" is not installed`);
  }
  const updated: DigitalEmployeeInstallRecord = {
    ...record,
    userEnabled: enabled,
    updatedAt: new Date().toISOString(),
  };
  await writeInstallRecord(installDir, updated);
  return updated;
}

export async function removeDigitalEmployeeDirectory(path: string): Promise<void> {
  const root = resolve(getDigitalEmployeesDir());
  const target = resolve(path);
  if (target === root || !target.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Refusing to remove path outside digital employees root');
  }
  await rm(target, { recursive: true, force: true });
}
