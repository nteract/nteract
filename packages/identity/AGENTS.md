# @nteract/identity

Scope: `packages/identity/**`. [README.md](README.md) lists the modules.

Identity rules that nteract notebooks and Pages must compute the same way.

- One copy. A rule both products apply goes here, and each product imports it
  by package name. Don't keep a second copy in an app.
- `scope-capabilities.ts` is generated from `crates/nteract-identity`. Change
  the Rust type, run the generator named in the README, and commit both.
- No runtime dependencies and no host APIs: no Workers, Node, DOM, or storage
  imports. A rule that needs a database or a request belongs in
  `@nteract/session` or in the host.
- Export every public name from `src/index.ts`. Pages resolves the package to
  that one file, so a name missing from it does not exist for Pages.
- A change to a scope, a colour, or email normalization changes what both
  products decide. Test it in `tests/`, then run the notebook cloud and Pages
  suites that use it.
