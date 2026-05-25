// whisper_stream: in-process streaming Whisper using libwhisper.
//
// Holds a single whisper_context loaded at init() and reused across many
// utterances. Each utterance is a start() → feedSamples()* → processChunk()*
// → finalize() → (next utterance) cycle. release() frees the model.
//
// Threading: whisper_full() is NOT thread-safe on a single context, so all
// inference calls run on the JS thread (or via AsyncWorker, scheduled
// strictly serially by the host PTTManager / pipeline coordinator). The
// host MUST NOT call processChunk() concurrently with itself or with
// finalize().
//
// JS API:
//   const w = require('./build/Release/whisper_stream.node');
//   w.init(modelPath)         → boolean
//   w.start()                  → void   (reset utterance state)
//   w.feedSamples(Float32Array)→ void   (append PCM 16 kHz mono)
//   w.processChunk(language)   → string (latest full transcript so far)
//   w.finalize(language)       → string (final transcript, releases utterance state)
//   w.release()                → void   (free model)

#include <napi.h>
#include "whisper.h"
#include <vector>
#include <string>
#include <mutex>

namespace {

// Single global context — the model is large; we don't want N copies.
// All access is serialized by the host (no concurrent processChunk).
struct whisper_context * g_ctx = nullptr;

// Sample buffer for the in-flight utterance. Reset by start().
std::vector<float> g_samples;

// Guard for the sample buffer only. Lets feedSamples append while a
// processChunk snapshot has already been taken.
std::mutex g_samplesMutex;

std::string runWhisperFull(const std::vector<float>& samples, const std::string& language) {
  if (!g_ctx || samples.empty()) return "";

  struct whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.language = language.c_str();
  params.translate = false;
  params.print_progress = false;
  params.print_realtime = false;
  params.print_special = false;
  params.print_timestamps = false;
  params.no_timestamps = true;
  params.single_segment = false;
  params.suppress_blank = true;
  params.suppress_non_speech_tokens = true;
  params.n_threads = 4;
  params.no_context = true;

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
    Napi::TypeError::New(env, "Expected (modelPath: string)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string modelPath = info[0].As<Napi::String>().Utf8Value();
  if (g_ctx) {
    whisper_free(g_ctx);
    g_ctx = nullptr;
  }
  struct whisper_context_params cparams = whisper_context_default_params();
  cparams.use_gpu = true;
  cparams.flash_attn = false;
  g_ctx = whisper_init_from_file_with_params(modelPath.c_str(), cparams);
  return Napi::Boolean::New(env, g_ctx != nullptr);
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(g_samplesMutex);
  g_samples.clear();
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
  ProcessWorker(Napi::Function& callback, std::vector<float> snapshot, std::string language)
      : AsyncWorker(callback),
        snapshot_(std::move(snapshot)),
        language_(std::move(language)) {}

  void Execute() override {
    result_ = runWhisperFull(snapshot_, language_);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    Callback().Call({Env().Null(), Napi::String::New(Env(), result_)});
  }

 private:
  std::vector<float> snapshot_;
  std::string language_;
  std::string result_;
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
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    snapshot = g_samples; // copy
  }
  if (!g_ctx || snapshot.empty()) {
    cb.Call({env.Null(), Napi::String::New(env, "")});
    return env.Undefined();
  }
  auto * worker = new ProcessWorker(cb, std::move(snapshot), std::move(language));
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
  std::vector<float> snapshot;
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    snapshot = std::move(g_samples);
    g_samples.clear();
  }
  if (!g_ctx || snapshot.empty()) {
    cb.Call({env.Null(), Napi::String::New(env, "")});
    return env.Undefined();
  }
  auto * worker = new ProcessWorker(cb, std::move(snapshot), std::move(language));
  worker->Queue();
  return env.Undefined();
}

Napi::Value Release(const Napi::CallbackInfo& info) {
  if (g_ctx) {
    whisper_free(g_ctx);
    g_ctx = nullptr;
  }
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    g_samples.clear();
  }
  return info.Env().Undefined();
}

Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, LoadModel));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("feedSamples", Napi::Function::New(env, FeedSamples));
  exports.Set("processChunk", Napi::Function::New(env, ProcessChunk));
  exports.Set("finalize", Napi::Function::New(env, Finalize));
  exports.Set("release", Napi::Function::New(env, Release));
  return exports;
}

}  // namespace

NODE_API_MODULE(whisper_stream, ModuleInit)
