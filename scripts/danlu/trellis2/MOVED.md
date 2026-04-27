# Trellis2 has moved

This subdirectory used to host the FastAPI server, deployment scripts and
clients for **TRELLIS.2-4B** image-to-3D inference on the DanLu GPU host.

It has been extracted to a standalone repository so the same service can be
consumed by multiple frontends without coupling to ConceptToHighresModel:

> **`D:\AI\Services\Trellis2Service`** (sibling of `D:\AI\Services\QwenEditService`)

## What lives where now

| Old path (here)                           | New path (Trellis2Service repo) |
|-------------------------------------------|---------------------------------|
| `trellis2_server.py`                      | `server/trellis2_server.py`     |
| `run_server.sh`                           | `server/run_server.sh`          |
| `setup_env.sh`                            | `deploy/setup_env.sh`           |
| `download_trellis2.sh`                    | `deploy/download_trellis2.sh`   |
| `trellis2_client.py`                      | `clients/python/trellis2_client.py` |
| (new) systemd unit + install scripts      | `deploy/trellis2.service` + `deploy/install_systemd.sh` + `deploy/uninstall_systemd.sh` |
| (new) SSH tunnel helper                   | `deploy/ssh_tunnel.ps1`         |
| (new) remote restart helper               | `deploy/_remote_restart.sh`     |

The dozens of one-shot `_check_*.sh` / `_diag_*.sh` / `resume_setup_v*.sh` /
`_patch_*.sh` debug scripts that lived here were intentionally **not**
migrated — their job was to bootstrap the conda env and they have already
served that purpose.

## Frontend integration (this repo)

The TypeScript client used by the frontend remains
[../../src/services/trellis2.ts](../../src/services/trellis2.ts) and still
talks to the `/trellis` Vite proxy → `http://127.0.0.1:8766`. Nothing in the
frontend changes.

To call it from your machine you still need an SSH tunnel; the helper script
now lives in the Trellis2Service repo:

```powershell
D:\AI\Services\Trellis2Service\deploy\ssh_tunnel.ps1
```

## Why split it out?

- Same operational pattern as [QwenEditService](D:\AI\Services\QwenEditService),
  which is already a standalone repo with its own `server/` + `deploy/` +
  `clients/` layout.
- Lets the service be reused by other frontends or published independently.
- Keeps ConceptToHighresModel focused on the prototype UI.

See [Trellis2Service/README.md](D:\AI\Services\Trellis2Service\README.md) for
deployment, systemd operations, and the comparison vs the 丹青约 MCP backend.
