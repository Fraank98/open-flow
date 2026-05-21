# Audio Fixtures

Generate fixtures with macOS `say` and `ffmpeg`:

```bash
# Italian short clean
say -v "Alice" -o it-short-clean.aiff "Ciao Marco, grazie per la mail di ieri."
ffmpeg -y -i it-short-clean.aiff -ar 16000 -ac 1 -sample_fmt s16 it-short-clean.wav
rm it-short-clean.aiff

# English short clean
say -v "Samantha" -o en-short-clean.aiff "Hello, this is a test of the dictation system."
ffmpeg -y -i en-short-clean.aiff -ar 16000 -ac 1 -sample_fmt s16 en-short-clean.wav
rm en-short-clean.aiff

# Silence (3 seconds)
ffmpeg -y -f lavfi -i "anullsrc=r=16000:cl=mono" -t 3 silence.wav
```

Keep generated `.wav` files in this directory. They are checked into git so
integration tests are reproducible.
