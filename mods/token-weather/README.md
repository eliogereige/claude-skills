# token-weather

A weather forecast of your Claude plan usage, drawn above the prompt.

## What it shows

The 5-hour and weekly usage windows as weather: clear, sunny, cloudy, showers or storm. Each window has a gauge, a sparkline of recent turns, and the time until it resets. It also warns when you are ahead of pace for the week. The terminal shows a coloured line; the desktop app shows animated weather cards. `/weather` hides or shows the band.

A mod is a Claude Code plugin with a hooks module that draws its own UI. It needs a Claude Code version where mods load by default (2.1.287 or later).

## Install

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install token-weather@claude-skills
```

Part of [claude-skills](https://github.com/eliogereige/claude-skills). MIT license.
