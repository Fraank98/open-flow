{
  "targets": [
    {
      "target_name": "ptt_monitor",
      "sources": ["native/ptt-monitor/ptt_monitor.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": ["-fobjc-arc"],
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_ENABLE_OBJC_ARC": "YES"
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/Cocoa.framework",
              "$(SDKROOT)/System/Library/Frameworks/Foundation.framework",
              "$(SDKROOT)/System/Library/Frameworks/ApplicationServices.framework",
              "$(SDKROOT)/System/Library/Frameworks/CoreAudio.framework"
            ]
          }
        }]
      ]
    },
    {
      "target_name": "whisper_stream",
      "sources": ["native/whisper-stream/whisper_stream.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "resources/bin/build-tmp/whisper.cpp/include",
        "resources/bin/build-tmp/whisper.cpp/ggml/include"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "OTHER_LDFLAGS": [
              "-Wl,-rpath,@loader_path",
              "-Wl,-rpath,@loader_path/../../resources/bin/lib",
              "-Wl,-rpath,@loader_path/../../../lib"
            ]
          },
          "libraries": [
            "<(module_root_dir)/resources/bin/lib/libwhisper.dylib",
            "<(module_root_dir)/resources/bin/lib/libggml.dylib"
          ]
        }]
      ]
    }
  ]
}
