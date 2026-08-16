/** Selects the native VS Code sidebar location without coupling it to DSH lifecycle logic. */

export const SIDEBAR_COMPATIBILITY_CONTEXT = "dsh.doesNotSupportSecondarySidebar";
export const PRIMARY_SIDEBAR_VIEW_ID = "dsh.sidebarView";
export const SECONDARY_SIDEBAR_VIEW_ID = "dsh.sidebarSecondaryView";

export interface SidebarPlacement {
  supportsSecondarySidebar: boolean;
  viewId: typeof PRIMARY_SIDEBAR_VIEW_ID | typeof SECONDARY_SIDEBAR_VIEW_ID;
}

/** VS Code added extension-contributed Secondary Sidebar containers in version 1.106. */
export function resolveSidebarPlacement(version: string): SidebarPlacement {
  const match = /^(\d+)\.(\d+)(?:\.|-|$)/.exec(version.trim());
  if (match === null) {
    return { supportsSecondarySidebar: false, viewId: PRIMARY_SIDEBAR_VIEW_ID };
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supportsSecondarySidebar = Number.isSafeInteger(major)
    && Number.isSafeInteger(minor)
    && (major > 1 || (major === 1 && minor >= 106));

  return {
    supportsSecondarySidebar,
    viewId: supportsSecondarySidebar ? SECONDARY_SIDEBAR_VIEW_ID : PRIMARY_SIDEBAR_VIEW_ID,
  };
}
