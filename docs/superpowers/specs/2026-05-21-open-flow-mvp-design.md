# Open Flow — MVP Design

**Date:** 2026-05-21
**Status:** Approved — ready for implementation planning
**Author:** Brainstorming session with danilo

## Goal

Replicare l'esperienza core di **Wispr Flow** come app desktop macOS:
hotkey globale → registra audio → trascrivi con Whisper → ripulisci con un LLM →
inserisci il testo nel campo testo attivo di qualsiasi app.

L'MVP punta a un'esperienza fluida di dettatura con cleanup automatico
(rimozione disfluenze, punteggiatura, capitalizzazione), funzionante
**interamente in locale** e distribuita come singolo `.dmg` senza dipendenze
esterne richieste all'utente.

## Non-goals (out of scope per l'MVP)

- Streaming transcription (audio mentre l'utente parla)
- Vocabolario custom / memoria contestuale per nomi propri
- Comandi vocali in linguaggio naturale ("rendilo formale", "in inglese")
- Riconoscimento multi-speaker
- Windows / Linux (solo macOS)
- Mac App Store distribution

## Requirements

### Funzionali

1. Attivazione via hotkey globale push-to-talk (default: hold `Right Option`)
2. Cattura audio dal microfono di sistema
3. Trascrizione locale via `whisper.cpp` con language detection automatica
4. Cleanup del transcript via LLM locale (`llama.cpp` + modello GGUF piccolo)
5. Inserimento del testo pulito nel campo testo attivo via clipboard + `Cmd+V`
6. Overlay visuale con stati: recording → transcribing → cleaning → done
7. App in menubar con preferenze, toggle on/off, quit
8. Wizard di primo avvio per permessi macOS + download modelli

### Non funzionali

- **Privacy:** audio non lascia mai il device; nessuna chiamata di rete in
  esecuzione (solo per download iniziale modelli)
- **Latenza:** post-rilascio hotkey → testo inserito in < 3s per audio di 10s
  su Apple Silicon
- **Distribuzione:** singolo `.dmg` ~60 MB, unsigned per ora (utente fa
  right-click → Open la prima volta)
- **Zero dipendenze esterne:** nessun `brew install`, nessun account, nessun
  download manuale da parte dell'utente — tutto via l'app stessa

## Architettura

### Stack

- **Electron** (main + renderer process) come container
- **Node.js** per la logica del main process
- **HTML/CSS** vanilla o leggero framework per overlay e preferenze (nessuna
  necessità di React/Vue per la superficie UI minimale)
- **TypeScript** per i moduli core (encoder, parser, runners, sanitizer)
- **whisper.cpp** binary (Metal-enabled) bundled in `resources/bin/whisper-cli`
- **llama.cpp** binary (Metal-enabled) bundled in `resources/bin/llama-cli`

### Componenti del main process

| Componente | Responsabilità |
|---|---|
| `HotkeyManager` | Registra hotkey globale via `globalShortcut`. Default: hold `Right Option`. Emit eventi `start` / `stop`. Filtra tap < 200ms |
| `AudioRecorder` | Coordina la cattura audio: invia messaggio al renderer per avviare/stoppare `getUserMedia`, riceve buffer PCM 16kHz mono via IPC, scrive WAV temporaneo |
| `WhisperRunner` | Spawn di `whisper-cli` con args `-m <model> -f <wav> -l auto --output-json -of <out>`. Parse JSON. Timeout 30s |
| `LLMCleaner` | Spawn di `llama-cli` con prompt template di pulizia. Parse stdout. Sanitizza prefissi rumorosi ("Here is..."). Fallback a transcript raw su errore. Timeout 15s |
| `TextInjector` | Salva clipboard → scrive testo pulito → simula `Cmd+V` via `osascript` → ripristina clipboard precedente |
| `OverlayWindow` | Frameless + alwaysOnTop + transparent. Mostra stato pipeline e waveform. Cancellabile via `Esc` o click ✕ |
| `PreferencesWindow` | Form: hotkey, modello Whisper, modello LLM, lingua, prompt cleanup custom, log opt-in |
| `MenubarApp` | Tray icon (grigio/blu/rosso per off/ready/recording). Menu: Status, Toggle, Preferences, Open Logs, Quit |
| `SetupWizard` | First-launch flow: welcome → richiesta permessi → scelta qualità → download modelli con progress |
| `ModelManager` | Download modelli da HuggingFace CDN con resume, checksum SHA, cache in `~/Library/Application Support/open-flow/models/` |
| `Logger` | File logger in `~/Library/Logs/open-flow/` con rotazione 5MB × 3 |

### Componenti del renderer

- `recorder.html` — usa Web Audio API (`AudioWorkletNode`) per catturare a 48kHz, downsample a 16kHz mono Float32, invia chunks via IPC
- `overlay.html` — animazione waveform durante recording, spinner durante processing
- `prefs.html` — form preferenze persistite in `electron-store`
- `setup.html` — wizard di onboarding al primo avvio

### Distribuzione

- Repo **GitHub privata** finché in sviluppo
- `gh release` con `.dmg` allegato per release pubbliche
- Bundle contiene: app Electron + `whisper-cli` + `llama-cli` (entrambi
  universal binary ARM64+x86_64 con Metal)
- Modelli **NON bundlati**: scaricati al primo avvio o on-demand da Preferences

### Modelli

| Tier | Whisper | LLM cleanup | Disco totale | Target |
|---|---|---|---|---|
| Veloce | `base` (~150 MB) | `qwen2.5-0.5b-instruct` Q4 (~400 MB) | ~600 MB | Mac base, latenza minima |
| **Bilanciato** (default) | `base.en` o `base` (~150 MB) | `qwen2.5-1.5b-instruct` Q4 (~1 GB) | ~1.5 GB | Apple Silicon, miglior trade-off |
| Massima | `large-v3` (~3 GB) | `qwen2.5-3b-instruct` Q4 (~2 GB) | ~5 GB | M2 Pro+, qualità max |

Sorgenti di download:
- Whisper: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<size>.bin`
- LLM: `https://huggingface.co/Qwen/Qwen2.5-<size>-Instruct-GGUF/resolve/main/qwen2.5-<size>-instruct-q4_k_m.gguf`

## UX Flow

### Trigger model

- **Push-to-talk (default):** hold `Right Option` per tutta la durata della
  registrazione. Rilascio → pipeline parte
- **Toggle alternativo:** tap singolo `Fn` per iniziare, tap per fermare
  (configurabile)
- Tap < 200ms ignorato

### Stati overlay

Frameless window 360×80 px in basso al centro dello schermo:

| Stato | Visuale |
|---|---|
| Idle | Nascosto |
| Recording | Waveform live + timer + ✕ Cancel |
| Transcribing | Spinner + "Trascrivendo..." |
| Cleaning | Spinner + "Pulizia..." |
| Error | ⚠️ + messaggio breve + "Riprova" |
| Done | Flash verde 300ms → fade out |

### Flow utente tipico

1. Cursore in un campo testo (qualsiasi app)
2. Hold `Right Option` → overlay appare, registrazione parte
3. Utente parla
4. Rilascia `Right Option`
5. Pipeline: Whisper → LLM cleanup → paste automatico
6. Overlay svanisce

### Casi limite

- Nessun campo testo focalizzato → solo copia in clipboard + notifica
- Permesso Accessibilità mancante → modal con istruzioni + deep link
- Hotkey già usata → notifica al primo start, suggerisce di cambiarla
- Registrazione > 60s → warning visivo (Whisper può comunque processare)
- App in background durante registrazione → continua (comportamento corretto)

## Data Flow

```
[Mic]
  ↓ getUserMedia (renderer)
[MediaStreamTrack 48kHz]
  ↓ AudioWorkletNode (downsample → 16kHz mono Float32)
[ArrayBuffer chunks]
  ↓ IPC: ipcRenderer.send('audio-chunk', buf)
[Main: buffer accumulato]
  ↓ on hotkey release: encode WAV
[/tmp/open-flow/rec-<uuid>.wav]
  ↓ spawn whisper-cli
[/tmp/open-flow/rec-<uuid>.json]
  ↓ parse → text
[raw transcript]
  ↓ spawn llama-cli con prompt cleanup
[cleaned transcript]
  ↓ sanitize (strip prefissi noti, length sanity check)
[TextInjector]
  ↓ clipboard save → write → osascript Cmd+V → restore
[testo nel campo attivo]
  ↓ cleanup
[delete temp files]
```

### Audio capture

- Web Audio API è più affidabile di `node-record-lpcm16` su Electron+macOS
- Sample rate input: 48 kHz (Mac default) → downsample a 16 kHz via
  `AudioWorkletProcessor`
- Buffer max in memoria: 30 s (sliding window oltre)
- WAV header standard 44 byte + PCM 16-bit mono LE
- File temporaneo in `os.tmpdir()/open-flow/`, cleanup all'exit

### Whisper invocation

```
whisper-cli -m <model.bin> -f <input.wav> \
  -l auto -t 4 --output-json -of <output>
```

- `-l auto` per language detection
- `-t 4` (4 thread CPU); Metal usato automaticamente per modelli compatibili
- Timeout: 30s
- Output JSON: concatena `transcription[].text`

### LLM cleanup

Prompt template:

```
You are a transcript cleaner. Take the transcript and:
- Remove disfluencies (uh, um, ehm, like, allora, cioè)
- Add proper punctuation and capitalization
- Fix obvious speech-to-text errors
- Keep the speaker's meaning, tone, and language EXACTLY
- Output ONLY the cleaned text, no commentary or prefix

Transcript: {{raw}}
Cleaned:
```

Args:

```
llama-cli -m <llm.gguf> -p "<prompt>" \
  --no-display-prompt -n 512 --temp 0.2 -ngl 99
```

- `-ngl 99`: tutti i layer GPU Metal
- Temperature 0.2 per output deterministico-ish
- Timeout: 15s
- **Sanitizer post-output:** strip prefissi noti (`Here is the cleaned text:`,
  `Cleaned:`, ecc.). Se output > 3× input length, fallback a transcript raw

### Text injection

```js
const prev = clipboard.readText();
clipboard.writeText(cleaned);
await execAsync(
  'osascript -e \'tell app "System Events" to keystroke "v" using command down\''
);
await sleep(150);
clipboard.writeText(prev);
```

### Performance target (M2/M3, audio 10s)

| Step | Tempo target |
|---|---|
| WAV encode | < 50 ms |
| Whisper base | 0.8 – 1.5 s |
| LLM cleanup (Qwen 1.5B Q4) | 0.5 – 1.5 s |
| Text injection | ~ 200 ms |
| **Totale post-rilascio** | **1.5 – 3 s** |

## Error handling

Filosofia: ogni errore → messaggio chiaro all'utente. Mai inserire testo
sbagliato silenziosamente.

| Errore | Detection | Reazione |
|---|---|---|
| Permesso mic negato | `getUserMedia` rejecta `NotAllowedError` | Modal con deep link a System Settings |
| Permesso Accessibilità mancante | `osascript` exit code 1 | Modal + fallback: solo clipboard + notifica |
| Audio silenzioso (RMS < soglia) | Calcolo RMS sul buffer | Notifica "Non ho sentito nulla". No chiamata Whisper |
| Audio < 300 ms | Durata buffer | Ignora silenziosamente |
| Whisper crash / timeout | Exit code ≠ 0 o 30s | Notifica + tasto "Riprova". WAV preservato per debug |
| Whisper output vuoto | `text == ""` | Notifica "Audio incomprensibile" |
| LLM crash / timeout | Exit code ≠ 0 o 15s | Fallback: usa transcript raw + notifica discreta |
| LLM output anomalo | Length > 3× input o prefissi rumorosi | Sanitize; se ancora sospetto, fallback al raw |
| Modello mancante/corrotto | File assente o size errata | Riapre wizard download |
| Disco pieno | `fs.writeFile` → `ENOSPC` | Notifica chiara |
| Clipboard error | Catch su `readText/writeText` | Inserisci comunque, skip restore, log warning |
| Paste in app non-text | `AXFocusedUIElement` non text field (best-effort) | Solo clipboard + notifica |
| Hotkey conflict | `globalShortcut.register` ritorna false | Notifica al primo start, suggerisce alternativa |
| Crash binary nativo | SIGSEGV nel close event | Notifica + log completo |

### Logging

- Errori → `~/Library/Logs/open-flow/error.log` (rotazione 5 MB × 3 file)
- Debug (opt-in) → `~/Library/Logs/open-flow/debug.log`
- Menu Tray → "Open Logs Folder" per supporto

### Recovery

- Wizard di setup ri-eseguibile da Preferences → "Reset & Re-download Models"
- Reset preferenze: elimina `~/Library/Preferences/com.openflow.app.plist`

## Testing strategy

| Livello | Cosa testa | Tooling |
|---|---|---|
| Unit | WAV encoder, JSON parser, prompt builder, output sanitizer, checksum validator, hotkey matcher | Vitest |
| Integration | `WhisperRunner.run(fixture.wav)` con spawn reale su ~7 fixtures audio | Vitest |
| Integration LLM | `LLMCleaner.clean(raw)` su 20 transcript noti con snapshot fuzzy | Vitest |
| E2E manuale | Checklist documentata in `docs/test-checklist.md` pre-release | Markdown |
| Smoke automatizzato | Playwright launch Electron, verifica menubar + overlay appear/disappear | Playwright |

### Audio fixtures

Generati con `say` macOS + alcuni reali:
- `it-short-clean.wav`, `en-short-clean.wav`
- `it-disfluencies.wav` (con "ehm", "tipo", "cioè")
- `silence.wav`, `noise-only.wav`
- `mixed-it-en.wav` (code-switching)
- `long-60s.wav` (test limite)

### Cosa NON testiamo

- Mock completo di Whisper / LLM (non testerebbe niente di reale)
- Permessi macOS (richiede UI interaction)
- Performance benchmark automatici (variano troppo)

### CI (GitHub Actions)

- Lint + typecheck su ogni PR
- Unit + integration su macOS runner
- Build `.dmg` su push a `main` (artifact)
- Release `.dmg` su tag `v*`

## Project structure

```
open-flow/
├── package.json
├── electron-builder.yml
├── tsconfig.json
├── src/
│   ├── main/
│   │   ├── index.ts                 # entry main process
│   │   ├── hotkey-manager.ts
│   │   ├── audio-recorder.ts
│   │   ├── whisper-runner.ts
│   │   ├── llm-cleaner.ts
│   │   ├── text-injector.ts
│   │   ├── menubar-app.ts
│   │   ├── overlay-window.ts
│   │   ├── prefs-window.ts
│   │   ├── setup-wizard.ts
│   │   ├── model-manager.ts
│   │   ├── logger.ts
│   │   └── utils/
│   │       ├── wav-encoder.ts
│   │       ├── prompt-template.ts
│   │       └── output-sanitizer.ts
│   ├── renderer/
│   │   ├── recorder.html
│   │   ├── overlay.html
│   │   ├── prefs.html
│   │   └── setup.html
│   └── shared/
│       └── ipc-channels.ts
├── resources/
│   └── bin/
│       ├── whisper-cli              # built from whisper.cpp
│       └── llama-cli                # built from llama.cpp
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/audio/
├── docs/
│   ├── superpowers/specs/
│   └── test-checklist.md
└── .github/workflows/
    ├── ci.yml
    └── release.yml
```

## Open questions / future work

- **v2:** vocabolario custom (parole/nomi propri sempre da preservare)
- **v2:** streaming transcription per feedback "live"
- **v2:** comandi vocali ("nuova riga", "rendilo formale")
- **v2:** code signing Apple Developer per UX install più pulita
- **v2:** Windows port (whisper.cpp e llama.cpp esistono già, da rifare audio
  pipeline e text injection)
- **TBD post-MVP:** integrare modelli MLX Whisper (più veloci su M-series)
  come opzione avanzata

## Decisions log

| Decisione | Scelta | Motivo |
|---|---|---|
| Locale vs cloud | **Tutto locale** | Privacy, zero costi runtime, offline |
| Stack | **Electron** | Setup rapido, ecosistema npm, UI HTML semplice |
| Architettura binari | **Spawn binari nativi bundlati** | Setup utente zero, build pipeline solida |
| Distribuzione | **GitHub Releases `.dmg` unsigned** | $0 di costo iniziale, ok per beta |
| Modello cleanup | **Qwen2.5-1.5B-Instruct Q4 (default)** | Multilingua, veloce, ~1GB |
| Trigger | **Right Option hold push-to-talk** | Tasto poco usato, modello prevedibile |
| Modelli scaricati | **Al primo avvio + on-demand** | Installer leggero, flusso uniforme per tutti i modelli |
| Text injection | **Clipboard + Cmd+V via osascript** | Massima compatibilità con app macOS |
