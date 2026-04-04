# WASI Preview1 → Preview2 Adapter

The `wasi_snapshot_preview1.command.wasm` binary is a pre-built adapter from the
[Bytecode Alliance](https://bytecodealliance.org/) that converts WASI Preview1
(`wasi_snapshot_preview1`) imports to WASI Preview2 component model interfaces.

It is used by `wasm-tools component new --adapt` to produce a wasip2 component
from the raw wasip1 Go binary.

## Source

Downloaded from the Wasmtime releases:
https://github.com/bytecodealliance/wasmtime/releases

The adapter is built from the `wasmtime` repository at:
https://github.com/bytecodealliance/wasmtime/tree/main/crates/wasi-preview1-component-adapter

## Verification

```bash
shasum -a 256 wasi_snapshot_preview1.command.wasm
# Expected: 33192d6755408473c8783a2e32b26ef65e66ba5109c47698b3410b7ac065ea1e
```

## Updating

To update to a newer version:

```bash
# Download from a Wasmtime release (e.g., v29.0.0)
curl -LO https://github.com/bytecodealliance/wasmtime/releases/download/v29.0.0/wasi_snapshot_preview1.command.wasm

# Verify the download
shasum -a 256 wasi_snapshot_preview1.command.wasm

# Replace the adapter and update the expected hash in this README
mv wasi_snapshot_preview1.command.wasm wasm/adapters/
```
