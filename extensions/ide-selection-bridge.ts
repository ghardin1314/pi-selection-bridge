import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const EXTENSION_ID = "ide-selection-bridge";
const BRIDGE_ROOT = path.join(os.homedir(), ".pi", "bridge");
const POLL_INTERVAL_MS = 300;
const STALE_MS = 15 * 60 * 1000;
const MAX_INJECT_LINES = 200;
const MAX_INJECT_BYTES = 20 * 1024;
const DEFAULT_VSIX_NAME = "pi-selection-bridge.vsix";
const PACKAGE_ROOT = typeof __dirname === "string" ? path.resolve(__dirname, "..") : process.cwd();

type SelectionSnapshot = {
  workspaceRoot: string;
  filePath: string;
  relativePath?: string;
  languageId?: string;
  startLine?: number;
  endLine?: number;
  startCharacter?: number;
  endCharacter?: number;
  selectedLineCount?: number;
  selectedText: string;
  capturedAt: number;
};

type BridgeMatch = {
  bridgeFilePath: string;
  snapshot: SelectionSnapshot;
  score: number;
};

type EditorKind = "cursor" | "vscode";

type DoctorResult = {
  bundledVsixPath: string | null;
  cursorCliPath: string | null;
  vscodeCliPath: string | null;
  bridgeDirExists: boolean;
  match: BridgeMatch | null;
};

function normalizePath(value: string): string {
  return path.resolve(value);
}

function isPathEqualOrInside(targetPath: string, parentPath: string): boolean {
  const target = normalizePath(targetPath);
  const parent = normalizePath(parentPath);
  return target === parent || target.startsWith(`${parent}${path.sep}`);
}

function getMatchScore(cwd: string, workspaceRoot: string): number {
  const normalizedCwd = normalizePath(cwd);
  const normalizedWorkspaceRoot = normalizePath(workspaceRoot);

  if (normalizedCwd === normalizedWorkspaceRoot) {
    return 3_000_000 + normalizedWorkspaceRoot.length;
  }

  if (isPathEqualOrInside(normalizedCwd, normalizedWorkspaceRoot)) {
    return 2_000_000 + normalizedWorkspaceRoot.length;
  }

  if (isPathEqualOrInside(normalizedWorkspaceRoot, normalizedCwd)) {
    return 1_000_000 + normalizedWorkspaceRoot.length;
  }

  return -1;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function isValidSnapshot(value: unknown): value is SelectionSnapshot {
  if (!value || typeof value !== "object") return false;

  const snapshot = value as Partial<SelectionSnapshot>;
  return (
    typeof snapshot.workspaceRoot === "string" &&
    typeof snapshot.filePath === "string" &&
    typeof snapshot.selectedText === "string" &&
    snapshot.selectedText.trim().length > 0 &&
    typeof snapshot.capturedAt === "number"
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readSnapshot(filePath: string): Promise<SelectionSnapshot | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isValidSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function deleteIfExists(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // ignore
  }
}

function isStale(snapshot: SelectionSnapshot): boolean {
  return Date.now() - snapshot.capturedAt > STALE_MS;
}

async function findBestBridgeMatch(cwd: string): Promise<BridgeMatch | null> {
  let bridgeDirs: string[] = [];

  try {
    const entries = await fs.readdir(BRIDGE_ROOT, { withFileTypes: true });
    bridgeDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(BRIDGE_ROOT, entry.name));
  } catch {
    return null;
  }

  let bestMatch: BridgeMatch | null = null;

  for (const bridgeDir of bridgeDirs) {
    const bridgeFilePath = path.join(bridgeDir, "selection.json");
    const snapshot = await readSnapshot(bridgeFilePath);
    if (!snapshot) continue;

    if (isStale(snapshot)) {
      await deleteIfExists(bridgeFilePath);
      continue;
    }

    const score = getMatchScore(cwd, snapshot.workspaceRoot);
    if (score < 0) continue;

    if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && snapshot.capturedAt > bestMatch.snapshot.capturedAt)) {
      bestMatch = { bridgeFilePath, snapshot, score };
    }
  }

  return bestMatch;
}

function inferFence(snapshot: SelectionSnapshot): string {
  const ext = path.extname(snapshot.relativePath ?? snapshot.filePath).replace(/^\./, "");
  if (ext) return ext;

  switch (snapshot.languageId) {
    case "typescriptreact":
      return "tsx";
    case "javascriptreact":
      return "jsx";
    case "typescript":
      return "ts";
    case "javascript":
      return "js";
    case "shellscript":
      return "sh";
    default:
      return snapshot.languageId ?? "";
  }
}

function truncateSelection(text: string): { text: string; truncated: boolean; originalLines: number; originalBytes: number } {
  const originalLines = countLines(text);
  const originalBytes = Buffer.byteLength(text, "utf8");
  let lines = text.split(/\r?\n/);
  let truncated = false;

  if (lines.length > MAX_INJECT_LINES) {
    lines = lines.slice(0, MAX_INJECT_LINES);
    truncated = true;
  }

  let truncatedText = lines.join("\n");
  while (Buffer.byteLength(truncatedText, "utf8") > MAX_INJECT_BYTES && truncatedText.length > 0) {
    truncated = true;
    truncatedText = truncatedText.slice(0, Math.max(1, truncatedText.length - 128));
  }

  return { text: truncatedText, truncated, originalLines, originalBytes };
}

function formatInjectedMessage(snapshot: SelectionSnapshot): string {
  const fileLabel = snapshot.relativePath ?? snapshot.filePath;
  const lineLabel =
    typeof snapshot.startLine === "number" && typeof snapshot.endLine === "number"
      ? `${snapshot.startLine}-${snapshot.endLine}`
      : "unknown";
  const languageLabel = snapshot.languageId ?? "unknown";
  const fence = inferFence(snapshot);
  const truncated = truncateSelection(snapshot.selectedText);
  const parts = [
    "IDE selection context for this prompt:",
    "",
    `File: ${fileLabel}`,
    `Lines: ${lineLabel}`,
    `Language: ${languageLabel}`,
    "",
    `\`\`\`${fence}`,
    truncated.text,
    "```",
  ];

  if (truncated.truncated) {
    parts.push(
      "",
      `Note: selection truncated from ${truncated.originalLines} lines and ${truncated.originalBytes} bytes to fit prompt limits.`,
    );
  }

  return parts.join("\n");
}

function formatStatus(snapshot: SelectionSnapshot, ctx: ExtensionContext): string {
  const lineCount = snapshot.selectedLineCount ?? countLines(snapshot.selectedText);
  const fileName = path.basename(snapshot.filePath);
  const noun = lineCount === 1 ? "line" : "lines";
  return ctx.ui.theme.fg("accent", `${lineCount} ${noun} selected`) + ctx.ui.theme.fg("dim", ` · ${fileName}`);
}

function formatAge(timestamp: number): string {
  const ms = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

async function pathExistsAsDir(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function findBundledVsixPath(cwd: string): Promise<string | null> {
  const candidates = [
    path.join(PACKAGE_ROOT, "assets", DEFAULT_VSIX_NAME),
    path.join(PACKAGE_ROOT, DEFAULT_VSIX_NAME),
    path.join(cwd, "assets", DEFAULT_VSIX_NAME),
    path.join(cwd, DEFAULT_VSIX_NAME),
    path.join(cwd, "vscode-extension", DEFAULT_VSIX_NAME),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function findCommandOnPath(pi: ExtensionAPI, commandName: string): Promise<string | null> {
  try {
    const result =
      process.platform === "win32"
        ? await pi.exec("where", [commandName], { timeout: 10_000 })
        : await pi.exec("sh", ["-lc", `command -v ${commandName} 2>/dev/null || true`], { timeout: 10_000 });

    if (result.code !== 0 && !result.stdout.trim()) return null;
    const found = result.stdout.trim().split(/\r?\n/).find(Boolean);
    return found ? found.trim() : null;
  } catch {
    return null;
  }
}

async function findEditorCli(pi: ExtensionAPI, editor: EditorKind): Promise<string | null> {
  const commandName = editor === "cursor" ? "cursor" : "code";
  const onPath = await findCommandOnPath(pi, commandName);
  if (onPath) return onPath;

  const candidates =
    editor === "cursor"
      ? [
          "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
          "/Applications/Cursor Nightly.app/Contents/Resources/app/bin/cursor",
        ]
      : [
          "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
          "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
        ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  return null;
}

function getInstallCommandHelp(editor: EditorKind): string {
  return `/selection-bridge install ${editor}`;
}

async function collectDoctorResult(pi: ExtensionAPI, ctx: ExtensionContext): Promise<DoctorResult> {
  const [bundledVsixPath, cursorCliPath, vscodeCliPath, match, bridgeDirExists] = await Promise.all([
    findBundledVsixPath(ctx.cwd),
    findEditorCli(pi, "cursor"),
    findEditorCli(pi, "vscode"),
    findBestBridgeMatch(ctx.cwd),
    pathExistsAsDir(BRIDGE_ROOT),
  ]);

  return {
    bundledVsixPath,
    cursorCliPath,
    vscodeCliPath,
    bridgeDirExists,
    match,
  };
}

function doctorReport(result: DoctorResult, cwd: string): string {
  const lines = [
    "Pi Selection Bridge doctor",
    "",
    `Package root: ${PACKAGE_ROOT}`,
    `Current cwd: ${cwd}`,
    `Bridge root: ${BRIDGE_ROOT}`,
    `Bridge dir exists: ${result.bridgeDirExists ? "yes" : "no"}`,
    `Bundled VSIX: ${result.bundledVsixPath ?? "missing"}`,
    `Cursor CLI: ${result.cursorCliPath ?? "not found"}`,
    `VS Code CLI: ${result.vscodeCliPath ?? "not found"}`,
  ];

  if (result.match) {
    const snapshot = result.match.snapshot;
    lines.push(
      "",
      "Matching selection:",
      `- file: ${snapshot.relativePath ?? snapshot.filePath}`,
      `- lines: ${snapshot.startLine ?? "?"}-${snapshot.endLine ?? "?"}`,
      `- age: ${formatAge(snapshot.capturedAt)}`,
      `- bridge file: ${result.match.bridgeFilePath}`,
    );
  } else {
    lines.push("", "Matching selection: none");
  }

  lines.push(
    "",
    "Install commands:",
    `- Cursor: ${getInstallCommandHelp("cursor")}`,
    `- VS Code: ${getInstallCommandHelp("vscode")}`,
  );

  return lines.join("\n");
}

function selectionStatusReport(match: BridgeMatch | null): string {
  if (!match) {
    return [
      "Pi Selection Bridge status",
      "",
      "No matching selection is currently available for this working directory.",
    ].join("\n");
  }

  const snapshot = match.snapshot;
  return [
    "Pi Selection Bridge status",
    "",
    `File: ${snapshot.relativePath ?? snapshot.filePath}`,
    `Lines: ${snapshot.startLine ?? "?"}-${snapshot.endLine ?? "?"}`,
    `Language: ${snapshot.languageId ?? "unknown"}`,
    `Selected lines: ${snapshot.selectedLineCount ?? countLines(snapshot.selectedText)}`,
    `Captured: ${formatAge(snapshot.capturedAt)}`,
    `Bridge file: ${match.bridgeFilePath}`,
  ].join("\n");
}

async function installBundledVsix(pi: ExtensionAPI, ctx: ExtensionContext, editor: EditorKind): Promise<void> {
  const vsixPath = await findBundledVsixPath(ctx.cwd);
  if (!vsixPath) {
    ctx.ui.notify("Bundled VSIX not found in this Pi package.", "error");
    return;
  }

  const cliPath = await findEditorCli(pi, editor);
  if (!cliPath) {
    ctx.ui.notify(`${editor === "cursor" ? "Cursor" : "VS Code"} CLI not found.`, "error");
    return;
  }

  const result = await pi.exec(cliPath, ["--install-extension", vsixPath, "--force"], { timeout: 120_000 });
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");

  if (result.code !== 0) {
    pi.sendMessage({
      customType: "selection-bridge-command",
      content: [
        `Failed to install bundled VSIX into ${editor === "cursor" ? "Cursor" : "VS Code"}.`,
        "",
        `CLI: ${cliPath}`,
        `VSIX: ${vsixPath}`,
        output ? `\nOutput:\n${output}` : "",
      ].join("\n"),
      display: true,
    });
    return;
  }

  pi.sendMessage({
    customType: "selection-bridge-command",
    content: [
      `Installed bundled VSIX into ${editor === "cursor" ? "Cursor" : "VS Code"}.`,
      "",
      `CLI: ${cliPath}`,
      `VSIX: ${vsixPath}`,
      "Next steps:",
      `1. Reload ${editor === "cursor" ? "Cursor" : "VS Code"} window`,
      "2. Select code in the editor",
      "3. Return to Pi and send your next prompt",
      output ? `\nCLI output:\n${output}` : "",
    ].join("\n"),
    display: true,
  });
}

export default function ideSelectionBridge(pi: ExtensionAPI) {
  let intervalHandle: NodeJS.Timeout | undefined;
  let pollInFlight = false;
  let activeBridgeFilePath: string | null = null;
  let activeSnapshotKey: string | null = null;

  const clearStatus = (ctx: ExtensionContext): void => {
    activeBridgeFilePath = null;
    activeSnapshotKey = null;
    ctx.ui.setStatus(EXTENSION_ID, undefined);
  };

  const updateStatus = async (ctx: ExtensionContext): Promise<void> => {
    if (pollInFlight) return;
    pollInFlight = true;

    try {
      const match = await findBestBridgeMatch(ctx.cwd);
      if (!match) {
        clearStatus(ctx);
        return;
      }

      const snapshotKey = `${match.bridgeFilePath}:${match.snapshot.capturedAt}:${match.snapshot.filePath}:${match.snapshot.startLine}:${match.snapshot.endLine}`;
      if (activeBridgeFilePath === match.bridgeFilePath && activeSnapshotKey === snapshotKey) {
        return;
      }

      activeBridgeFilePath = match.bridgeFilePath;
      activeSnapshotKey = snapshotKey;
      ctx.ui.setStatus(EXTENSION_ID, formatStatus(match.snapshot, ctx));
    } finally {
      pollInFlight = false;
    }
  };

  const stopPolling = (ctx: ExtensionContext): void => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
    clearStatus(ctx);
  };

  pi.registerCommand("selection-bridge", {
    description: "Manage the IDE selection bridge (install/status/doctor)",
    handler: async (rawArgs, ctx) => {
      const args = (rawArgs ?? "").trim();
      const [subcommand = "status", target = ""] = args.split(/\s+/).filter(Boolean);

      switch (subcommand) {
        case "install": {
          const editor = target === "vscode" || target === "code" ? "vscode" : "cursor";
          await installBundledVsix(pi, ctx, editor);
          return;
        }
        case "doctor": {
          const result = await collectDoctorResult(pi, ctx);
          pi.sendMessage({
            customType: "selection-bridge-command",
            content: doctorReport(result, ctx.cwd),
            display: true,
          });
          return;
        }
        case "status": {
          const match = await findBestBridgeMatch(ctx.cwd);
          pi.sendMessage({
            customType: "selection-bridge-command",
            content: selectionStatusReport(match),
            display: true,
          });
          return;
        }
        case "help":
        default: {
          pi.sendMessage({
            customType: "selection-bridge-command",
            content: [
              "Pi Selection Bridge commands",
              "",
              "/selection-bridge status",
              "/selection-bridge doctor",
              "/selection-bridge install cursor",
              "/selection-bridge install vscode",
            ].join("\n"),
            display: true,
          });
        }
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    stopPolling(ctx);
    await updateStatus(ctx);
    intervalHandle = setInterval(() => {
      void updateStatus(ctx);
    }, POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPolling(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const match = await findBestBridgeMatch(ctx.cwd);
    if (!match) {
      clearStatus(ctx);
      return;
    }

    await deleteIfExists(match.bridgeFilePath);
    clearStatus(ctx);

    return {
      message: {
        customType: "ide-selection-context",
        content: formatInjectedMessage(match.snapshot),
        display: false,
      },
    };
  });
}
