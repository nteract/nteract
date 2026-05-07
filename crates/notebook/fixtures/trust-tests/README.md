# Trust Test Fixtures

These notebooks are designed to test the dependency trust verification system.

## Test Cases

### `untrusted-valid-deps.ipynb`
- Has valid PyPI dependencies (pandas, numpy)
- **Expected**: Shows trust dialog with package list, no warnings

### `untrusted-typosquat.ipynb`
- Has typosquatted package names (numppy, pandass, reqeusts)
- **Expected**: Shows trust dialog with typosquat warnings

### `untrusted-mixed-deps.ipynb`
- Mix of valid (pandas, numpy) and suspicious (scikitlearn, matplotib) packages
- **Expected**: Shows trust dialog with some typosquat warnings

### `untrusted-conda-deps.ipynb`
- Uses conda dependencies instead of PyPI
- **Expected**: Shows trust dialog with conda packages and channels listed

## How to Test

1. Build the app: `pnpm notebook:build && cargo tauri build --debug`
2. Open a fixture: `./target/debug/notebook crates/notebook/fixtures/trust-tests/<file>.ipynb`
3. Try to run a cell - the trust dialog should appear
