import ts from 'typescript';

export const SHELL_SNAPSHOT_PATCH_MARKER = 'LYCLAW_ELECTRON_NODE_SNAPSHOT_PATCH';

const SNAPSHOT_BUNDLE_MARKERS = [
  'function captureShellSnapshot(',
  'ENV_CAPTURE_NODE_SCRIPT',
];

const VULNERABLE_COMMAND = '`${shQuote(process.execPath)} -e ${shQuote(ENV_CAPTURE_NODE_SCRIPT)}`';
const ELECTRON_SCOPED_COMMAND = '`${process.versions.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${shQuote(process.execPath)} -e ${shQuote(ENV_CAPTURE_NODE_SCRIPT)}`';
const PATCHED_COMMAND = `${ELECTRON_SCOPED_COMMAND} /* ${SHELL_SNAPSHOT_PATCH_MARKER} */`;

function findCaptureCommand(source) {
  const sourceFile = ts.createSourceFile(
    'openclaw-shell-snapshot.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) return null;

  const captureFunctions = sourceFile.statements.filter((statement) => (
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === 'captureShellSnapshot'
  ));
  if (captureFunctions.length !== 1) return null;

  const captureFunction = captureFunctions[0];
  if (!captureFunction?.body) return null;

  const declarations = captureFunction.body.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((declaration) => (
      ts.isIdentifier(declaration.name)
      && declaration.name.text === 'captureCommand'
    ));
  if (declarations.length !== 1) return null;

  const initializer = declarations[0].initializer;
  if (
    !ts.isCallExpression(initializer)
    || !ts.isPropertyAccessExpression(initializer.expression)
    || initializer.expression.name.text !== 'join'
    || !ts.isArrayLiteralExpression(initializer.expression.expression)
  ) {
    return null;
  }

  const captureCommandArray = initializer.expression.expression;
  const elements = captureCommandArray.elements;
  const matchingElements = elements.filter((element) => (
    element.getText(sourceFile).includes('ENV_CAPTURE_NODE_SCRIPT')
  ));
  if (matchingElements.length !== 1) return null;

  const element = matchingElements[0];
  const elementIndex = elements.indexOf(element);
  const segmentEnd = elements[elementIndex + 1]?.getStart(sourceFile)
    ?? captureCommandArray.end;

  return {
    command: element.getText(sourceFile),
    end: element.end,
    segment: source.slice(element.getStart(sourceFile), segmentEnd),
    start: element.getStart(sourceFile),
  };
}

export function isOpenClawShellSnapshotBundle(source) {
  return SNAPSHOT_BUNDLE_MARKERS.every((marker) => source.includes(marker));
}

export function hasOpenClawElectronShellSnapshotPatch(source) {
  if (!isOpenClawShellSnapshotBundle(source)) return false;

  const captureCommand = findCaptureCommand(source);
  if (captureCommand?.command !== ELECTRON_SCOPED_COMMAND) return false;

  return !source.includes(SHELL_SNAPSHOT_PATCH_MARKER)
    || captureCommand.segment.includes(SHELL_SNAPSHOT_PATCH_MARKER);
}

export function applyOpenClawElectronShellSnapshotPatch(source) {
  if (!isOpenClawShellSnapshotBundle(source)) {
    return { source, patched: false, verified: false };
  }

  if (hasOpenClawElectronShellSnapshotPatch(source)) {
    return { source, patched: false, verified: true };
  }

  const captureCommand = findCaptureCommand(source);
  if (captureCommand?.command !== VULNERABLE_COMMAND) {
    return { source, patched: false, verified: false };
  }

  const next = source.slice(0, captureCommand.start)
    + PATCHED_COMMAND
    + source.slice(captureCommand.end);
  return {
    source: next,
    patched: next !== source,
    verified: hasOpenClawElectronShellSnapshotPatch(next),
  };
}
