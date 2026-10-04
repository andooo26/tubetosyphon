# Spout2 SDK (SpoutDX subset)

Vendored from https://github.com/leadedge/Spout2 at commit
`c2bcc12147711d12ace7d5f08e869d774d840f8a` (BSD 2-Clause, see `LICENSE`).

Only the files the SpoutDX static library builds from are included, flattened
into one folder (`SpoutDX.h` picks them up via `__has_include`):

- `SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.{h,cpp}`
- `SPOUTSDK/SpoutGL/Spout{Common,Copy,DirectX,FrameCount,SenderNames,SharedMemory,Utils}.*`

Unmodified. Compiled into `native/spout` (the Windows Spout sender addon).
