# Future Ideas

## Formation Drag Preview (UI Feature)
Right-click drag to set formation facing direction at destination.
Company of Heroes / Total War style.

Components needed:
1. GUI input: detect right-click drag (mouse down → drag → mouse up)
2. Visual overlay: draw arrow + formation ghost on ground during drag
3. Command system: pass desired facing angle with move command
4. UnitAI/Formation: rotate to face that direction on arrival

Files: gui/session/ (input), renderer/ (overlay), simulation/helpers/Commands.js,
UnitAI.js, Formation.js

## Other Ideas
- Variable terrain costs in flow fields (mud slower, roads faster)
- Threat-aware flow fields (avoid enemy towers)
- Async flow field generation between turns via TaskManager
- ORCA parallelization
