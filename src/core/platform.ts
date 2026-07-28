/** Build-target capability flags.
 *
 * WXT stamps `import.meta.env.FIREFOX` at build time, so each branch below is
 * constant-folded out of the bundle the other target ships.
 *
 * Callers gate on these rather than probing `browser.tabCapture` /
 * `browser.offscreen` / `browser.sidePanel` at runtime: on Firefox those objects
 * are simply absent, and a probe there reads like a missing permission (which
 * the user could grant) instead of a missing platform API (which they can't).
 */

/** True in the Firefox build. */
export const IS_FIREFOX: boolean = import.meta.env.FIREFOX;

/** Tab capture — the fallback pipeline for pages whose media is CORS-tainted,
 * DRM'd, or whose CSP blocks the worklet. Needs `tabCapture` to get the stream
 * and `offscreen` to host its `AudioContext`; Firefox implements neither, so
 * direct mode is the only mode there. */
export const CAN_CAPTURE_TAB: boolean = !IS_FIREFOX;

/** The panel surface. Chromium opens `side_panel` through the `sidePanel` API;
 * Firefox registers the same page as `sidebar_action` and opens it through
 * `sidebarAction`. */
export const HAS_SIDE_PANEL_API: boolean = !IS_FIREFOX;
