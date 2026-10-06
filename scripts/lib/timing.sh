# Shared timing helpers for the scripts/ wrappers. Source it, then:
#   timer_start                 — marks the start (call once, early)
#   timer_report "Archive"      — prints "⏱ Archive finished in 4s (at 14:02:11)"
#   fmt_duration <seconds>      — 75 -> "1m 15s", 4 -> "4s"
# timer_report also runs on failure if you register it with
# `trap 'timer_report "Deploy" $?' EXIT`, and then says "failed after".

fmt_duration() {
  local s=$1
  if [ "$s" -ge 60 ]; then
    printf '%dm %02ds' $((s / 60)) $((s % 60))
  else
    printf '%ds' "$s"
  fi
}

timer_start() {
  _TIMER_START=$(date +%s)
}

timer_elapsed() {
  echo $(( $(date +%s) - ${_TIMER_START:-$(date +%s)} ))
}

timer_report() {
  local name=$1 status=${2:-0}
  local verb="finished in"
  [ "$status" -ne 0 ] && verb="FAILED after"
  echo "⏱ ${name} ${verb} $(fmt_duration "$(timer_elapsed)") (at $(date +%H:%M:%S))"
}
