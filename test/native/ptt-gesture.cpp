#include "../../native/ptt-monitor/ptt-gesture.h"
#include <cassert>
using E = PttGesture::Event;
int main() {
  const unsigned option = 1u << 19, control = 1u << 18, command = 1u << 20, shift = 1u << 17;
  PttGesture g(control | command, 0);
  assert(g.flags(control) == E::None);
  assert(g.flags(control | command) == E::Down);
  assert(g.flags(control | command) == E::None);
  assert(g.flags(command) == E::Up);
  assert(g.flags(0) == E::None);
  // An unrelated modifier must not trigger the chosen gesture.
  assert(g.flags(option) == E::None);
  assert(g.flags(0) == E::None);
  // Typing a shortcut cancels once; removing the extra key cannot re-arm.
  assert(g.flags(control | command) == E::Down);
  assert(g.keyDown(false) == E::Chord);
  assert(g.keyDown(false) == E::None);
  assert(g.flags(control | command) == E::None);
  assert(g.flags(0) == E::Up);
  assert(g.flags(control | command) == E::Down);
  assert(g.flags(control | command | shift) == E::Chord);
  assert(g.flags(control | command) == E::None);
  assert(g.flags(0) == E::Up);
  // Starting with an extra modifier must never record when it is released.
  PttGesture h(option, 0);
  assert(h.flags(option | command) == E::None);
  assert(h.flags(option) == E::None);
  assert(h.flags(0) == E::None);
  assert(h.flags(option) == E::Down);
  assert(h.keyDown(true) == E::None);
  assert(h.flags(0) == E::Up);
  // A key held while the monitor starts is ignored until a fresh press.
  PttGesture boot(option, option);
  assert(boot.flags(option) == E::None);
  assert(boot.flags(0) == E::None);
  assert(boot.flags(option) == E::Down);
  return 0;
}
