{
  # Windows-only Spout sender addon. Built by scripts/build-spout.js (run from
  # postinstall on win32); never built on macOS.
  "targets": [
    {
      "target_name": "spout",
      "sources": [
        "spout_addon.cc",
        "../../vendor/spout2/SpoutDX.cpp",
        "../../vendor/spout2/SpoutCopy.cpp",
        "../../vendor/spout2/SpoutDirectX.cpp",
        "../../vendor/spout2/SpoutFrameCount.cpp",
        "../../vendor/spout2/SpoutSenderNames.cpp",
        "../../vendor/spout2/SpoutSharedMemory.cpp",
        "../../vendor/spout2/SpoutUtils.cpp"
      ],
      "include_dirs": ["../../vendor/spout2"],
      # Node's common.gypi builds with C++ exceptions off; the Spout SDK and
      # the STL headers it uses expect them on.
      "defines!": ["_HAS_EXCEPTIONS=0"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          # SpoutDX.h relies on __has_include.
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}
