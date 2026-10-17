/**
 * The wire contract between the plugin and its detached helper: HTTP paths,
 * file schema ids and the one-shot token header.
 *
 * Both sides import this module, so a renamed path cannot silently desync a
 * running helper from the harness it is updating.
 * @module dsh-auto-update/protocol
 */

/** Base path every route of this feature lives under. */
export const BASE_PATH = '/auto-update'

/** Where the JSON status document is served. */
export const STATUS_PATH = `${BASE_PATH}/api/v1/status`

/** Where the human-readable dashboard is served. */
export const DASHBOARD_PATH = `${BASE_PATH}/`

/** Force an immediate registry check. */
export const CHECK_PATH = `${BASE_PATH}/api/v1/check`

/**
 * Pick the release channel (`stable`/`next`/`alpha`) from the panel.
 *
 * Separate from `/check` on purpose: changing the channel invalidates the
 * verdict the previous one produced, so the endpoint has to clear it rather
 * than merely ask again.
 */
export const CHANNEL_PATH = `${BASE_PATH}/api/v1/channel`

/** Start an update now, regardless of the idle policy. */
export const APPLY_PATH = `${BASE_PATH}/api/v1/apply`

/** Bring the packaged desktop wrapper in step with the installed harness. */
export const DESKTOP_PATH = `${BASE_PATH}/api/v1/desktop`

/** The log tail, as text or JSON. */
export const LOG_PATH = `${BASE_PATH}/api/v1/log`

/**
 * The helper's private shutdown door. Not part of the public surface: it
 * accepts only a POST carrying the run's one-shot token, and exists so the
 * helper can ask a healthy harness to step aside instead of killing it.
 */
export const SHUTDOWN_PATH = `${BASE_PATH}/api/v1/internal/shutdown`

/** Header carrying the one-shot shutdown token. */
export const TOKEN_HEADER = 'x-dsh-auto-update-token'

/** Schema id of the plan a helper is started with. */
export const PLAN_SCHEMA = 'dsh-auto-update/plan/v1'

/** Schema id of the helper's own progress file. */
export const HELPER_SCHEMA = 'dsh-auto-update/helper/v1'

/** File name of the helper's progress record inside the feature directory. */
export const HELPER_FILE = 'helper.json'
