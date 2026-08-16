// Probe node-addon-require-builtin under a given runtime.
// Usage: <runtime> probe-require-builtin.cjs <staging-node_modules>
const base = process.argv[2]
const addon = require(base + '/node-addon-require-builtin')
try {
  const r = addon.requireBuiltin('internal/modules/esm/loader')
  let cascaded = false
  if (r && typeof r.getOrInitializeCascadedLoader === 'function') {
    cascaded = r.getOrInitializeCascadedLoader() !== undefined
  }
  console.log(JSON.stringify({ ok: true, hasLoader: Boolean(r), cascaded }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: String(error.message) }))
}
