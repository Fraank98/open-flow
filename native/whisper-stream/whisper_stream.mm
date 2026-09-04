// whisper_stream: in-process streaming Whisper using libwhisper.
//
// Holds a single whisper_context loaded at init() and reused across many
// utterances. Each utterance is a start() → feedSamples()* → processChunk()*
// → finalize() → (next utterance) cycle. release() frees the model.
//
// Threading: whisper_full() is NOT thread-safe on a single context. The host
// is expected to schedule inference calls serially (via AsyncWorker, one in
// flight at a time per the pipeline coordinator). As a hard backstop, every
// pass takes g_inferenceMutex around whisper_full so a stray overlap blocks
// instead of corrupting ggml state and aborting the process.
//
// JS API:
//   const w = require('./build/Release/whisper_stream.node');
//   w.init(modelPath, vadModelPath?)         → boolean
//   w.start(initialPrompt?)    → void   (reset utterance state; optional vocab-hint prompt)
//   w.feedSamples(Float32Array)→ void   (append PCM 16 kHz mono)
//   w.processChunk(language)   → string (latest full transcript so far)
//   w.finalize(language)       → string (final transcript, releases utterance state)
//   w.release()                → void   (free model)

#include <napi.h>
#include "whisper.h"
#include <vector>
#include <string>
#include <mutex>
#include <atomic>
#include <chrono>

namespace {

// Single global context — the model is large; we don't want N copies.
// All access is serialized by the host (no concurrent processChunk).
struct whisper_context * g_ctx = nullptr;

// Hard serialization guard for the context. whisper_full() is not thread-safe
// on a single context: two concurrent passes corrupt ggml's shared graph
// allocator and the process aborts (ggml_abort / SIGABRT). The host serializes
// calls, but this lock is the last line of defense — a stray overlap (e.g. an
// idle keepalive racing the final pass) blocks here instead of crashing. It
// also fences whisper_free against an in-flight pass (use-after-free at quit).
// Mirrors the global whisper_mutex in whisper.cpp's own server example.
std::mutex g_inferenceMutex;

// Sample buffer for the in-flight utterance. Reset by start().
std::vector<float> g_samples;

// initial_prompt for the in-flight utterance (dictionary vocabulary hint).
// Set by start(), snapshotted per-pass into ProcessWorker. Guarded by
// g_samplesMutex (utterance state, same lifetime as g_samples).
std::string g_initialPrompt;

// Path to the Silero VAD model, set once at init(). Empty disables VAD, which
// keeps the addon working when the model is missing from the bundle.
std::string g_vadModelPath;

// Guard for the sample buffer only. Lets feedSamples append while a
// processChunk snapshot has already been taken.
std::mutex g_samplesMutex;

// Cooperative abort flag. When set, the abort_callback below tells whisper_full
// to bail out of the in-flight pass ASAP. The host raises it (via requestAbort)
// right before finalize() so a slow streaming chunk — whose result is discarded
// anyway — stops hogging the GPU instead of being awaited to completion. Reset
// to false by start() (new utterance) and finalize() (its own pass must run to
// completion). whisper_full / finalize are serialized by the host, so there is
// never a pass that must abort running concurrently with one that must not.
std::atomic<bool> g_abort{false};

bool abortCallback(void * /*user_data*/) {
  return g_abort.load(std::memory_order_relaxed);
}

std::string runWhisperFull(const std::vector<float>& samples, const std::string& language, const std::string& prompt, bool useVad) {
  if (samples.empty()) return "";

  struct whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.language = language.c_str();
  params.translate = false;
  params.print_progress = false;
  params.print_realtime = false;
  params.print_special = false;
  params.print_timestamps = false;
  // MUST stay false. whisper.cpp derives how far to advance the sliding
  // 30s window from the last timestamp token; with no_timestamps=true it
  // instead hard-codes seek_delta = 100*WHISPER_CHUNK_SIZE (whisper.cpp
  // src/whisper.cpp:5920-5923), so whatever the decoder left untranscribed
  // in a window is skipped for good. A natural pause makes the decoder emit
  // EOT early, and every word between that point and the 30s boundary is
  // then silently dropped — reproduced as speech at 22-30s vanishing from a
  // 36s utterance. Timestamps are not printed (print_timestamps=false) and
  // never reach the output: whisper_full_get_segment_text returns text only.
  params.no_timestamps = false;
  params.single_segment = false;
  params.suppress_blank = true;
  // Renamed from suppress_non_speech_tokens in whisper.cpp v1.9.2. Value kept
  // as-is: it is not what causes the silence hallucination (whisper-cli, which
  // leaves it at the upstream default of false, hallucinates identically), so
  // changing it here would be an unrelated behaviour change.
  params.suppress_nst = true;
  params.n_threads = 4;
  params.no_context = true;
  params.abort_callback = abortCallback;
  params.abort_callback_user_data = nullptr;

  // Voice Activity Detection. Whisper hallucinates its training-set filler
  // ("Grazie.", "Thank you.") on audio without speech, so hand the decoder only
  // the regions Silero marks as speech. Verified: 3s of digital silence yields
  // "Grazie a tutti." without this and nothing with it, while real speech is
  // untouched.
  //
  // NOT enabled for the keepalive pass (useVad=false): that one deliberately
  // feeds 1.5s of silence to force an encoder run and keep the Metal clocks
  // hot. With VAD it would find no speech, skip the encoder, and the GPU would
  // cool down again — reintroducing the cold-start latency it exists to avoid.
  //
  // Requires timestamps (no_timestamps=false above): with VAD and timestamps
  // off, a 36s clip collapsed from 20 sentences to 2.
  if (useVad && !g_vadModelPath.empty()) {
    params.vad = true;
    params.vad_model_path = g_vadModelPath.c_str();
    params.vad_params = whisper_vad_default_params();
  }
  if (!prompt.empty()) {
    params.initial_prompt = prompt.c_str();
  }

  // Hold the lock across the whole pass: whisper_full plus the segment reads,
  // which also touch the context's mutable state. g_ctx is re-checked here
  // because release() may have freed it while this worker was queued.
  std::lock_guard<std::mutex> lock(g_inferenceMutex);
  if (!g_ctx) return "";

  int ret = whisper_full(g_ctx, params, samples.data(), (int)samples.size());
  if (ret != 0) return "";

  std::string out;
  int n = whisper_full_n_segments(g_ctx);
  for (int i = 0; i < n; i++) {
    const char * seg = whisper_full_get_segment_text(g_ctx, i);
    if (seg) out += seg;
  }
  return out;
}

Napi::Value LoadModel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (modelPath: string, vadModelPath?: string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string modelPath = info[0].As<Napi::String>().Utf8Value();
  std::string vadModelPath =
      (info.Length() >= 2 && info[1].IsString()) ? info[1].As<Napi::String>().Utf8Value() : "";
  // Fence model swap against any in-flight pass — see g_inferenceMutex.
  std::lock_guard<std::mutex> lock(g_inferenceMutex);
  if (g_ctx) {
    whisper_free(g_ctx);
    g_ctx = nullptr;
  }
  struct whisper_context_params cparams = whisper_context_default_params();
  cparams.use_gpu = true;
  cparams.flash_attn = false;
  g_ctx = whisper_init_from_file_with_params(modelPath.c_str(), cparams);
  g_vadModelPath = vadModelPath;
  return Napi::Boolean::New(env, g_ctx != nullptr);
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  g_abort.store(false, std::memory_order_relaxed);
  std::string prompt;
  if (info.Length() >= 1 && info[0].IsString()) {
    prompt = info[0].As<Napi::String>().Utf8Value();
  }
  std::lock_guard<std::mutex> lock(g_samplesMutex);
  g_samples.clear();
  g_initialPrompt = std::move(prompt);
  return info.Env().Undefined();
}

// Raise the cooperative abort flag. The in-flight processChunk's whisper_full
// returns early; the host then awaits it and runs the final pass. Safe to call
// with nothing in flight — start()/finalize() reset the flag before any pass
// that must complete.
Napi::Value RequestAbort(const Napi::CallbackInfo& info) {
  g_abort.store(true, std::memory_order_relaxed);
  return info.Env().Undefined();
}

Napi::Value FeedSamples(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected (samples: Float32Array)").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Float32Array arr = info[0].As<Napi::Float32Array>();
  const float * data = arr.Data();
  size_t n = arr.ElementLength();
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    g_samples.insert(g_samples.end(), data, data + n);
  }
  return env.Undefined();
}

// Snapshot the sample buffer, run whisper_full on it, return the result.
// Must NOT be called concurrently with itself or Finalize on the same context.
class ProcessWorker : public Napi::AsyncWorker {
 public:
  ProcessWorker(Napi::Function& callback, std::vector<float> snapshot, std::string language, std::string prompt,
                bool useVad)
      : AsyncWorker(callback),
        snapshot_(std::move(snapshot)),
        language_(std::move(language)),
        prompt_(std::move(prompt)),
        useVad_(useVad),
        queued_(std::chrono::steady_clock::now()) {}

  void Execute() override {
    execStart_ = std::chrono::steady_clock::now();
    result_ = runWhisperFull(snapshot_, language_, prompt_, useVad_);
    execEnd_ = std::chrono::steady_clock::now();
    aborted_ = g_abort.load(std::memory_order_relaxed);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    // Third arg: timing/abort diagnostics. queueMs separates "stuck waiting for
    // a libuv worker thread" from execMs "actually running inference" — the two
    // imply different root causes for a slow pass.
    auto ms = [](auto a, auto b) {
      return std::chrono::duration_cast<std::chrono::milliseconds>(b - a).count();
    };
    Napi::Object info = Napi::Object::New(Env());
    info.Set("queueMs", Napi::Number::New(Env(), (double)ms(queued_, execStart_)));
    info.Set("execMs", Napi::Number::New(Env(), (double)ms(execStart_, execEnd_)));
    info.Set("aborted", Napi::Boolean::New(Env(), aborted_));
    Callback().Call({Env().Null(), Napi::String::New(Env(), result_), info});
  }

 private:
  std::vector<float> snapshot_;
  std::string language_;
  std::string prompt_;
  bool useVad_ = false;
  std::string result_;
  std::chrono::steady_clock::time_point queued_;
  std::chrono::steady_clock::time_point execStart_;
  std::chrono::steady_clock::time_point execEnd_;
  bool aborted_ = false;
};

Napi::Value ProcessChunk(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "Expected (language: string, cb: (err, text) => void)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string language = info[0].As<Napi::String>().Utf8Value();
  Napi::Function cb = info[1].As<Napi::Function>();

  std::vector<float> snapshot;
  std::string prompt;
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    snapshot = g_samples; // copy
    prompt = g_initialPrompt;
  }
  if (!g_ctx || snapshot.empty()) {
    cb.Call({env.Null(), Napi::String::New(env, "")});
    return env.Undefined();
  }
  auto * worker = new ProcessWorker(cb, std::move(snapshot), std::move(language), std::move(prompt), true);
  worker->Queue();
  return env.Undefined();
}

Napi::Value Finalize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "Expected (language: string, cb: (err, text) => void)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string language = info[0].As<Napi::String>().Utf8Value();
  Napi::Function cb = info[1].As<Napi::Function>();
  // The final pass must run to completion — clear any abort the host raised to
  // interrupt the preceding (now-settled) streaming chunk.
  g_abort.store(false, std::memory_order_relaxed);
  std::vector<float> snapshot;
  std::string prompt;
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    snapshot = std::move(g_samples);
    g_samples.clear();
    prompt = g_initialPrompt;
  }
  if (!g_ctx || snapshot.empty()) {
    cb.Call({env.Null(), Napi::String::New(env, "")});
    return env.Undefined();
  }
  auto * worker = new ProcessWorker(cb, std::move(snapshot), std::move(language), std::move(prompt), true);
  worker->Queue();
  return env.Undefined();
}

// Run a short pass on silence to keep the Metal pipeline / GPU clocks warm so
// the first real chunk after an idle period doesn't pay the cold-start ramp
// (~10x slower). Serialized by the host with processChunk/finalize via the
// in-flight guard — never runs concurrently on g_ctx.
Napi::Value Keepalive(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected (cb: (err, text, info) => void)").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Function cb = info[0].As<Napi::Function>();
  if (!g_ctx) {
    cb.Call({env.Null(), Napi::String::New(env, "")});
    return env.Undefined();
  }
  // whisper_full no-ops on <~1.0s of audio (returns in ~1ms without running
  // the encoder), which would NOT warm the GPU. 1.5s is safely above that
  // threshold and forces a real encoder pass (~1s) that keeps the Metal
  // pipeline/clocks hot. Cost is ~constant regardless of exact length here.
  std::vector<float> silence(24000, 0.0f);
  auto * worker = new ProcessWorker(cb, std::move(silence), "en", "", /*useVad=*/false);
  worker->Queue();
  return env.Undefined();
}

Napi::Value Release(const Napi::CallbackInfo& info) {
  // Raise abort first so an in-flight pass bails ASAP, then wait on the
  // inference lock before freeing — never whisper_free() under an active pass.
  g_abort.store(true, std::memory_order_relaxed);
  {
    std::lock_guard<std::mutex> lock(g_inferenceMutex);
    if (g_ctx) {
      whisper_free(g_ctx);
      g_ctx = nullptr;
    }
  }
  g_abort.store(false, std::memory_order_relaxed);
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    g_samples.clear();
    g_initialPrompt.clear();
  }
  return info.Env().Undefined();
}

Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, LoadModel));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("feedSamples", Napi::Function::New(env, FeedSamples));
  exports.Set("processChunk", Napi::Function::New(env, ProcessChunk));
  exports.Set("requestAbort", Napi::Function::New(env, RequestAbort));
  exports.Set("finalize", Napi::Function::New(env, Finalize));
  exports.Set("keepalive", Napi::Function::New(env, Keepalive));
  exports.Set("release", Napi::Function::New(env, Release));
  return exports;
}

}  // namespace

NODE_API_MODULE(whisper_stream, ModuleInit)
