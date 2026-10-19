# Circular LILO enclosure assembly

This guide describes the current mechanical design, not a validated manufactured kit. Consult the [component references](COMPONENTS.md) before purchasing. Other Linux computers can run the daemon; different boards need corresponding CAD mounting geometry.

## Bill of materials

| Item | Selection | Quantity |
| --- | --- | --- |
| Computer | Raspberry Pi 4 Model B, 85 × 56 mm, mounting pattern 58 × 49 mm. The enclosure uses this board geometry; minimum RAM has not been established. | 1 |
| Display | Waveshare ESP32-S3-Touch-AMOLED-1.75, circular AMOLED with its own controller. | 1 |
| Audio | ReSpeaker Lite with USB sound-card firmware and physical microphone mute button. | 1 |
| Speaker | Seeed enclosed mono speaker, 4 Ω, 5 W, 50 × 45 × 22 mm. | 1 |
| Front button | Adafruit #481 momentary switch, 16 mm mounting diameter. | 1 |
| Supply | Manufacturer-rated Pi supply, normally 5 V / 3 A. | 1 |
| Storage and cooling | Supported boot storage and board-compatible heatsink; verify sustained voice temperatures. | 1 set |
| Cables | Short right-angle USB leads for the AMOLED controller and audio board, speaker connection and GPIO switch leads. Check connector bodies and bend radii. | As needed |
| Fasteners | Suitable M2.5 board fasteners, switch/connector nuts, protective display padding and rubber contact pads. | As needed |
| Filament | PETG is a candidate for flexible clips; use a material rated for the measured enclosure temperature. Check the slicer estimate and allow material for fit coupons. | Per slicer |
| Printed parts | Eight designs in kit.mjs; four copies of the display clamp. | 11 pieces |

The covers close with snap joints; electronics retain their appropriate nuts and board fasteners. The rear opening exposes the Pi's native USB-C power socket. Connect power directly to the native socket. The Pi 4 aggregate USB peripheral budget is 1.2 A: measure the combined display/audio load and use a powered hub when necessary.

## Printing

The body is 144 mm across and 72 mm deep, with 3 mm walls and nominal 0.3 mm fit clearance. Allow enough bed area for brim; a 180 mm usable bed is a practical starting point. Print fit and snap coupons first. PETG is a candidate for flexible clips; PLA is useful for dimensional trials. Choose the final material for measured internal temperatures.

Print the shell/rear in a light filament, front in charcoal and bezel in an accent color; each is a separate part, so a multicolor printer is not required.

Start with 0.2 mm layers, four perimeters and 20–30% infill, then inspect slicer overhangs and supports, especially below the internal carrier rails. Print the shell axially, covers exterior-down, and carriers and clamps flat. Avoid damaging clip catches during support removal.

With OpenSCAD on the design workstation, run from the repository root:

```sh
node scripts/export-device-stl.mjs
```

Output goes to .tmp/lilo-device-stl/. Set LILO_OPENSCAD if required. The daemon does not need OpenSCAD or this preview.

## Assembly

1. Deburr and dry-fit printed joints. Check rear release windows before installing electronics; use a plastic tool to release clips.
2. Seat the display behind the front panel with protective padding. Attach four retaining clamps without loading the glass or trapping connectors.
3. Fit the front momentary switch and its supplied nut. Route its leads clear of the display and speaker, then check the bezel press fit.
4. Fit the speaker into its cradle and attach it to the front retaining posts. Check the acoustic path to the lower front slots.
5. Secure the Pi to the tray with suitable M2.5 fasteners. Check screw length and PCB clearance, then slide the carrier into the shell rails.
6. Fit the ReSpeaker into its cradle on the rear cover. Align microphone openings, mute flexure and indicator with the actual board revision. Check the 0.6 mm travel stop and free return before closing the cover.
7. Connect short USB leads to the display controller and audio board. Route them clear of clips, airflow and the Pi socket. The display USB-C port points sideways; provide bend clearance.
8. Check clearances before snapping on the rear cover. The native power input and rear mute control must remain accessible. Add rubber pads and verify stability.
9. Follow the Linux installation guide, test microphone, playback, mute and power behavior, then measure sustained voice memory, temperature and supply voltage. Inspect for hot spots and stressed wiring before unattended use.

## Controls

The front button is a momentary GPIO control, not a mains disconnect. A supported Raspberry Pi OS configuration can connect it between physical pins 5 (GPIO3) and 6 (ground) using the operating system's gpio-shutdown overlay. Follow the official overlay documentation for the installed image. The generic LILO installer does not enable this board-specific configuration. Verify shutdown and wake on physical hardware.

The rear MIC flexure presses the ReSpeaker's existing firmware-controlled button. Its printed stop tabs limit travel to 0.6 mm; check that the unpressed cover leaves the switch released. It is not a guaranteed electrical microphone disconnect. Confirm the installed USB firmware and indicator behavior.

The static desktop companion face in the preview is separate from a physical display renderer. Renderings do not prove a running display application.

## AMOLED bring-up

Check the display with the manufacturer examples before developing the LILO firmware. This module is controlled by its ESP32, not the Linux video output. The firmware/link and onboard microphone reuse are described in [component integration](COMPONENTS.md#display-and-microphone-integration); they are not part of the generic daemon installer.
