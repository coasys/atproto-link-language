// The mounted language's template variables: the ONLY values
// `language.applyTemplateLocal` can set, emitted by mount-build.mjs as the
// bundle banner. All are public settings. A credential (OAuth token, DPoP
// key, password) must never become one: the template is part of the
// language bundle stored in the executor's data dir and shared with the
// language address. Credentials live only sealed in host storage
// (src/mount/vault.ts). tests/mount-oauth.test.ts pins this list.
export const TEMPLATE_VARS = [
  ["ACCOUNTS", ""],
  ["PLC_URL", "https://plc.directory"],
  ["APPVIEW_URL", ""],
  ["POLL_MS", "60000"],
  ["ALLOW_HTTP", ""],
];
