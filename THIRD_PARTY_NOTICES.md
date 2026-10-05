# Third-party notices

open-flow itself is released under the MIT license (see [LICENSE](LICENSE)).

The open-flow DMG redistributes the third-party software listed below. Their
license texts are reproduced here as those licenses require. The same file is
shipped inside the app at `Contents/Resources/licenses/THIRD_PARTY_NOTICES.md`.

The AI models are **not** redistributed. They are downloaded from Hugging Face
on first launch into `~/Library/Application Support/open-flow/models`. Their
licenses are listed in [Models](#models) so you can check them before picking
a quality tier.

## Bundled software

### whisper.cpp (v1.9.2)

https://github.com/ggml-org/whisper.cpp

Shipped as the `whisper-server` binary and the `libwhisper` / `libggml`
dylibs, and linked into the `whisper_stream` native addon.

```text
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### llama.cpp (b4404)

https://github.com/ggml-org/llama.cpp

Shipped as the `llama-server` binary and its own `libllama` / `libggml`
dylibs (kept in a separate directory from the whisper.cpp ones).

```text
MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Silero VAD (ggml-silero-v6.2.0.bin)

https://github.com/snakers4/silero-vad

The voice-activity-detection model used by whisper.cpp, shipped as
`ggml-silero-v6.2.0.bin`.

```text
MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Electron (44.x)

https://www.electronjs.org/

Chromium, Node.js and the other components bundled in Electron carry their own
licenses; their notices are in `LICENSES.chromium.html`, shipped in
`Contents/Resources/licenses/`. Electron's own license is shipped there as
`LICENSE.electron.txt`.

```text
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### node-addon-api

https://github.com/nodejs/node-addon-api

Used to build the `ptt_monitor.node` and `whisper_stream.node` native addons.

```text
The MIT License (MIT)

Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Models

| Model | Tier | License | Source |
|---|---|---|---|
| Whisper `small` (ggml) | Fast, Balanced | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| Whisper `large-v3-turbo` (ggml) | Max | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| Qwen2.5-0.5B-Instruct (GGUF) | Fast | Apache-2.0 | https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF |
| Qwen2.5-1.5B-Instruct (GGUF) | Balanced | Apache-2.0 | https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF |
| Gemma 3 4B instruct (GGUF) | Reply suggestions | [Gemma Terms of Use](https://ai.google.dev/gemma/terms) and [Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy) | https://huggingface.co/unsloth/gemma-3-4b-it-GGUF (base: google/gemma-3-4b-it) |
| Gemma 4 E4B instruct (GGUF) | Reply suggestions (max) | [Apache-2.0](https://ai.google.dev/gemma/docs/gemma_4_license) | https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF (base: google/gemma-4-E4B-it) |
| Qwen2.5-3B-Instruct (GGUF) | Max | [Qwen Research License Agreement](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/LICENSE), non-commercial only | https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF |

Qwen2.5-3B-Instruct is licensed by Alibaba Cloud for non-commercial purposes only. If you use open-flow for commercial work, pick the Fast or Balanced tier (Apache-2.0 models), or disable LLM cleanup in Preferences. open-flow's own MIT license does not change the terms under which the models are offered.

Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms. Use of Gemma 3 4B is also subject to the Gemma Prohibited Use Policy at https://ai.google.dev/gemma/prohibited_use_policy. Commercial use is allowed under those terms. Gemma 4 E4B is released under Apache-2.0 instead.
