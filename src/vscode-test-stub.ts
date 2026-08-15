/** Minimal VS Code runtime adapter for pure configuration tests. */
export const workspace = {
  isTrusted: true,
  workspaceFolders: undefined,
  getWorkspaceFolder(): undefined {
    return undefined;
  },
  getConfiguration(): never {
    throw new Error("The VS Code configuration adapter is unavailable in pure settings tests.");
  },
};

// The pure editor-metadata test imports a module that also contains runtime adapters.
// It never calls these APIs; this export only keeps the test bundle structurally valid.
export const window = { activeTextEditor: undefined };
