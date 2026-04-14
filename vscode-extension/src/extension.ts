import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";

const BRIDGE_ROOT = path.join(os.homedir(), ".pi", "bridge");
const SYNC_DEBOUNCE_MS = 75;

type SelectionSnapshot = {
  workspaceRoot: string;
  filePath: string;
  relativePath: string;
  languageId: string;
  startLine: number;
  endLine: number;
  startCharacter: number;
  endCharacter: number;
  selectedLineCount: number;
  selectedText: string;
  capturedAt: number;
};

function workspaceHash(workspaceRoot: string): string {
  return crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function getBridgeFilePath(workspaceRoot: string): string {
  return path.join(BRIDGE_ROOT, workspaceHash(workspaceRoot), "selection.json");
}

async function writeJsonAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

async function deleteIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

function getWorkspaceRoot(editor: vscode.TextEditor): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  return folder?.uri.fsPath;
}

function buildSnapshot(editor: vscode.TextEditor): SelectionSnapshot | undefined {
  const workspaceRoot = getWorkspaceRoot(editor);
  if (!workspaceRoot) return undefined;

  const selection = editor.selection;
  if (selection.isEmpty) return undefined;

  const selectedText = editor.document.getText(selection);
  if (!selectedText.trim()) return undefined;

  return {
    workspaceRoot,
    filePath: editor.document.uri.fsPath,
    relativePath: path.relative(workspaceRoot, editor.document.uri.fsPath),
    languageId: editor.document.languageId,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    startCharacter: selection.start.character,
    endCharacter: selection.end.character,
    selectedLineCount: selection.end.line - selection.start.line + 1,
    selectedText,
    capturedAt: Date.now(),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Pi Selection Bridge");
  let lastBridgeFilePath: string | undefined;
  let lastSerializedSnapshot: string | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  let syncInFlight = false;
  let needsAnotherSync = false;

  const syncSelection = async (): Promise<void> => {
    if (syncInFlight) {
      needsAnotherSync = true;
      return;
    }

    syncInFlight = true;
    try {
      const editor = vscode.window.activeTextEditor;
      const snapshot = editor ? buildSnapshot(editor) : undefined;

      if (!snapshot) {
        if (lastBridgeFilePath) {
          await deleteIfExists(lastBridgeFilePath);
          output.appendLine(`Removed ${lastBridgeFilePath}`);
        }
        lastBridgeFilePath = undefined;
        lastSerializedSnapshot = undefined;
        return;
      }

      const bridgeFilePath = getBridgeFilePath(snapshot.workspaceRoot);
      const serializedSnapshot = `${JSON.stringify(snapshot, null, 2)}\n`;

      if (lastBridgeFilePath && lastBridgeFilePath !== bridgeFilePath) {
        await deleteIfExists(lastBridgeFilePath);
        output.appendLine(`Removed stale bridge file ${lastBridgeFilePath}`);
      }

      if (lastBridgeFilePath === bridgeFilePath && lastSerializedSnapshot === serializedSnapshot) {
        return;
      }

      await writeJsonAtomically(bridgeFilePath, serializedSnapshot);
      lastBridgeFilePath = bridgeFilePath;
      lastSerializedSnapshot = serializedSnapshot;
      output.appendLine(`Synced ${snapshot.selectedLineCount} line(s) from ${snapshot.relativePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      output.appendLine(`Sync error: ${message}`);
    } finally {
      syncInFlight = false;
      if (needsAnotherSync) {
        needsAnotherSync = false;
        void syncSelection();
      }
    }
  };

  const scheduleSync = (): void => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void syncSelection();
    }, SYNC_DEBOUNCE_MS);
  };

  context.subscriptions.push(
    output,
    vscode.window.onDidChangeTextEditorSelection(() => scheduleSync()),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleSync()),
    vscode.workspace.onDidCloseTextDocument(() => scheduleSync()),
    vscode.commands.registerCommand("piSelectionBridge.syncNow", async () => {
      await syncSelection();
      void vscode.window.showInformationMessage("Pi Selection Bridge synced current selection.");
    }),
    vscode.commands.registerCommand("piSelectionBridge.openBridgeFolder", async () => {
      const uri = vscode.Uri.file(BRIDGE_ROOT);
      await vscode.commands.executeCommand("revealFileInOS", uri);
    }),
    {
      dispose: () => {
        if (syncTimer) clearTimeout(syncTimer);
      },
    },
  );

  output.appendLine(`Bridge root: ${BRIDGE_ROOT}`);
  scheduleSync();
}

export function deactivate(): void {
  // no-op
}
