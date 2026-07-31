# Vendored copy

`moye-agent-sdk.js` here is a byte-for-byte copy of
[`../../sdk/node/moye-agent-sdk.js`](../../sdk/node/moye-agent-sdk.js), vendored so that `a2a/mcp/`
can be downloaded and run **standalone** (e.g. by `install.sh` / `mcp-dist`, which fetch only the
`mcp/` directory, not the whole monorepo). `identity.js` prefers the sibling repo path first and
only falls back to this vendored copy when that path doesn't exist -- so the MCP server behaves
identically whether it's run from inside a full checkout or from a standalone install.

**Keep in sync**: whenever `a2a/sdk/node/moye-agent-sdk.js` changes, re-copy it here:

```bash
cp a2a/sdk/node/moye-agent-sdk.js a2a/mcp/vendor/moye-agent-sdk.js
```

There is no build step enforcing this yet -- it's a manual step until one exists.
