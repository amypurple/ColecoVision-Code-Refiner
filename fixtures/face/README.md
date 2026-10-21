# Face CVBasic fixture

Oscar Toledo's CVBasic joystick/sprite demonstration, compiled with CVBasic
0.9.0 on October 20, 2026. It exercises text, decimal VDP-status output,
controller directions, both fire buttons, sprite pattern upload and SAT updates.

The original occupied ROM is 1,608 bytes. The conservative compact lane removes
only unreachable closed CVBasic runtime groups and occupies 1,207 bytes. The
runtime proof drives every direction and both buttons; framebuffer, VRAM and VDP
registers remain identical. RAM differences are relocated stack return bytes.
