// OpenCode 1.x and magpie's plugin host load `main` and require every
// export to be a plugin function (or { id, server }). OpenCode 2.x loads
// `exports["."]` (`./opencode2.mjs`), which wraps this default export.
export { default } from "./index.mjs"
