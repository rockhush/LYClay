/**
 * Skill Security Validator
 *
 * P0 security checks for skill upload/installation:
 * - Path traversal prevention (ZIP entries must not escape the target directory)
 * - Executable file detection (block .exe/.sh/.ps1/.dll/.so etc.)
 * - ZIP bomb detection (compression ratio, file count, total size, nesting depth)
 * - Symlink/symlink detection in ZIP archives
 */

import { join } from 'path';
import * as fs from 'fs';
import { evaluatePromptInjectionPolicy } from '../security/prompt-injection-policy';
import {
  evaluateSkillFrontmatterPermissions,
  type SkillPermissionPolicyResult,
} from '../security/skill-permission-policy';

// ── ZIP Central Directory Reader (zero-dependency) ───────────────────────────

/**
 * Read ZIP central directory entries without decompressing.
 * Only uses Node.js built-in `fs` — no external ZIP library required.
 *
 * This reads the End of Central Directory (EOCD) record to locate the
 * central directory, then parses each file header to extract metadata.
 */
export function readZipEntries(zipFilePath: string): ZipEntryInfo[] {
  const fd = fs.openSync(zipFilePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize < 22) {
      // ZIP file must be at least 22 bytes (minimum EOCD size)
      throw new Error('File is too small to be a valid ZIP archive');
    }

    // Read the last 64KB to find the EOCD record (with comment support)
    const searchSize = Math.min(65536, fileSize);
    const searchStart = fileSize - searchSize;
    const buffer = Buffer.alloc(searchSize);
    fs.readSync(fd, buffer, 0, searchSize, searchStart);

    // Find EOCD signature (0x06054b50) — search backwards for robustness
    const EOCD_SIG = 0x06054b50;
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === EOCD_SIG) {
        eocdOffset = searchStart + i;
        break;
      }
    }

    if (eocdOffset < 0) {
      throw new Error('Invalid ZIP: End of Central Directory record not found');
    }

    // Read the full EOCD record (22 bytes minimum)
    const eocdBuf = Buffer.alloc(22);
    fs.readSync(fd, eocdBuf, 0, 22, eocdOffset);

    // Verify signature again
    if (eocdBuf.readUInt32LE(0) !== EOCD_SIG) {
      throw new Error('Invalid ZIP EOCD signature');
    }

    const totalEntries = eocdBuf.readUInt16LE(10);
    const cdSize = eocdBuf.readUInt32LE(12);
    const cdOffset = eocdBuf.readUInt32LE(16);

    if (totalEntries === 0) {
      throw new Error('ZIP archive contains no entries');
    }

    // Read the central directory
    const cdBuffer = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuffer, 0, cdSize, cdOffset);

    // Parse central directory entries
    const entries: ZipEntryInfo[] = [];
    const CD_FILE_HEADER_SIG = 0x02014b50;
    let pos = 0;

    for (let i = 0; i < totalEntries; i++) {
      if (pos + 46 > cdBuffer.length) break;

      const sig = cdBuffer.readUInt32LE(pos);
      if (sig !== CD_FILE_HEADER_SIG) {
        // Skip to next signature (robust recovery)
        const nextSig = findSignature(cdBuffer, pos + 1, CD_FILE_HEADER_SIG);
        if (nextSig < 0) break;
        pos = nextSig;
        continue;
      }

      const versionMadeBy = cdBuffer.readUInt16LE(pos + 4);
      // const generalPurpose = cdBuffer.readUInt16LE(pos + 8);
      // const compressionMethod = cdBuffer.readUInt16LE(pos + 10);
      const compressedSize = cdBuffer.readUInt32LE(pos + 20);
      const uncompressedSize = cdBuffer.readUInt32LE(pos + 24);
      const fileNameLength = cdBuffer.readUInt16LE(pos + 28);
      const extraFieldLength = cdBuffer.readUInt16LE(pos + 30);
      const fileCommentLength = cdBuffer.readUInt16LE(pos + 32);
      const externalFileAttributes = cdBuffer.readUInt32LE(pos + 38);

      if (pos + 46 + fileNameLength > cdBuffer.length) break;

      // Read filename
      const fileName = cdBuffer.toString('utf8', pos + 46, pos + 46 + fileNameLength);

      // Detect directory (trailing slash or external attributes bit)
      const isDirectory =
        fileName.endsWith('/') || fileName.endsWith('\\') ||
        ((externalFileAttributes & 0x10) !== 0); // MS-DOS directory bit

      // Detect symlink (Unix symlink external attribute: 0xA1FFxxxx or similar)
      const hostSystem = (versionMadeBy >> 8) & 0xFF;
      const unixAttrs = (externalFileAttributes >> 16) & 0xFFFF;
      const isSymlink =
        hostSystem === 3 && // Unix
        ((unixAttrs & 0o120000) === 0o120000); // S_IFLNK

      entries.push({
        entryName: fileName,
        isDirectory,
        uncompressedSize,
        compressedSize,
        isSymlink,
        externalFileAttributes,
      });

      // Advance past this entry
      pos += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    }

    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Find a 4-byte signature in a buffer starting from a given position */
function findSignature(buffer: Buffer, startPos: number, signature: number): number {
  for (let i = startPos; i <= buffer.length - 4; i++) {
    if (buffer.readUInt32LE(i) === signature) {
      return i;
    }
  }
  return -1;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** File extensions that are NEVER allowed in a skill archive */
const BLOCKED_EXTENSIONS = new Set([
  // Windows native executables & script host (auto-executes)
  '.exe', '.dll', '.sys', '.com', '.scr', '.pif', '.msi', '.msp',
  '.bat', '.cmd', '.vbs', '.vbe', '.jse', '.wsf', '.wsh',
  // Linux/macOS native executables & shared objects
  '.so', '.dylib', '.o', '.a',
  // Application packages & installers
  '.app', '.dmg', '.pkg', '.deb', '.rpm',
  // Compiled bytecode
  '.jar', '.class', '.war', '.ear',
  // Shortcuts / URL files (can auto-launch)
  '.lnk', '.url',
]);

/** File extensions that raise a WARNING but are not outright blocked
 *  — text scripts that need an explicit interpreter to execute */
const WARNING_EXTENSIONS = new Set([
  // Scripting languages (require interpreter, not auto-executable)
  '.js', '.py', '.rb', '.pl', '.php',
  // Python bytecode requires an interpreter and is reviewed as a warning.
  '.pyc', '.pyo',
  '.sh', '.bash', '.zsh', '.csh', '.fish',
  '.ps1', '.psm1', '.psd1',
  '.reg',
  '.hta',
]);

/** File extensions that are suspicious binary formats
 *  (not executable but could contain embedded payloads). */
const SUSPICIOUS_EXTENSIONS = new Set([
  '.elf',
]);

// ── Limits ───────────────────────────────────────────────────────────────────

const MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024;   // 50 MB
const MAX_TOTAL_EXTRACTED_SIZE = 200 * 1024 * 1024; // 200 MB
const MAX_FILE_COUNT = 500;
const MAX_NESTING_DEPTH = 10;
const MAX_COMPRESSION_RATIO = 100; // 100:1 — if compressed is 1KB, uncompressed ≤ 100KB

// ── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ValidationFinding {
  level: 'error' | 'warning';
  category: string;
  message: string;
  detail?: string;
}

export interface SkillValidationResult {
  /** Overall risk assessment */
  riskLevel: RiskLevel;
  /** Whether the skill passes all mandatory checks */
  allowed: boolean;
  /** Human-readable reason when blocked */
  blockReason?: string;
  /** Individual findings (warnings and errors) */
  findings: ValidationFinding[];
  /** Extracted skill name from SKILL.md (if available) */
  skillName?: string;
  /** Extracted skill description (if available) */
  skillDescription?: string;
  /** Summary counts */
  summary: {
    errors: number;
    warnings: number;
  };
}

// ── Interface for ZIP entry inspection ───────────────────────────────────────

/**
 * Lightweight representation of a ZIP archive entry.
 * Callers should use a ZIP-reading library (e.g. adm-zip) and pass entry data.
 */
export interface ZipEntryInfo {
  entryName: string;       // Raw entry name from ZIP (may contain ../)
  isDirectory: boolean;
  uncompressedSize: number;
  compressedSize: number;
  /** true if the entry is marked as a symlink in the ZIP central directory */
  isSymlink?: boolean;
  /** symlink target path if isSymlink is true */
  symlinkTarget?: string;
  /** external file attributes (for Unix permission detection) */
  externalFileAttributes?: number;
}

// ── Compression ratio check ──────────────────────────────────────────────────

/**
 * Check whether a ZIP entry has a suspiciously high compression ratio
 * (indicative of a ZIP bomb).
 *
 * @returns null if OK, or a warning message.
 */
export function checkCompressionRatio(entry: ZipEntryInfo): string | null {
  if (entry.uncompressedSize === 0 || entry.compressedSize === 0) return null;
  if (entry.isDirectory) return null;

  const ratio = entry.uncompressedSize / entry.compressedSize;
  if (ratio > MAX_COMPRESSION_RATIO) {
    return `High compression ratio (${ratio.toFixed(1)}:1) for "${entry.entryName}" — possible ZIP bomb`;
  }
  return null;
}

// ── Path traversal check ─────────────────────────────────────────────────────

/**
 * Check whether a ZIP entry path would escape the target extraction directory
 * (e.g. contains ".." or is an absolute path).
 *
 * @returns null if OK, or an error message.
 */
export function checkPathTraversal(entryName: string): string | null {
  // Normalize path separators to forward-slash for consistent checking
  const normalized = entryName.replace(/\\/g, '/');

  // Absolute path check
  if (normalized.startsWith('/')) {
    return `Absolute path forbidden in ZIP: "${entryName}"`;
  }

  // Windows absolute path check (e.g. C:\...)
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
    return `Absolute Windows path forbidden in ZIP: "${entryName}"`;
  }

  // Path traversal via ".."
  const segments = normalized.split('/');
  let depth = 0;
  for (const segment of segments) {
    if (segment === '..') {
      depth--;
      if (depth < 0) {
        return `Path traversal detected in ZIP entry: "${entryName}"`;
      }
    } else if (segment !== '.' && segment !== '') {
      depth++;
    }
  }

  // Also check for encoded traversal patterns
  if (/%2e%2e/i.test(entryName) || /%252e/i.test(entryName)) {
    return `Encoded path traversal detected in ZIP entry: "${entryName}"`;
  }

  return null;
}

// ── Executable & dangerous file detection ────────────────────────────────────

/**
 * Check a file extension against blocked / warning / suspicious lists.
 *
 * @returns null if file is safe, or a message describing the finding.
 */
export function checkFileExtension(entryName: string): {
  level: 'error' | 'warning';
  message: string;
} | null {
  // Get the last segment (file name)
  const segments = entryName.replace(/\\/g, '/').split('/');
  const fileName = segments[segments.length - 1];

  if (!fileName || fileName.length === 0) return null;

  const lowerName = fileName.toLowerCase();

  // Check blocked extensions
  for (const ext of BLOCKED_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      return {
        level: 'error',
        message: `Blocked executable file: "${entryName}" (extension ${ext})`,
      };
    }
  }

  // Check warning extensions
  for (const ext of WARNING_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      return {
        level: 'warning',
        message: `Potentially dangerous script file: "${entryName}" (extension ${ext})`,
      };
    }
  }

  // Check suspicious extensions
  for (const ext of SUSPICIOUS_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      return {
        level: 'warning',
        message: `Suspicious binary file: "${entryName}" (extension ${ext})`,
      };
    }
  }

  // Double-extension trick (e.g. "readme.txt.exe")
  const dotCount = (fileName.match(/\./g) || []).length;
  if (dotCount >= 2) {
    // Check if the last extension is blocked
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot >= 0) {
      const lastExt = fileName.substring(lastDot).toLowerCase();
      if (BLOCKED_EXTENSIONS.has(lastExt)) {
        return {
          level: 'error',
          message: `Double-extension executable detected: "${entryName}"`,
        };
      }
    }
  }

  return null;
}

// ── Symlink detection ────────────────────────────────────────────────────────

/**
 * Check whether a ZIP entry is a symlink and whether its target is dangerous.
 *
 * @returns null if OK, or a warning message.
 */
export function checkSymlink(entry: ZipEntryInfo): string | null {
  if (!entry.isSymlink) return null;

  // Symlinks pointing outside the skill directory are dangerous
  const target = entry.symlinkTarget || '';

  if (target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)) {
    return `Symlink "${entry.entryName}" points to absolute path: "${target}"`;
  }

  if (target.includes('..')) {
    return `Symlink "${entry.entryName}" traverses outside the skill directory: "${target}"`;
  }

  // Symlinks to sensitive system paths
  const sensitivePaths = [
    '/etc/', '/proc/', '/sys/', '/dev/',
    'C:\\Windows\\', 'C:\\Windows\\System32\\',
    '/var/log/', '/var/run/',
    '.ssh/', '.gnupg/', '.aws/', '.config/',
  ];

  const lowerTarget = target.toLowerCase();
  for (const sensitive of sensitivePaths) {
    if (lowerTarget.includes(sensitive.toLowerCase())) {
      return `Symlink "${entry.entryName}" targets a sensitive path: "${target}"`;
    }
  }

  // Otherwise warn about any symlink
  return `Symlink entry detected: "${entry.entryName}" -> "${target}"`;
}

// ── Size & count limits ──────────────────────────────────────────────────────

/**
 * Check whether a single file exceeds the size limit.
 */
export function checkSingleFileSize(entry: ZipEntryInfo): string | null {
  if (entry.isDirectory) return null;
  if (entry.uncompressedSize > MAX_SINGLE_FILE_SIZE) {
    const sizeMB = (entry.uncompressedSize / (1024 * 1024)).toFixed(1);
    return `File too large: "${entry.entryName}" is ${sizeMB} MB (max ${MAX_SINGLE_FILE_SIZE / (1024 * 1024)} MB)`;
  }
  return null;
}

// ── Nesting depth check ──────────────────────────────────────────────────────

/**
 * Check whether a ZIP entry exceeds maximum nesting depth.
 */
export function checkNestingDepth(entryName: string): string | null {
  const depth = entryName.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.').length;
  if (depth > MAX_NESTING_DEPTH) {
    return `Excessive nesting depth (${depth}) in: "${entryName}"`;
  }
  return null;
}

// ── Aggregate validation ────────────────────────────────────────────────────

/**
 * Run all P0 pre-extraction checks on a collection of ZIP entries.
 *
 * Call this BEFORE extracting the ZIP file. It performs:
 * 1. Path traversal check
 * 2. Blocked file extension check
 * 3. Compression ratio (ZIP bomb) check
 * 4. Symlink detection
 * 5. File size & count limits
 * 6. Nesting depth limit
 *
 * @param entries - List of ZIP entry metadata
 * @param zipFilePath - Path to the ZIP file (for logging)
 * @returns Structured validation result
 */
export function validateZipStructure(
  entries: ZipEntryInfo[],
  _zipFilePath?: string,
): SkillValidationResult {
  const findings: ValidationFinding[] = [];
  let totalUncompressedSize = 0;
  let hasBlockingError = false;

  for (const entry of entries) {
    // 1. Path traversal
    const traversalError = checkPathTraversal(entry.entryName);
    if (traversalError) {
      hasBlockingError = true;
      findings.push({
        level: 'error',
        category: 'path-traversal',
        message: traversalError,
      });
      continue; // Skip further checks for this entry if traversal
      // (an entry that escapes the dir is an immediate block, but we
      // still collect all findings for transparency.)
    }

    // 2. Blocked / warning file extensions
    const extCheck = checkFileExtension(entry.entryName);
    if (extCheck) {
      if (extCheck.level === 'error') {
        hasBlockingError = true;
      }
      findings.push({
        level: extCheck.level,
        category: 'file-type',
        message: extCheck.message,
      });
    }

    // 3. Compression ratio (ZIP bomb)
    const ratioError = checkCompressionRatio(entry);
    if (ratioError) {
      hasBlockingError = true;
      findings.push({
        level: 'error',
        category: 'zip-bomb',
        message: ratioError,
      });
    }

    // 4. Symlink
    const symlinkError = checkSymlink(entry);
    if (symlinkError) {
      findings.push({
        level: 'warning',
        category: 'symlink',
        message: symlinkError,
      });
    }

    // 5. Single file size
    const sizeError = checkSingleFileSize(entry);
    if (sizeError) {
      hasBlockingError = true;
      findings.push({
        level: 'error',
        category: 'file-size',
        message: sizeError,
      });
    }

    // 6. Nesting depth
    const depthError = checkNestingDepth(entry.entryName);
    if (depthError) {
      findings.push({
        level: 'warning',
        category: 'nesting-depth',
        message: depthError,
      });
    }

    // Accumulate total size
    if (!entry.isDirectory) {
      totalUncompressedSize += entry.uncompressedSize;
    }
  }

  // 7. File count limit
  const fileCount = entries.filter(e => !e.isDirectory).length;
  if (fileCount > MAX_FILE_COUNT) {
    hasBlockingError = true;
    findings.push({
      level: 'error',
      category: 'file-count',
      message: `Too many files: ${fileCount} (max ${MAX_FILE_COUNT})`,
    });
  }

  // 8. Total extracted size limit
  if (totalUncompressedSize > MAX_TOTAL_EXTRACTED_SIZE) {
    hasBlockingError = true;
    const sizeMB = (totalUncompressedSize / (1024 * 1024)).toFixed(1);
    findings.push({
      level: 'error',
      category: 'total-size',
      message: `Total extracted size ${sizeMB} MB exceeds limit of ${MAX_TOTAL_EXTRACTED_SIZE / (1024 * 1024)} MB`,
    });
  }

  // Determine risk level
  const errors = findings.filter(f => f.level === 'error');
  const warnings = findings.filter(f => f.level === 'warning');

  let riskLevel: RiskLevel;
  if (errors.length > 0) {
    riskLevel = errors.length >= 2 ? 'critical' : 'high';
  } else if (warnings.length >= 3) {
    riskLevel = 'medium';
  } else if (warnings.length > 0) {
    riskLevel = 'medium';
  } else {
    riskLevel = 'low';
  }

  const blockReason = hasBlockingError
    ? `Security check failed: ${errors.length} error(s) found. ${
        errors.slice(0, 3).map(e => e.message).join('; ')
      }`
    : undefined;

  return {
    riskLevel,
    allowed: !hasBlockingError,
    blockReason,
    findings: [...errors, ...warnings],
    summary: {
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}

// ── Post-extraction: SKILL.md content validation ─────────────────────────────

/**
 * Minimal SKILL.md frontmatter schema validation.
 * Does NOT validate YAML semantics — only checks that required fields exist.
 */
export function validateSkillManifest(
  manifestPath: string,
): { valid: boolean; name?: string; description?: string; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(manifestPath)) {
    errors.push(`SKILL.md not found at expected path: ${manifestPath}`);
    return { valid: false, errors, warnings };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    errors.push(`Cannot read SKILL.md: ${manifestPath}`);
    return { valid: false, errors, warnings };
  }

  if (raw.trim().length === 0) {
    errors.push('SKILL.md is empty');
    return { valid: false, errors, warnings };
  }

  // Check for YAML frontmatter (--- ... ---)
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    errors.push('SKILL.md is missing YAML frontmatter (must start with ---)');
    return { valid: false, errors, warnings };
  }

  const body = frontmatterMatch[1];

  // Skill 权限声明在安装阶段先做结构化校验。运行时放行仍由 Main 策略中心决定，
  // 这里的职责是阻止模糊、越权或无法解释的 manifest 进入本地技能目录。
  const permissionResult = evaluateSkillFrontmatterPermissions(body);
  for (const finding of permissionResult.findings) {
    const message = `SKILL.md ${finding.message}`;
    if (finding.level === 'error') errors.push(message);
    else warnings.push(message);
  }

  // Extract name
  const nameMatch = body.match(/^\s*name\s*:\s*(.+?)\s*$/m);
  const name = nameMatch?.[1]?.replace(/^["']|["']$/g, '').trim();

  if (!name || name.length === 0) {
    errors.push('SKILL.md frontmatter is missing required field: "name"');
  }

  // Extract description
  const descMatch = body.match(/^\s*description\s*:\s*(.+?)\s*$/m);
  const description = descMatch?.[1]?.replace(/^["']|["']$/g, '').trim();

  if (!description || description.length === 0) {
    errors.push('SKILL.md frontmatter is missing required field: "description"');
  }

  // Check for suspicious patterns in description (phishing indicators)
  if (description) {
    const lowerDesc = description.toLowerCase();
    const phishingKeywords = [
      'password', 'credential', 'login as', 'impersonat',
      'urgent', 'verify your account', 'click here',
      'free gift', 'you won', 'claim now',
    ];
    const matches = phishingKeywords.filter(kw => lowerDesc.includes(kw));
    if (matches.length >= 2) {
      errors.push(
        `SKILL.md description contains potential phishing indicators: ${matches.join(', ')}`,
      );
    }
  }

  // Check for suspicious name patterns
  if (name) {
    const lowerName = name.trim().toLowerCase();
    const reservedNames = [
      'system', 'admin', 'administrator', 'root', 'superuser',
      'official', 'verified', 'trusted',
      'openclaw', 'lyclaw', 'clawx', 'gateway',
      'skill-manager', 'skill-validator', 'security',
    ];
    for (const reserved of reservedNames) {
      if (lowerName === reserved || lowerName.includes(` ${reserved}`)) {
        errors.push(
          `Skill name "${name}" uses a reserved/impersonation keyword: "${reserved}"`,
        );
        break;
      }
    }
  }

  // Scan the entire manifest, not only the description. Skill bodies are often
  // injected into agent context, so hidden instructions after frontmatter are
  // just as dangerous as malicious metadata.
  const promptScan = evaluatePromptInjectionPolicy({
    source: 'skill',
    name: name || manifestPath,
    text: raw,
  });
  if (promptScan.decision.action === 'deny') {
    errors.push(`SKILL.md prompt-injection scan blocked: ${promptScan.decision.reasons.join('; ')}`);
  } else if (promptScan.decision.action === 'prompt') {
    warnings.push(`SKILL.md prompt-injection scan warning: ${promptScan.decision.reasons.join('; ')}`);
  }

  return {
    valid: errors.length === 0,
    name,
    description,
    errors,
    warnings,
  };
}

// ── Post-extraction: scan extracted directory ────────────────────────────────

/**
 * After extraction, walk the skill directory to check for any files that
 * match blocked or warning patterns (double-check after ZIP extraction).
 */
export function scanExtractedDirectory(
  skillDir: string,
): { findings: ValidationFinding[] } {
  const findings: ValidationFinding[] = [];

  try {
    walkDir(skillDir, skillDir, findings);
  } catch (err) {
    findings.push({
      level: 'error',
      category: 'scan-error',
      message: `Failed to scan extracted directory: ${String(err)}`,
    });
  }

  return { findings };
}

function walkDir(
  baseDir: string,
  currentDir: string,
  findings: ValidationFinding[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relativePath = fullPath.substring(baseDir.length).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      // Check for hidden directories that might be suspicious
      if (entry.name.startsWith('.') && entry.name !== '.') {
        const suspiciousDirs = ['.git', '.svn', '.hg'];
        if (!suspiciousDirs.includes(entry.name)) {
          findings.push({
            level: 'warning',
            category: 'hidden-dir',
            message: `Hidden directory detected: "${relativePath}"`,
          });
        }
      }
      walkDir(baseDir, fullPath, findings);
    } else if (entry.isFile()) {
      const fileCheck = checkFileExtension(relativePath);
      if (fileCheck) {
        findings.push({
          level: fileCheck.level,
          category: 'file-type',
          message: fileCheck.message,
        });
      }

      // Check file size
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_SINGLE_FILE_SIZE) {
          const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
          findings.push({
            level: 'error',
            category: 'file-size',
            message: `Extracted file too large: "${relativePath}" is ${sizeMB} MB`,
          });
        }
      } catch {
        // ignore stat failures
      }

      // Check for suspicious content patterns (basic)
      if (relativePath.endsWith('.md') || relativePath.endsWith('.txt')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          scanFileContent(relativePath, content, findings);
        } catch {
          // ignore read failures
        }
      }
    } else if (entry.isSymbolicLink()) {
      let target = '';
      try {
        target = fs.readlinkSync(fullPath);
      } catch {
        // ignore
      }
      findings.push({
        level: 'warning',
        category: 'symlink',
        message: `Symbolic link detected in extracted skill: "${relativePath}"${target ? ` -> "${target}"` : ''}`,
      });
    }
  }
}

/**
 * Scan text file content for dangerous patterns.
 */
function scanFileContent(
  relativePath: string,
  content: string,
  findings: ValidationFinding[],
): void {
  // Dangerous shell commands — real exploit patterns, NOT Node.js API names
  const dangerousPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\brm\s+-rf\s+\//, label: 'Recursive root deletion (rm -rf /)' },
    { pattern: /\bdd\s+if=.*of=\/dev\//, label: 'Raw device write (dd to /dev/)' },
    { pattern: /mkfs\./, label: 'Filesystem format command' },
    { pattern: /:\s*\(\)\s*\{.*\};\s*/, label: 'Shell fork bomb pattern' },
    { pattern: /curl\s+.*\|\s*(ba)?sh/, label: 'Curl-to-shell pipe (curl | sh)' },
    { pattern: /wget\s+.*-O\s*-\s*\|\s*(ba)?sh/, label: 'Wget-to-shell pipe' },
    { pattern: /\/dev\/tcp\//, label: 'Network redirection to /dev/tcp/' },
    { pattern: />\s*\/etc\/(passwd|shadow|hosts)/, label: 'Write to sensitive system file' },
    { pattern: /chmod\s+[0-7]*777/, label: 'World-writable permission (chmod 777)' },
    { pattern: /eval\s+\$/, label: 'Dynamic eval execution' },
  ];

  for (const { pattern, label } of dangerousPatterns) {
    if (pattern.test(content)) {
      findings.push({
        level: 'warning',
        category: 'dangerous-command',
        message: `Potentially dangerous command in "${relativePath}": ${label}`,
        detail: `${label} found in file content`,
      });
    }
  }
}

// ── P1: Known skill names for impersonation detection ────────────────────────

/**
 * List of official/built-in skill names to check for impersonation.
 * If an uploaded skill's name is similar to one of these (but not exact),
 * it may be an impersonation attempt.
 */
const KNOWN_SKILL_NAMES = [
  'pdf', 'docx', 'docxt', 'pptx', 'xlsx',
  'summarize', 'github', 'gh-issues', 'coding', 'coding-agent',
  'taskflow', 'skill-creator', 'find-skills', 'session-logs',
  'brave-web-search', 'self-improving-agent', 'healthcheck', 'tavily-search',
  'dws', 'lingyi-baishitong',
];

// ── P1: URL safety analysis ──────────────────────────────────────────────────

/** Known URL shortener domains (anonymous / untrusted).
 *  Platform-owned shorteners (t.co, lnkd.in, qr.ae) are excluded —
 *  they have content moderation and are used in legitimate documentation. */
const URL_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly',
  'is.gd', 'buff.ly', 'adf.ly', 'shorte.st', 'bc.vc',
  'short.link', 'cutt.ly', 'rebrand.ly', 'tiny.cc',
  'shorturl.at', 't2m.io', 'v.gd',
]);

/** Suspicious TLDs commonly used for phishing/malware */
const SUSPICIOUS_TLDS = new Set([
  'tk', 'ml', 'ga', 'cf', 'gq',  // Free TLDs (Freenom)
  'xyz', 'top', 'club', 'work', 'date', 'review',
  'country', 'stream', 'download', 'win', 'bid', 'trade',
  'webcam', 'racing', 'accountant', 'science', 'party',
]);

/** Suspicious keywords in URLs that indicate phishing.
 *  Generic words like "setup" and "installer" are excluded — they
 *  are too common in legitimate documentation URLs. */
const SUSPICIOUS_URL_KEYWORDS = [
  'login', 'signin', 'verify', 'secure', 'account',
  'update', 'confirm', 'password', 'credential', 'banking',
  'paypal', 'appleid', 'microsoft365', 'google-verify',
  'download-now', 'free-install',
];

interface UrlFinding {
  url: string;
  source: string; // which file the URL was found in
  reason: string;
}

/**
 * Extract all URLs from a text content and check them for safety.
 */
function extractAndCheckUrls(
  content: string,
  sourceFile: string,
): UrlFinding[] {
  const findings: UrlFinding[] = [];

  // Match URLs: http://, https://, ftp://, or bare www.
  const urlRegex = /(?:https?:\/\/|ftp:\/\/|www\.)(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,}(?:\/[^\s<>"')\]]*)?/gi;
  const matches = content.match(urlRegex);
  if (!matches) return findings;

  const seen = new Set<string>();

  for (const url of matches) {
    const normalized = url.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // 1. Non-HTTPS
    if (normalized.startsWith('http://')) {
      findings.push({ url, source: sourceFile, reason: 'Non-HTTPS URL (insecure)' });
    }

    // 2. Raw IP address instead of domain
    if (/\/\/(\d{1,3}\.){3}\d{1,3}(?:\/|$|:)/.test(normalized)) {
      findings.push({ url, source: sourceFile, reason: 'Raw IP address URL' });
      continue; // IP URLs are most suspicious, don't check further
    }

    // 3. URL shortener detection
    try {
      const hostname = new URL(url.startsWith('www.') ? `https://${url}` : url).hostname.toLowerCase();

      for (const shortener of URL_SHORTENERS) {
        if (hostname === shortener || hostname.endsWith(`.${shortener}`)) {
          findings.push({ url, source: sourceFile, reason: `URL shortener: ${shortener}` });
          break;
        }
      }

      // 4. Suspicious TLD
      const tld = hostname.split('.').pop() || '';
      if (SUSPICIOUS_TLDS.has(tld.toLowerCase())) {
        findings.push({ url, source: sourceFile, reason: `Suspicious TLD: .${tld}` });
      }

      // 5. Suspicious keywords in URL
      for (const kw of SUSPICIOUS_URL_KEYWORDS) {
        if (hostname.includes(kw) || normalized.includes(`/${kw}`)) {
          findings.push({ url, source: sourceFile, reason: `Suspicious keyword in URL: "${kw}"` });
          break;
        }
      }
    } catch {
      // Invalid URL, still flag it
      findings.push({ url, source: sourceFile, reason: 'Malformed URL' });
    }
  }

  return findings;
}

/**
 * Scan text file content for URLs and add findings.
 */
function scanFileUrls(
  relativePath: string,
  content: string,
  findings: ValidationFinding[],
): void {
  const urlFindings = extractAndCheckUrls(content, relativePath);
  for (const uf of urlFindings) {
    findings.push({
      level: uf.reason.includes('Non-HTTPS') ? 'warning' : 'error',
      category: 'suspicious-url',
      message: `Suspicious URL in "${uf.source}": ${uf.reason} — ${uf.url}`,
    });
  }
}

// ── P1: Levenshtein distance (for name similarity) ───────────────────────────

/**
 * Compute Levenshtein (edit) distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    // Swap rows
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }

  return prev[n];
}

/**
 * Check if an uploaded skill name is attempting to impersonate a known skill.
 *
 * Detects:
 * - Exact match with different casing/whitespace
 * - Names within Levenshtein distance ≤ 2 of a known name
 * - Names that start or end with a known name (e.g. "pdf-tools", "mypdf")
 */
function detectNameImpersonation(
  uploadedName: string,
): { impersonating: string | null; reason: string } {
  const normalized = uploadedName.trim().toLowerCase();

  for (const known of KNOWN_SKILL_NAMES) {
    const knownLower = known.toLowerCase();

    // Exact match after normalization (trailing spaces, etc.)
    if (normalized === knownLower) {
      return { impersonating: known, reason: `Name matches official skill "${known}" (case-insensitive)` };
    }

    // Very close names (Levenshtein distance check — catches typo-squatting)
    const maxDist = knownLower.length <= 3 ? 0 : knownLower.length <= 5 ? 1 : 2;
    if (levenshtein(normalized, knownLower) <= maxDist) {
      return { impersonating: known, reason: `Name is very similar to official skill "${known}" (typo-squatting)` };
    }
  }

  return { impersonating: null, reason: '' };
}

// ── P1: Homoglyph / zero-width character detection ───────────────────────────

/**
 * Unicode ranges for zero-width and invisible characters.
 */
const INVISIBLE_CHAR_RANGES: Array<{ start: number; end: number; label: string }> = [
  { start: 0x200B, end: 0x200F, label: 'zero-width space/format character' },
  { start: 0x2028, end: 0x2029, label: 'line/paragraph separator' },
  { start: 0x202A, end: 0x202E, label: 'bidi control character' },
  { start: 0x2060, end: 0x2064, label: 'word joiner / invisible character' },
  { start: 0xFEFF, end: 0xFEFF, label: 'BOM / zero-width no-break space' },
  { start: 0xFFF9, end: 0xFFFB, label: 'interlinear annotation character' },
  { start: 0x00AD, end: 0x00AD, label: 'soft hyphen' },
  { start: 0x180E, end: 0x180E, label: 'Mongolian vowel separator' },
];

/**
 * Check a string for invisible/zero-width Unicode characters that could
 * be used for homoglyph attacks or name confusion.
 */
function checkInvisibleChars(
  text: string,
  context: string,
): string | null {
  const found: Set<string> = new Set();

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    for (const range of INVISIBLE_CHAR_RANGES) {
      if (code >= range.start && code <= range.end) {
        found.add(`U+${code.toString(16).toUpperCase().padStart(4, '0')} (${range.label})`);
      }
    }
  }

  if (found.size > 0) {
    return `Invisible/special characters in ${context}: ${[...found].join(', ')}`;
  }
  return null;
}

/**
 * Check for homoglyph confusable characters — letters from other scripts
 * that look like Latin letters but aren't (e.g., Cyrillic 'а' vs Latin 'a').
 */
function checkHomoglyphChars(
  text: string,
  context: string,
): string | null {
  // Confusable ranges:
  // Cyrillic that looks like Latin: U+0430–U+044F (а-я), U+0400–U+042F (А-Я)
  // Greek that looks like Latin: U+0391–U+03C9 (some overlap)
  let confusableCount = 0;
  const examples: string[] = [];

  // Map of confusable Cyrillic/Greek chars to their Latin lookalikes
  const confusables: Record<number, string> = {
    // Cyrillic lowercase
    0x0430: 'a', 0x0435: 'e', 0x043E: 'o', 0x0440: 'p',
    0x0441: 'c', 0x0443: 'y', 0x0445: 'x', 0x0456: 'i',
    0x04BB: 'h', 0x04CF: 'a',
    // Greek
    0x0391: 'A', 0x0392: 'B', 0x0395: 'E', 0x0397: 'H',
    0x0399: 'I', 0x039A: 'K', 0x039C: 'M', 0x039D: 'N',
    0x039F: 'O', 0x03A1: 'P', 0x03A4: 'T', 0x03A5: 'Y',
    0x03A7: 'X', 0x03A9: 'W',
    0x03B1: 'a', 0x03B5: 'e', 0x03B9: 'i', 0x03BA: 'k',
    0x03BD: 'v', 0x03BF: 'o', 0x03C1: 'p', 0x03C4: 't',
    0x03C5: 'y', 0x03C7: 'x',
  };

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (confusables[code] !== undefined) {
      confusableCount++;
      if (examples.length < 3) {
        examples.push(`'${text[i]}'(U+${code.toString(16).toUpperCase()}) looks like '${confusables[code]}'`);
      }
    }
  }

  if (confusableCount > 0) {
    return `Potential homoglyph characters in ${context}: ${confusableCount} confusable char(s) found. ${examples.join('; ')}`;
  }
  return null;
}

// ── P1: Aggregate content safety scan ────────────────────────────────────────

/**
 * Run P1 content safety checks on the extracted skill directory.
 *
 * Performs:
 * 1. Skill name impersonation detection (Levenshtein + prefix/suffix match)
 * 2. URL extraction & safety analysis (non-HTTPS, IP, shorteners, suspicious TLDs)
 * 3. Homoglyph / zero-width character detection
 * 4. Enhanced phishing keyword scan in all text files
 */
export function scanContentSafety(
  skillDir: string,
  skillName?: string,
): { findings: ValidationFinding[] } {
  const findings: ValidationFinding[] = [];

  // 1. Name impersonation
  if (skillName) {
    const impersonation = detectNameImpersonation(skillName);
    if (impersonation.impersonating) {
      findings.push({
        level: 'error',
        category: 'impersonation',
        message: impersonation.reason,
      });
    }
  }

  // 2. Walk files for URL extraction + homoglyph detection
  walkDirForP1(skillDir, skillDir, findings);

  return { findings };
}

function walkDirForP1(
  baseDir: string,
  currentDir: string,
  findings: ValidationFinding[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relativePath = fullPath.substring(baseDir.length).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      // Check directory name for invisible/homoglyph chars
      const invChar = checkInvisibleChars(entry.name, `directory name "${relativePath}"`);
      if (invChar) {
        findings.push({ level: 'warning', category: 'homoglyph', message: invChar });
      }
      const hgChar = checkHomoglyphChars(entry.name, `directory name "${relativePath}"`);
      if (hgChar) {
        findings.push({ level: 'warning', category: 'homoglyph', message: hgChar });
      }
      walkDirForP1(baseDir, fullPath, findings);
    } else if (entry.isFile()) {
      // Check file name for invisible/homoglyph chars
      const invChar = checkInvisibleChars(entry.name, `file name "${relativePath}"`);
      if (invChar) {
        findings.push({ level: 'warning', category: 'homoglyph', message: invChar });
      }
      const hgChar = checkHomoglyphChars(entry.name, `file name "${relativePath}"`);
      if (hgChar) {
        findings.push({ level: 'warning', category: 'homoglyph', message: hgChar });
      }

      // Scan text files for URLs
      if (relativePath.endsWith('.md') || relativePath.endsWith('.txt') || relativePath.endsWith('.json')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          scanFileUrls(relativePath, content, findings);
        } catch {
          // ignore read failures
        }
      }
    }
  }
}

// ── Full validation pipeline ─────────────────────────────────────────────────

/**
 * Complete skill validation pipeline.
 *
 * Usage:
 *   1. Before extraction: call `validateZipStructure(entries)`
 *      → If `result.allowed === false`, reject immediately.
 *   2. After extraction to a temp dir: call `validateExtracted(tempDir)`
 *      → Combines manifest validation + directory scan.
 */
export interface ExtractedValidationResult {
  riskLevel: RiskLevel;
  allowed: boolean;
  blockReason?: string;
  findings: ValidationFinding[];
  skillName?: string;
  skillDescription?: string;
  /** 解压后的实际 Skill 根目录，可能是临时目录本身，也可能是唯一的顶层文件夹 */
  skillRootDir?: string;
  /** 安装前展示给用户的结构化权限声明 */
  permissionResult?: SkillPermissionPolicyResult;
  summary: { errors: number; warnings: number };
}

export interface ExtractedSkillRootResult {
  skillRootDir?: string;
  error?: string;
}

/**
 * 兼容两种常见 ZIP 布局：
 * 1. ZIP 根目录直接包含 SKILL.md；
 * 2. ZIP 只有一个顶层文件夹，该文件夹中包含 SKILL.md。
 *
 * 顶层结构存在歧义时直接拒绝，避免把额外文件或错误目录静默带入安装结果。
 */
export function resolveExtractedSkillRoot(extractDir: string): ExtractedSkillRootResult {
  if (fs.existsSync(join(extractDir, 'SKILL.md'))) {
    return { skillRootDir: extractDir };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extractDir, { withFileTypes: true });
  } catch {
    return { error: `Cannot read extracted Skill directory: ${extractDir}` };
  }

  if (entries.length !== 1 || !entries[0].isDirectory()) {
    return {
      error: 'SKILL.md was not found at the ZIP root or inside a single top-level directory',
    };
  }

  const nestedRoot = join(extractDir, entries[0].name);
  if (!fs.existsSync(join(nestedRoot, 'SKILL.md'))) {
    return {
      error: 'SKILL.md was not found at the ZIP root or inside the single top-level directory',
    };
  }

  return { skillRootDir: nestedRoot };
}

export function validateExtractedSkill(
  skillDir: string,
): ExtractedValidationResult {
  const resolvedRoot = resolveExtractedSkillRoot(skillDir);
  const actualSkillDir = resolvedRoot.skillRootDir ?? skillDir;
  const manifestPath = join(actualSkillDir, 'SKILL.md');
  const manifest = validateSkillManifest(manifestPath);
  const permissionResult = readSkillManifestPermissions(manifestPath);
  const scan = scanExtractedDirectory(actualSkillDir);
  const contentSafety = scanContentSafety(actualSkillDir, manifest.name);

  const allFindings: ValidationFinding[] = [];

  if (resolvedRoot.error) {
    allFindings.push({
      level: 'error',
      category: 'manifest',
      message: resolvedRoot.error,
    });
  }

  // Manifest errors
  for (const err of manifest.errors) {
    allFindings.push({
      level: 'error',
      category: 'manifest',
      message: err,
    });
  }
  for (const warning of manifest.warnings) {
    allFindings.push({
      level: 'warning',
      category: 'manifest',
      message: warning,
    });
  }

  // Scan findings (P0)
  allFindings.push(...scan.findings);

  // Content safety findings (P1)
  allFindings.push(...contentSafety.findings);

  const errors = allFindings.filter(f => f.level === 'error');
  const warnings = allFindings.filter(f => f.level === 'warning');

  let riskLevel: RiskLevel;
  if (errors.length > 0) {
    riskLevel = errors.length >= 3 ? 'critical' : 'high';
  } else if (warnings.length >= 5) {
    riskLevel = 'high';
  } else if (warnings.length >= 2) {
    riskLevel = 'medium';
  } else if (warnings.length > 0) {
    riskLevel = 'low';
  } else {
    riskLevel = 'low';
  }

  const blockReason = errors.length > 0
    ? `Content check failed: ${errors.length} error(s). ${
        errors.slice(0, 3).map(e => e.message).join('; ')
      }`
    : undefined;

  return {
    riskLevel,
    allowed: errors.length === 0 && manifest.valid,
    blockReason,
    findings: allFindings,
    skillName: manifest.name,
    skillDescription: manifest.description,
    skillRootDir: resolvedRoot.skillRootDir,
    permissionResult,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}

export function readSkillManifestPermissions(manifestPath: string): SkillPermissionPolicyResult | undefined {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    return frontmatterMatch ? evaluateSkillFrontmatterPermissions(frontmatterMatch[1]) : undefined;
  } catch {
    return undefined;
  }
}
