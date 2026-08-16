/** Verifies Secondary Sidebar capability detection and safe legacy fallback. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRIMARY_SIDEBAR_VIEW_ID,
  resolveSidebarPlacement,
  SECONDARY_SIDEBAR_VIEW_ID,
} from "./sidebar-placement";

describe("resolveSidebarPlacement", () => {
  it("uses the legacy Activity Bar before VS Code 1.106", () => {
    assert.deepEqual(resolveSidebarPlacement("1.105.2"), {
      supportsSecondarySidebar: false,
      viewId: PRIMARY_SIDEBAR_VIEW_ID,
    });
  });

  it("uses the Secondary Sidebar starting with VS Code 1.106", () => {
    for (const version of ["1.106.0", "1.133.0", "1.106.0-insider", "2.0.0"]) {
      assert.deepEqual(resolveSidebarPlacement(version), {
        supportsSecondarySidebar: true,
        viewId: SECONDARY_SIDEBAR_VIEW_ID,
      });
    }
  });

  it("falls back safely when the version cannot be parsed", () => {
    for (const version of ["", "unknown", "1", "1.x.0", "v1.133.0"]) {
      assert.deepEqual(resolveSidebarPlacement(version), {
        supportsSecondarySidebar: false,
        viewId: PRIMARY_SIDEBAR_VIEW_ID,
      });
    }
  });
});
