# Playdate PDI Fixture

Small fixture for proving Playdate SDK image conversion and runtime loading for
cloud snapshot image outputs.

Run from the repository root:

```sh
examples/playdate-pdi-fixture/scripts/verify.sh
```

The verifier:

1. Generates `Source/assets/cloud-figure.png`.
2. Checks the generated PNG is Playdate-ready 1-bit art.
3. Compiles the project with `/Users/kyle/Developer/PlaydateSDK/bin/pdc`.
4. Confirms `pdc` produced `build/CloudSnapshotPdiFixture.pdx/assets/cloud-figure.pdi`.
5. Runs the Playdate Simulator autotest through `/Users/kyle/codex/playdate-harness`.

Generated PNG, PDI, and telemetry artifacts are ignored by git.
