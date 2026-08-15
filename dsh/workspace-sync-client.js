/** Selects the DSH session whose cwd matches the active VS Code workspace. */
window.__ModuleLoader__.load({
  id: "integration:vscode-workspace-sync",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const MODULE_ID = "integration:vscode-workspace-sync";
    const MESSAGE_SOURCE = "dsh-vscode-workspace-sync";
    const POLL_INTERVAL_MS = 1_000;
    const ERROR_RETRY_MS = 5_000;

    function stateEndpoint() {
      const entries = globalThis.__DSH_BOOT__?.entries;
      const entry = Array.isArray(entries) ? entries.find((candidate) => candidate?.id === MODULE_ID) : undefined;
      if (typeof entry?.url !== "string") throw new Error("workspace sync boot entry is missing");
      const clientUrl = new URL(entry.url, globalThis.location.href);
      return clientUrl.pathname.replace(/\/client\.js$/, "/state.json");
    }

    function canonicalPath(value) {
      if (typeof value !== "string" || value === "") return "";
      const backslash = String.fromCharCode(92);
      const windowsPath = /^[A-Za-z]:[\\/]/.test(value) || value.includes(backslash);
      const separator = windowsPath ? backslash : "/";
      let normalized = windowsPath ? value.replaceAll("/", backslash) : value;
      while (normalized.length > 1 && normalized.endsWith(separator) && !/^[A-Za-z]:\\$/.test(normalized)) {
        normalized = normalized.slice(0, -1);
      }
      return windowsPath ? normalized.toLowerCase() : normalized;
    }

    function postStatus(state, workspaceRoot, error) {
      if (globalThis.parent === globalThis) return;
      globalThis.parent.postMessage({
        source: MESSAGE_SOURCE,
        version: 1,
        state,
        ...(typeof workspaceRoot === "string" ? { workspaceRoot } : {}),
        ...(typeof error === "string" ? { error: error.slice(0, 500) } : {}),
      }, "*");
    }

    async function readDesiredWorkspace() {
      const response = await fetch(stateEndpoint(), { cache: "no-store", credentials: "same-origin" });
      if (response.status === 204) return undefined;
      if (!response.ok) throw new Error(`workspace bridge returned HTTP ${String(response.status)}`);
      const value = await response.json();
      if (value?.version !== 1 || typeof value.workspaceRoot !== "string" || value.workspaceRoot === "") {
        throw new Error("workspace bridge returned invalid state");
      }
      if (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return undefined;
      return value.workspaceRoot;
    }

    function currentWorkspaceMatches(sessions, workspaceRoot) {
      const snapshot = sessions.list.getSnapshot();
      if (snapshot.phase !== "ready") return undefined;
      const current = snapshot.current === undefined ? undefined : snapshot.byId[snapshot.current];
      return current !== undefined && canonicalPath(current.cwd) === canonicalPath(workspaceRoot);
    }

    function apply(ctx) {
      let disposed = false;
      let running = false;
      let rerun = false;
      let retryAfter = 0;
      let lastStatus = "";

      const report = (state, workspaceRoot, error) => {
        const key = JSON.stringify([state, workspaceRoot, error]);
        if (key === lastStatus) return;
        lastStatus = key;
        postStatus(state, workspaceRoot, error);
      };

      const synchronize = async () => {
        if (disposed || globalThis.document.visibilityState === "hidden") return;
        const workspaceRoot = await readDesiredWorkspace();
        if (workspaceRoot === undefined) {
          report("unavailable");
          return;
        }
        const workspaceList = ctx.workspaces.list.getSnapshot();
        const matches = currentWorkspaceMatches(ctx.sessions, workspaceRoot);
        if (!workspaceList.baselinesReady || matches === undefined) {
          report("syncing", workspaceRoot);
          return;
        }
        if (matches) {
          retryAfter = 0;
          report("synced", workspaceRoot);
          return;
        }
        if (Date.now() < retryAfter) return;

        report("syncing", workspaceRoot);
        const workspace = await ctx.workspaces.create({ path: workspaceRoot });
        const sessionId = await ctx.workspaces.connectWorkspace(workspace.id);

        // The active file may have moved to another root while DSH was creating the session.
        const latestRoot = await readDesiredWorkspace();
        if (latestRoot === undefined || canonicalPath(latestRoot) !== canonicalPath(workspaceRoot) || disposed) {
          rerun = true;
          return;
        }
        ctx.sessions.open(sessionId);
        retryAfter = 0;
        report("synced", workspaceRoot);
      };

      const schedule = () => {
        if (disposed) return;
        if (running) {
          rerun = true;
          return;
        }
        running = true;
        void (async () => {
          do {
            rerun = false;
            try {
              await synchronize();
            } catch (error) {
              retryAfter = Date.now() + ERROR_RETRY_MS;
              report("error", undefined, error instanceof Error ? error.message : String(error));
            }
          } while (rerun && !disposed);
        })().finally(() => {
          running = false;
        });
      };

      const interval = globalThis.setInterval(schedule, POLL_INTERVAL_MS);
      const unsubscribeSessions = ctx.sessions.list.subscribe(schedule);
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(schedule);
      const onVisibilityChange = () => schedule();
      globalThis.document.addEventListener("visibilitychange", onVisibilityChange);
      schedule();

      return () => {
        disposed = true;
        globalThis.clearInterval(interval);
        unsubscribeSessions();
        unsubscribeWorkspaces();
        globalThis.document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }

    exports.apply = apply;
    exports.inject = ["workspaces", "sessions"];
    return module.exports;
  },
});
