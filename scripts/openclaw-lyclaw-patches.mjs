/**
 * LYClaw-specific OpenClaw dist patches applied at postinstall/bundle time.
 * Replaces fragile pnpm patchedDependencies on hashed dist bundle names.
 */

export const LYCLAW_PATCH_MARKER = '/* lyclaw:core-patches */';

const CHAT_SEND_FIELDS_OLD = `\t\t\t\t\t\tfastModeOverride: p.fastMode,
\t\t\t\t\t\tuserTurnTranscriptRecorder: userTurnRecorder,`;

const CHAT_SEND_FIELDS_NEW = `\t\t\t\t\t\tfastModeOverride: p.fastMode,
\t\t\t\t\t\textraSystemPrompt: p.extraSystemPrompt,
\t\t\t\t\t\texecuteAsAgentId: typeof p.executeAsAgentId === "string" && p.executeAsAgentId.trim() ? p.executeAsAgentId.trim() : void 0,
\t\t\t\t\t\texecutedByAgentName: typeof p.executedByAgentName === "string" && p.executedByAgentName.trim() ? p.executedByAgentName.trim() : void 0,
\t\t\t\t\t\tskillFilter: Array.isArray(p.skillFilter) ? p.skillFilter.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean) : void 0,
\t\t\t\t\t\tuserTurnTranscriptRecorder: userTurnRecorder,`;

const DIGITAL_EMPLOYEE_HELPERS = `async function pathExistsSafe(filePath) {
\ttry {
\t\tawait fs$1.access(filePath);
\t\treturn true;
\t} catch {
\t\treturn false;
\t}
}
async function readJsonFileSafe(filePath) {
\ttry {
\t\treturn JSON.parse(await fs$1.readFile(filePath, "utf-8"));
\t} catch {
\t\treturn null;
\t}
}
async function resolveDigitalEmployeeDir(agentId) {
\tconst home = userHomeDir();
\tconst legacyDir = path.join(home, ".openclaw", "digital-employee", agentId);
\tif (await pathExistsSafe(legacyDir)) return legacyDir;
\tconst managedRoot = path.join(home, ".openclaw", "digital-employees");
\tconst directManagedDir = path.join(managedRoot, agentId);
\tif (await pathExistsSafe(directManagedDir)) return directManagedDir;
\tif (!await pathExistsSafe(managedRoot)) return null;
\ttry {
\t\tfor (const entry of await fs$1.readdir(managedRoot, { withFileTypes: true })) {
\t\t\tif (!entry.isDirectory()) continue;
\t\t\tconst installDir = path.join(managedRoot, entry.name);
\t\t\tconst record = await readJsonFileSafe(path.join(installDir, "install.json"));
\t\t\tif (record?.agentId === agentId || record?.instanceId === agentId) return installDir;
\t\t}
\t} catch {}
\treturn null;
}
function isPortableDigitalEmployeeEntryPath(value) {
\tif (typeof value !== "string" || !value.trim()) return false;
\tconst trimmed = value.trim();
\tif (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\\\/]/.test(trimmed) || trimmed.startsWith("~")) return false;
\tconst normalized = trimmed.replace(/\\\\/g, "/");
\treturn normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}
function expandDigitalEmployeeRuntimeMcpServer(entry, employeeDir) {
\tif (entry?.runtime !== "node") return { ...entry };
\tif (!isPortableDigitalEmployeeEntryPath(entry.entry)) throw new Error("Digital employee MCP runtime entry must be a package-relative path");
\tif (entry.command !== void 0) throw new Error("Digital employee MCP runtime entry must not also set command");
\tconst { runtime: _runtime, entry: entryPath, args, env, ...rest } = entry;
\tconst nodeCommand = process.env.CLAWX_NODE || process.execPath;
\treturn {
\t\t...rest,
\t\tcommand: nodeCommand,
\t\targs: [path.resolve(employeeDir, entryPath), ...(Array.isArray(args) ? args : [])],
\t\tenv: { ...env, CLAWX_NODE: nodeCommand, EMPLOYEE_DIR: employeeDir },
\t};
}
async function buildDigitalEmployeeMcpServers(employeeDir) {
\tconst manifest = await readJsonFileSafe(path.join(employeeDir, "employee.json"));
\tconst templatePath = typeof manifest?.mcp?.serverTemplate === "string" && manifest.mcp.serverTemplate.trim()
\t\t? path.join(employeeDir, manifest.mcp.serverTemplate)
\t\t: path.join(employeeDir, "mcp", "servers.json");
\tlet config = await readJsonFileSafe(templatePath);
\tif (!config && templatePath.endsWith("servers.json")) config = await readJsonFileSafe(path.join(employeeDir, "mcp", "servers.template.json"));
\tconst sourceServers = config?.servers && typeof config.servers === "object" ? config.servers : {};
\treturn Object.fromEntries(Object.entries(sourceServers).map(([name, entry]) => {
\t\tconst next = expandDigitalEmployeeRuntimeMcpServer(entry, employeeDir);
\t\tif (next.command && next.cwd === void 0 && next.workingDirectory === void 0) next.cwd = employeeDir;
\t\treturn [name, next];
\t}));
}
async function loadDigitalEmployeeWorkflows(employeeDir) {
\tconst wfDir = path.join(employeeDir, "workflows");
\tif (!await pathExistsSafe(wfDir)) return "";
\ttry {
\t\tconst files = (await fs$1.readdir(wfDir)).filter((name) => name.endsWith(".md")).sort();
\t\tconst parts = [];
\t\tfor (const fileName of files) {
\t\t\tparts.push(await fs$1.readFile(path.join(wfDir, fileName), "utf-8"));
\t\t}
\t\treturn parts.join("\\n\\n---\\n\\n");
\t} catch {
\t\treturn "";
\t}
}
async function resolveDigitalEmployeeExecutionContext(cfg, opts) {
\tconst requestedAgentId = normalizeOptionalString(opts?.executeAsAgentId);
\tif (!requestedAgentId) return null;
\tconst agentId = normalizeAgentId(requestedAgentId);
\tconst employeeDir = await resolveDigitalEmployeeDir(agentId);
\tif (!employeeDir) throw new Error(\`Digital employee "\${agentId}" is not installed\`);
\tconst employeeSkillsDir = path.join(employeeDir, "skills");
\tconst employeeCfg = {
\t\t...cfg,
\t\tmcp: { ...cfg?.mcp, servers: await buildDigitalEmployeeMcpServers(employeeDir) },
\t\tskills: {
\t\t\t...cfg?.skills,
\t\t\t__digitalEmployeeOnly: true,
\t\t\tload: { ...cfg?.skills?.load, extraDirs: [employeeSkillsDir] }
\t\t}
\t};
\tconst workflowText = await loadDigitalEmployeeWorkflows(employeeDir);
\tconst isolationPrompt = [
\t\t"Digital employee isolation:",
\t\t"- Available skills and MCP servers are limited to this digital employee package.",
\t\t"- Ignore skills, MCP servers, or tool inventories mentioned earlier in the shared conversation unless they appear in the current package-local inventory.",
\t\t"- When asked about your skills, list only the package-local skills available to this digital employee."
\t].join("\\n");
\tconst workflowPrompt = [isolationPrompt, workflowText ? \`<workflows>\\n\${workflowText}\\n</workflows>\` : ""].filter(Boolean).join("\\n\\n");
\treturn { agentId, cfg: employeeCfg, workflowPrompt };
}`;

const WORKSPACE_EMPLOYEE_ONLY_BLOCK = `\tif (opts?.config?.skills?.__digitalEmployeeOnly === true) {
\t\treturn Array.from(merged.values()).toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en")).map((record) => {
\t\tconst skill = record.skill;
\t\tconst frontmatter = record.frontmatter ?? readSkillFrontmatterSafe({
\t\t\trootDir: skill.baseDir,
\t\t\tfilePath: skill.filePath,
\t\t\tmaxBytes: limits.maxSkillFileBytes
\t\t}) ?? {};
\t\tconst invocation = resolveSkillInvocationPolicy(frontmatter);
\t\tconst entry = {
\t\t\tskill,
\t\t\tfrontmatter,
\t\t\tmetadata: resolveSkillEntryMetadata({
\t\t\t\tfrontmatter,
\t\t\t\tskillDir: skill.baseDir
\t\t\t}),
\t\t\tinvocation,
\t\t\texposure: {
\t\t\t\tincludeInRuntimeRegistry: true,
\t\t\t\tincludeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
\t\t\t\tuserInvocable: invocation.userInvocable ?? true
\t\t\t}
\t\t};
\t\tif (record.syncSourceDir !== void 0) entry.syncSourceDir = record.syncSourceDir;
\t\tif (record.syncDirName !== void 0) entry.syncDirName = record.syncDirName;
\t\treturn entry;
\t});
\t}`;

const SKILL_WORKSHOP_HELPERS = `function resolveManagedSkillsDir() {
\treturn path.resolve(resolveStateDir(), "skills");
}
function resolveSkillWorkshopTargetRoot(workspaceDir, targetPath) {
\tconst resolvedTarget = path.resolve(targetPath);
\tconst resolvedWorkspaceDir = path.resolve(workspaceDir);
\tif (resolvedTarget === resolvedWorkspaceDir || isPathInside(resolvedWorkspaceDir, resolvedTarget)) return resolvedWorkspaceDir;
\tconst managedSkillsDir = resolveManagedSkillsDir();
\tif (resolvedTarget === managedSkillsDir || isPathInside(managedSkillsDir, resolvedTarget)) return managedSkillsDir;
\tthrow new Error("Skill Workshop target must stay inside the workspace or managed skills directory.");
}
function assertInsideSkillWorkshopTarget(workspaceDir, targetPath, label) {
\ttry {
\t\tresolveSkillWorkshopTargetRoot(workspaceDir, targetPath);
\t} catch {
\t\tthrow new Error(\`\${label} must stay inside the workspace or managed skills directory.\`);
\t}
}`;

function replaceOnce(source, oldText, newText) {
  if (!source.includes(oldText)) return { source, changed: false };
  return { source: source.replace(oldText, newText), changed: true };
}

export function hasOpenClawLyclawPatches(source) {
  return source.includes(LYCLAW_PATCH_MARKER)
    || source.includes('resolveDigitalEmployeeExecutionContext');
}

export function applyOpenClawLyclawPatches(source) {
  if (!source || typeof source !== 'string') {
    return { source, patched: false };
  }

  let next = source;
  let patched = false;

  if (next.includes('const chatHandlers = {') && next.includes('fastModeOverride: p.fastMode,')) {
    const chat = replaceOnce(next, CHAT_SEND_FIELDS_OLD, CHAT_SEND_FIELDS_NEW);
    if (chat.changed) {
      next = chat.source;
      patched = true;
    } else if (!next.includes('executeAsAgentId: typeof p.executeAsAgentId')) {
      const chatRegex = next.replace(
        /(fastModeOverride: p\.fastMode,\r?\n[\t ]+)userTurnTranscriptRecorder: userTurnRecorder,/,
        `$1extraSystemPrompt: p.extraSystemPrompt,
$1executeAsAgentId: typeof p.executeAsAgentId === "string" && p.executeAsAgentId.trim() ? p.executeAsAgentId.trim() : void 0,
$1executedByAgentName: typeof p.executedByAgentName === "string" && p.executedByAgentName.trim() ? p.executedByAgentName.trim() : void 0,
$1skillFilter: Array.isArray(p.skillFilter) ? p.skillFilter.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean) : void 0,
$1userTurnTranscriptRecorder: userTurnRecorder,`,
      );
      if (chatRegex !== next) {
        next = chatRegex;
        patched = true;
      }
    }
  }

  if (next.includes('async function getReplyFromConfig(ctx, opts, configOverride)')) {
    if (!next.includes('resolveDigitalEmployeeExecutionContext')) {
      if (!next.includes('import { homedir as userHomeDir }')) {
        const osImport = replaceOnce(
          next,
          'import crypto from "node:crypto";',
          'import crypto from "node:crypto";\nimport { homedir as userHomeDir } from "node:os";',
        );
        if (osImport.changed) {
          next = osImport.source;
          patched = true;
        }
      }

      const helperAnchor = 'async function getReplyFromConfig(ctx, opts, configOverride) {';
      if (!next.includes('async function pathExistsSafe(filePath)')) {
        next = next.replace(helperAnchor, `${DIGITAL_EMPLOYEE_HELPERS}\n${helperAnchor}`);
        patched = true;
      }

      const cfgOld = `\tconst cfg = resolveGetReplyConfig({
\t\tgetRuntimeConfig,
\t\tisFastTestEnv,
\t\tconfigOverride
\t});`;
      const cfgNew = `\tlet cfg = resolveGetReplyConfig({
\t\tgetRuntimeConfig,
\t\tisFastTestEnv,
\t\tconfigOverride
\t});
\tconst digitalEmployeeExecution = await resolveDigitalEmployeeExecutionContext(cfg, opts);
\tif (digitalEmployeeExecution) cfg = digitalEmployeeExecution.cfg;`;
      const cfgPatch = replaceOnce(next, cfgOld, cfgNew);
      if (cfgPatch.changed) {
        next = cfgPatch.source;
        patched = true;
      }

      const scopeOld = `\tconst { agentSessionKey, agentId } = resolverTiming.measureSync("reply.resolve_agent_scope", () => {`;
      const scopeNew = `\tconst { agentSessionKey: sessionAgentKeyRaw, agentId: sessionAgentId } = resolverTiming.measureSync("reply.resolve_agent_scope", () => {`;
      const scopePatch = replaceOnce(next, scopeOld, scopeNew);
      if (scopePatch.changed) {
        next = scopePatch.source;
        patched = true;
      }

      const traceAnchor = `\tconst traceAttributes = resolverTiming.measureSync("reply.resolve_trace_context", () => ({`;
      if (next.includes(traceAnchor) && !next.includes('const baseOpts = digitalEmployeeExecution')) {
        const traceInsert = `\tconst agentId = digitalEmployeeExecution?.agentId ?? sessionAgentId;
\tconst agentSessionKey = sessionAgentKeyRaw;
\tconst baseOpts = digitalEmployeeExecution ? {
\t\t...opts,
\t\textraSystemPrompt: digitalEmployeeExecution.workflowPrompt || void 0
\t} : opts;
${traceAnchor}`;
        next = next.replace(traceAnchor, traceInsert);
        patched = true;
      }

      const skillFilterOld = `\tconst mergedSkillFilter = resolverTiming.measureSync("reply.resolve_skill_filter", () => mergeSkillFilters(opts?.skillFilter, resolveAgentSkillsFilter(cfg, agentId)));
\tconst resolvedOpts = mergedSkillFilter !== void 0 ? {
\t\t...opts,
\t\tskillFilter: mergedSkillFilter
\t} : opts;`;
      const skillFilterNew = `\tconst oneTurnSkillFilter = Array.isArray(baseOpts?.skillFilter) ? baseOpts.skillFilter.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean) : void 0;
\tconst mergedSkillFilter = oneTurnSkillFilter && oneTurnSkillFilter.length > 0 ? oneTurnSkillFilter : resolverTiming.measureSync("reply.resolve_skill_filter", () => mergeSkillFilters(baseOpts?.skillFilter, resolveAgentSkillsFilter(cfg, agentId)));
\tconst resolvedOpts = mergedSkillFilter !== void 0 ? {
\t\t...baseOpts,
\t\tskillFilter: mergedSkillFilter
\t} : baseOpts;`;
      const skillFilterPatch = replaceOnce(next, skillFilterOld, skillFilterNew);
      if (skillFilterPatch.changed) {
        next = skillFilterPatch.source;
        patched = true;
      }

      const sessionOld = `\tconst { sessionCtx, sessionEntry, previousSessionEntry, sessionStore, sessionKey, sessionId, isNewSession, resetTriggered, systemSent, storePath, sessionScope, groupResolution, isGroup, triggerBodyNormalized, bodyStripped } = sessionState;
\tlet { abortedLastRun } = sessionState;
\tresolverTimingSessionKey = sessionKey ?? resolverTimingSessionKey;`;
      const sessionNew = `\tconst { sessionCtx, previousSessionEntry, sessionStore, sessionKey, sessionId, isNewSession, resetTriggered, systemSent, storePath, sessionScope, groupResolution, isGroup, triggerBodyNormalized, bodyStripped } = sessionState;
\tlet { sessionEntry, abortedLastRun } = sessionState;
\tresolverTimingSessionKey = sessionKey ?? resolverTimingSessionKey;
\tif (digitalEmployeeExecution) {
\t\tif (sessionEntry?.skillsSnapshot) {
\t\t\tsessionState.sessionEntry = { ...sessionEntry, skillsSnapshot: void 0 };
\t\t\tsessionEntry = sessionState.sessionEntry;
\t\t}
\t\tif (sessionStore && sessionKey) sessionStore[sessionKey] = { ...sessionStore[sessionKey], skillsSnapshot: void 0 };
\t}`;
      const sessionPatch = replaceOnce(next, sessionOld, sessionNew);
      if (sessionPatch.changed) {
        next = sessionPatch.source;
        patched = true;
      }
    }
  }

  if (next.includes('const ChatSendParamsSchema = Type.Object({')) {
    const schemaOld = `\tsystemProvenanceReceipt: Type.Optional(Type.String()),
\tsuppressCommandInterpretation: Type.Optional(Type.Boolean()),
\tidempotencyKey: NonEmptyString
}, { additionalProperties: false });`;
    const schemaNew = `\tsystemProvenanceReceipt: Type.Optional(Type.String()),
\tsuppressCommandInterpretation: Type.Optional(Type.Boolean()),
\textraSystemPrompt: Type.Optional(Type.String()),
\texecuteAsAgentId: Type.Optional(Type.String()),
\texecutedByAgentName: Type.Optional(Type.String()),
\tidempotencyKey: NonEmptyString
}, { additionalProperties: true });`;
    const schemaPatch = replaceOnce(next, schemaOld, schemaNew);
    if (schemaPatch.changed) {
      next = schemaPatch.source;
      patched = true;
    }
  }

  if (next.includes('function loadSkillEntries(workspaceDir, opts)')) {
    const pluginOld = `\tconst pluginSkillDirs = workspaceOnly ? [] : resolvePluginSkillDirs({`;
    const pluginNew = `\tconst pluginSkillDirs = (workspaceOnly || opts?.config?.skills?.__digitalEmployeeOnly) ? [] : resolvePluginSkillDirs({`;
    const pluginPatch = replaceOnce(next, pluginOld, pluginNew);
    if (pluginPatch.changed) {
      next = pluginPatch.source;
      patched = true;
    }

    const mergeAnchor = `\tfor (const record of extraSkills) merged.set(record.skill.name, record);
\tfor (const record of bundledSkills) merged.set(record.skill.name, record);`;
    const mergeReplacement = `\tfor (const record of extraSkills) merged.set(record.skill.name, record);
${WORKSPACE_EMPLOYEE_ONLY_BLOCK}
\tfor (const record of bundledSkills) merged.set(record.skill.name, record);`;
    if (!next.includes('__digitalEmployeeOnly === true')) {
      const workspacePatch = replaceOnce(next, mergeAnchor, mergeReplacement);
      if (workspacePatch.changed) {
        next = workspacePatch.source;
        patched = true;
      }
    }
  }

  if (next.includes('function resolveContextWindowInfo(params)')) {
    const ctxOld = `\t\treturn normalizePositiveInt(match?.contextTokens) ?? normalizePositiveInt(match?.contextWindow);
\t})();
\tconst fromModel = normalizePositiveInt(params.modelContextTokens) ?? normalizePositiveInt(params.modelContextWindow);`;
    const ctxNew = `\t\tconst fromConfigTokens = normalizePositiveInt(match?.contextTokens);
\t\tconst fromConfigWindow = normalizePositiveInt(match?.contextWindow);
\t\tif (fromConfigTokens !== void 0 && fromConfigWindow !== void 0) return Math.max(fromConfigTokens, fromConfigWindow);
\t\treturn fromConfigTokens ?? fromConfigWindow;
\t})();
\tconst fromModelTokens = normalizePositiveInt(params.modelContextTokens);
\tconst fromModelWindow = normalizePositiveInt(params.modelContextWindow);
\tconst fromModel = fromModelTokens !== void 0 && fromModelWindow !== void 0 ? Math.max(fromModelTokens, fromModelWindow) : fromModelTokens ?? fromModelWindow;`;
    const ctxPatch = replaceOnce(next, ctxOld, ctxNew);
    if (ctxPatch.changed) {
      next = ctxPatch.source;
      patched = true;
    }
  }

  if (next.includes('function resolveEffectiveRuntimeModel(params)')) {
    const embeddedOld = `\tconst effectiveModel = ctxInfo.tokens < (params.runtimeModel.contextWindow ?? Infinity) ? {
\t\t...params.runtimeModel,
\t\tcontextWindow: ctxInfo.tokens
\t} : params.runtimeModel;`;
    const embeddedNew = `\tconst effectiveModel = {
\t\t...params.runtimeModel,
\t\t...(ctxInfo.tokens < (params.runtimeModel.contextWindow ?? Infinity) ? { contextWindow: ctxInfo.tokens } : {}),
\t\tcontextTokens: ctxInfo.tokens
\t};`;
    const embeddedPatch = replaceOnce(next, embeddedOld, embeddedNew);
    if (embeddedPatch.changed) {
      next = embeddedPatch.source;
      patched = true;
    }
  }

  if (next.includes('function readAgentModelContextTokens(model)')) {
    const modelCtxOld = `\tconst value = model?.contextTokens;
\treturn typeof value === "number" && Number.isFinite(value) ? value : void 0;`;
    const modelCtxNew = `\tconst contextTokens = model?.contextTokens;
\tconst contextWindow = model?.contextWindow;
\tconst normalizedTokens = typeof contextTokens === "number" && Number.isFinite(contextTokens) ? contextTokens : void 0;
\tconst normalizedWindow = typeof contextWindow === "number" && Number.isFinite(contextWindow) ? contextWindow : void 0;
\tif (normalizedTokens !== void 0 && normalizedWindow !== void 0) return Math.max(normalizedTokens, normalizedWindow);
\treturn normalizedTokens ?? normalizedWindow;`;
    const modelCtxPatch = replaceOnce(next, modelCtxOld, modelCtxNew);
    if (modelCtxPatch.changed) {
      next = modelCtxPatch.source;
      patched = true;
    }
  }

  if (next.includes('function resolveOpenAICompletionsEffectiveContextTokens(model)')) {
    const transportCtxOld = `\tconst contextTokens = model.contextTokens;
\tif (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0) return contextTokens;
\treturn typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : void 0;`;
    const transportCtxNew = `\tconst contextTokens = typeof model.contextTokens === "number" && Number.isFinite(model.contextTokens) && model.contextTokens > 0 ? model.contextTokens : void 0;
\tconst contextWindow = typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : void 0;
\tif (contextTokens !== void 0 && contextWindow !== void 0) return Math.max(contextTokens, contextWindow);
\treturn contextTokens ?? contextWindow;`;
    const transportCtxPatch = replaceOnce(next, transportCtxOld, transportCtxNew);
    if (transportCtxPatch.changed) {
      next = transportCtxPatch.source;
      patched = true;
    }
  }

  if (next.includes('function resolveSkillProposalTarget(params)')) {
    if (!next.includes('resolveManagedSkillsDir()')) {
      const workshopAnchor = 'function assertInsideWorkspace(workspaceDir, targetPath, label) {';
      if (next.includes(workshopAnchor)) {
        next = next.replace(workshopAnchor, `${SKILL_WORKSHOP_HELPERS}\n${workshopAnchor}`);
        patched = true;
      }
    }

    const replacements = [
      [
        `\tconst skillDir = path.resolve(params.workspaceDir, "skills", skillKey);
\tconst skillFile = path.join(skillDir, "SKILL.md");
\tassertInsideWorkspace(params.workspaceDir, skillDir, "skill directory");
\tassertInsideWorkspace(params.workspaceDir, skillFile, "skill file");`,
        `\tconst skillDir = path.resolve(resolveManagedSkillsDir(), skillKey);
\tconst skillFile = path.join(skillDir, "SKILL.md");
\tassertInsideSkillWorkshopTarget(params.workspaceDir, skillDir, "skill directory");
\tassertInsideSkillWorkshopTarget(params.workspaceDir, skillFile, "skill file");`,
      ],
      [
        `\tassertInsideWorkspace(params.workspaceDir, params.filePath, "skill file");
\tconst relativePath = path.relative(path.resolve(params.workspaceDir), path.resolve(params.filePath));
\tawait (await root(params.workspaceDir)).write(relativePath, params.content, {`,
        `\tconst targetRoot = resolveSkillWorkshopTargetRoot(params.workspaceDir, params.filePath);
\tconst relativePath = path.relative(targetRoot, path.resolve(params.filePath));
\tawait (await root(targetRoot)).write(relativePath, params.content, {`,
      ],
      [
        'const WRITABLE_WORKSPACE_SOURCES = new Set(["openclaw-workspace", "agents-skills-project"]);',
        'const WRITABLE_WORKSPACE_SOURCES = new Set(["openclaw-managed"]);',
      ],
      [
        'source: "openclaw-workspace"',
        'source: "openclaw-managed"',
      ],
    ];

    for (const [oldText, newText] of replacements) {
      const result = replaceOnce(next, oldText, newText);
      if (result.changed) {
        next = result.source;
        patched = true;
      }
    }

    next = next.replaceAll(
      'assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");',
      'assertInsideSkillWorkshopTarget(input.workspaceDir, record.target.skillFile, "skill file");',
    );
    next = next.replaceAll(
      'assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");',
      'assertInsideSkillWorkshopTarget(input.workspaceDir, record.target.skillDir, "skill directory");',
    );
    next = next.replaceAll(
      'assertInsideWorkspace(workspaceDir, record.target.skillFile, "skill file");',
      'assertInsideSkillWorkshopTarget(workspaceDir, record.target.skillFile, "skill file");',
    );
    next = next.replaceAll(
      'assertInsideWorkspace(workspaceDir, record.target.skillDir, "skill directory");',
      'assertInsideSkillWorkshopTarget(workspaceDir, record.target.skillDir, "skill directory");',
    );
    next = next.replaceAll(
      'assertInsideWorkspace(workspaceDir, skill.filePath, "skill file");',
      'assertInsideSkillWorkshopTarget(workspaceDir, skill.filePath, "skill file");',
    );
    next = next.replaceAll(
      'assertInsideWorkspace(workspaceDir, skill.baseDir, "skill directory");',
      'assertInsideSkillWorkshopTarget(workspaceDir, skill.baseDir, "skill directory");',
    );
  }

  if (next.includes('function createSkillWorkshopTool(options)')) {
    const workshopApplyOld = 'contentText: `Applied skill proposal ${applied.record.id}.`,';
    const workshopApplyNew = 'contentText: `Applied skill proposal ${applied.record.id} to ${applied.targetSkillFile}.`,';
    const workshopApplyPatch = replaceOnce(next, workshopApplyOld, workshopApplyNew);
    if (workshopApplyPatch.changed) {
      next = workshopApplyPatch.source;
      patched = true;
    }
  }

  if (patched && !next.includes(LYCLAW_PATCH_MARKER)) {
    next = `${LYCLAW_PATCH_MARKER}\n${next}`;
  }

  return { source: next, patched };
}
