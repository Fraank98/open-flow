#pragma once

// Pure modifier recogniser, shared by the NSEvent monitor and native tests.
// Caps Lock and device-side bits are deliberately ignored.
class PttGesture {
public:
  enum class Event { None, Down, Up, Chord };
  static constexpr unsigned Modifiers = (1u << 17) | (1u << 18) | (1u << 19) | (1u << 20);
  explicit PttGesture(unsigned mask = 1u << 19, unsigned initialFlags = 0)
      : mask_(mask), held_((initialFlags & mask) == mask), blocked_((initialFlags & mask) != 0) {}
  bool held() const { return held_; }
  bool liveHeld(unsigned flags) const { return (flags & mask_) == mask_; }

  Event flags(unsigned flags) {
    const bool wasHeld = held_;
    held_ = liveHeld(flags);
    if (!held_) {
      if ((flags & mask_) == 0) blocked_ = false;
      if (active_) { active_ = false; return Event::Up; }
      return Event::None;
    }
    if ((flags & Modifiers) != mask_) {
      const bool cancel = active_ && !blocked_;
      blocked_ = true;
      return cancel ? Event::Chord : Event::None;
    }
    if (!wasHeld && !blocked_) { active_ = true; return Event::Down; }
    return Event::None;
  }

  Event keyDown(bool repeat) {
    if (!active_ || blocked_ || repeat) return Event::None;
    blocked_ = true;
    return Event::Chord;
  }
private:
  unsigned mask_;
  bool held_ = false;
  bool blocked_ = false;
  bool active_ = false;
};
